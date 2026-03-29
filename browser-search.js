import { chromium } from "playwright";

// ── Config ────────────────────────────────────────────────────────────
const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 25000);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 15000);
const MAX_PRODUCT_VISITS = Number(process.env.MAX_PRODUCT_VISITS || 3);
const IDLE_BROWSER_MS = Number(process.env.IDLE_BROWSER_MS || 10 * 60 * 1000);
const BRAVE_API_KEY = String(process.env.BRAVE_API_KEY || "").trim();
const BRAVE_API_BASE = String(process.env.BRAVE_API_BASE || "https://api.search.brave.com/res/v1/web/search").trim();
const BRAVE_RESULTS_COUNT = Math.max(1, Math.min(Number(process.env.BRAVE_RESULTS_COUNT || 8), 20));
const BRAVE_COUNTRY = String(process.env.BRAVE_COUNTRY || "BG").trim();
const BRAVE_SEARCH_LANG = String(process.env.BRAVE_SEARCH_LANG || "bg").trim();

// ── Browser singleton ─────────────────────────────────────────────────
let browserPromise = null;
let contextPromise = null;
let idleTimer = null;

// ── Helpers ───────────────────────────────────────────────────────────
function safeDomain(siteUrl) {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function norm(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function buildExcerpt(text, max = 1500) {
  return norm(text).slice(0, max);
}

function unique(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))];
}

function extractPriceMatches(text) {
  const src = norm(text);
  if (!src) return [];
  const re = /\b\d{1,6}(?:[.,]\d{1,2})?\s?(?:лв\.?|lv|eur|€|USD|\$|TL|₺)\b/gi;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(m[0]);
    if (out.length >= 10) break;
  }
  return unique(out);
}

function toKeywords(query) {
  return query
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .filter((w) => w.length > 1)
    .filter(
      (w) =>
        ![
          "на",
          "за",
          "от",
          "и",
          "в",
          "с",
          "да",
          "не",
          "по",
          "се",
          "ли",
          "е",
          "the",
          "a",
          "an",
          "is",
          "of",
          "for",
        ].includes(w)
    );
}

function keywordScore(text, keywords) {
  const lower = String(text || "").toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return hits;
}

function boostScoreForDomain(url, domain) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    if (host === domain) return 100;
    if (host.endsWith(`.${domain}`)) return 80;
    return 0;
  } catch {
    return 0;
  }
}

function buildBraveQuery(domain, query) {
  return `site:${domain} ${query}`.trim();
}

// ── Browser lifecycle ─────────────────────────────────────────────────
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser().catch(() => {}), IDLE_BROWSER_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function getContext() {
  if (!contextPromise) {
    const browser = await getBrowser();
    contextPromise = browser
      .newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 900 },
        locale: "bg-BG",
      })
      .catch((err) => {
        contextPromise = null;
        throw err;
      });
  }
  resetIdleTimer();
  return contextPromise;
}

export async function closeBrowser() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (contextPromise) {
    const ctx = await contextPromise.catch(() => null);
    contextPromise = null;
    if (ctx) await ctx.close().catch(() => {});
  }
  if (browserPromise) {
    const br = await browserPromise.catch(() => null);
    browserPromise = null;
    if (br) await br.close().catch(() => {});
  }
}

async function dismissOverlays(page) {
  const btns = [
    'button:has-text("Приемам")',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Съгласен")',
    'button:has-text("Разбирам")',
    "#L2AGLb",
    'button[aria-label*="Accept"]',
    'button:has-text("OK")',
    'button:has-text("Добре")',
    'button:has-text("Got it")',
  ];

  for (const sel of btns) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 }).catch(() => false)) {
        await el.click({ timeout: 1000 }).catch(() => {});
        return;
      }
    } catch {}
  }
}

// ── Extract page data ─────────────────────────────────────────────────
async function inspectPage(context, url, logger) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await dismissOverlays(page);

    const d = await page.evaluate(() => {
      const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
      return {
        title: document.title || "",
        h1: document.querySelector("h1")?.textContent?.trim() || "",
        body: document.body?.innerText || "",
        ogTitle: meta('meta[property="og:title"]'),
        description: meta('meta[name="description"]'),
        url: location.href,
      };
    });

    const body = buildExcerpt(d.body);
    const prices = extractPriceMatches(d.body);

    return {
      url: d.url || url,
      title: d.h1 || d.ogTitle || d.title || url,
      excerpts: unique([body, d.description].filter(Boolean)).slice(0, 2),
      price: prices[0] || null,
      price_candidates: prices,
      on_domain: true,
      source: "brave_live_page",
    };
  } catch (err) {
    logger?.warn?.({ url, error: err?.message }, "[inspect] page failed");
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Brave API search ──────────────────────────────────────────────────
async function braveSearch({ context, domain, query, logger }) {
  const started = Date.now();

  if (!BRAVE_API_KEY) {
    return {
      ok: false,
      results: [],
      reason: "missing_brave_api_key",
      elapsed_ms: Date.now() - started,
      strategy: "brave",
      brave_query: null,
    };
  }

  const braveQuery = buildBraveQuery(domain, query);
  const searchUrl = new URL(BRAVE_API_BASE);
  searchUrl.searchParams.set("q", braveQuery);
  searchUrl.searchParams.set("count", String(BRAVE_RESULTS_COUNT));
  searchUrl.searchParams.set("country", BRAVE_COUNTRY);
  searchUrl.searchParams.set("search_lang", BRAVE_SEARCH_LANG);
  searchUrl.searchParams.set("safesearch", "off");
  searchUrl.searchParams.set("spellcheck", "true");
  searchUrl.searchParams.set("result_filter", "web");

  try {
    logger?.info?.({ braveQuery, url: searchUrl.toString() }, "[brave] searching");

    const resp = await fetch(searchUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        results: [],
        reason: `brave_http_${resp.status}${text ? `:${text.slice(0, 180)}` : ""}`,
        elapsed_ms: Date.now() - started,
        strategy: "brave",
        brave_query: braveQuery,
      };
    }

    const json = await resp.json();
    const rawResults = Array.isArray(json?.web?.results) ? json.web.results : [];

    const ranked = rawResults
      .map((item) => {
        const url = item?.url || item?.profile?.url || "";
        const title = item?.title || "";
        const description = item?.description || item?.snippet || "";
        return {
          url,
          title,
          description,
          score:
            boostScoreForDomain(url, domain) +
            keywordScore(`${title} ${description} ${url}`, toKeywords(query)),
        };
      })
      .filter((item) => item.url && item.title)
      .sort((a, b) => b.score - a.score);

    logger?.info?.({ count: ranked.length, top: ranked.slice(0, 5) }, "[brave] results ranked");

    const output = [];
    for (const item of ranked) {
      if (output.length >= MAX_PRODUCT_VISITS) break;

      const livePage = await inspectPage(context, item.url, logger);
      if (livePage) {
        livePage.title = livePage.title || item.title;
        livePage.excerpts = unique([
          ...(livePage.excerpts || []),
          buildExcerpt(item.description, 400),
        ]).slice(0, 3);
        livePage.source = "brave_live_page";
        output.push(livePage);
        continue;
      }

      output.push({
        url: item.url,
        title: item.title,
        excerpts: [buildExcerpt(item.description, 600)].filter(Boolean),
        price: extractPriceMatches(item.description)[0] || null,
        price_candidates: extractPriceMatches(item.description),
        on_domain: boostScoreForDomain(item.url, domain) > 0,
        source: "brave_snippet",
      });
    }

    return {
      ok: output.length > 0,
      results: output,
      reason: output.length > 0 ? null : "brave_no_results",
      elapsed_ms: Date.now() - started,
      strategy: "brave",
      brave_query: braveQuery,
    };
  } catch (err) {
    logger?.warn?.({ error: err?.message }, "[brave] search failed");
    return {
      ok: false,
      results: [],
      reason: err?.message || "brave_error",
      elapsed_ms: Date.now() - started,
      strategy: "brave",
      brave_query: braveQuery,
    };
  }
}

// ── Main entry ────────────────────────────────────────────────────────
export async function browserSearch({ siteUrl, query, logger }) {
  const started = Date.now();
  const domain = safeDomain(siteUrl);

  if (!domain) {
    return {
      ok: false,
      results: [],
      reason: "invalid_site_url",
      elapsed_ms: Date.now() - started,
      strategy: "none",
      engine_sequence: [],
      failures: [],
    };
  }

  const context = await getContext();
  const failures = [];

  logger?.info?.({ domain, query }, "[search] → Strategy: Brave API");

  const braveResult = await braveSearch({ context, domain, query, logger });

  if (braveResult.ok && braveResult.results.length > 0) {
    logger?.info?.(
      { strategy: "brave", count: braveResult.results.length, ms: Date.now() - started },
      "[search] ✓ Brave returned results"
    );

    return {
      ...braveResult,
      elapsed_ms: Date.now() - started,
      engine_sequence: [{ engine: "brave", searchQuery: braveResult.brave_query || buildBraveQuery(domain, query) }],
      failures,
    };
  }

  failures.push({
    engine: "brave",
    searchQuery: braveResult.brave_query || buildBraveQuery(domain, query),
    reason: braveResult.reason || "no_results",
  });

  logger?.warn?.({ domain, query, ms: Date.now() - started }, "[search] ✗ Brave returned no usable results");

  return {
    ok: false,
    results: [],
    confidence: 0,
    reason: failures.at(-1)?.reason || "no_results",
    elapsed_ms: Date.now() - started,
    strategy: "none",
    engine_sequence: [{ engine: "brave", searchQuery: braveResult.brave_query || buildBraveQuery(domain, query) }],
    failures,
  };
}

export async function browserSearchWithRetry(opts) {
  return browserSearch(opts);
}
