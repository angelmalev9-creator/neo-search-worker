import { chromium } from "playwright";

// ── Config ────────────────────────────────────────────────────────────
const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 25000);
const PAGE_TIMEOUT_MS    = Number(process.env.PAGE_TIMEOUT_MS    || 15000);
const MAX_PRODUCT_VISITS = Number(process.env.MAX_PRODUCT_VISITS || 3);
const IDLE_BROWSER_MS    = Number(process.env.IDLE_BROWSER_MS    || 10 * 60 * 1000);

// ── Browser singleton ─────────────────────────────────────────────────
let browserPromise = null;
let contextPromise = null;
let idleTimer      = null;

// ── Helpers ───────────────────────────────────────────────────────────

function safeDomain(siteUrl) {
  try { return new URL(siteUrl).hostname.replace(/^www\./i, ""); }
  catch { return ""; }
}

function norm(v) { return String(v || "").replace(/\s+/g, " ").trim(); }

function buildExcerpt(text, max = 1500) { return norm(text).slice(0, max); }

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

function sameDomain(url, domain) {
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "");
    return h === domain || h.endsWith(`.${domain}`);
  } catch { return false; }
}

/** Split query into meaningful keyword tokens */
function toKeywords(query) {
  return query
    .toLowerCase()
    .split(/[\s,;.!?]+/)
    .filter(w => w.length > 1)
    .filter(w => ![
      "на", "за", "от", "и", "в", "с", "да", "не", "по", "се",
      "ли", "е", "the", "a", "an", "is", "of", "for",
    ].includes(w));
}

/** Score a URL/title by how many query keywords it contains */
function keywordScore(text, keywords) {
  const lower = (text || "").toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return hits;
}

// ── Browser lifecycle ─────────────────────────────────────────────────

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => closeBrowser().catch(() => {}), IDLE_BROWSER_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

async function getContext() {
  if (!contextPromise) {
    const browser = await getBrowser();
    contextPromise = browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "bg-BG",
    }).catch(err => { contextPromise = null; throw err; });
  }
  resetIdleTimer();
  return contextPromise;
}

export async function closeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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

// ── Accept cookie / consent banners ───────────────────────────────────

async function dismissOverlays(page) {
  const btns = [
    'button:has-text("Приемам")',  'button:has-text("Accept")',
    'button:has-text("I agree")',   'button:has-text("Съгласен")',
    'button:has-text("Разбирам")', '#L2AGLb',
    'button[aria-label*="Accept"]', 'button:has-text("OK")',
    'button:has-text("Добре")',     'button:has-text("Got it")',
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

// ── Extract page data (product page) ──────────────────────────────────

/** Visit a URL, extract product-like data */
async function inspectPage(context, url, logger) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await dismissOverlays(page);

    const d = await page.evaluate(() => {
      const meta = (sel) =>
        document.querySelector(sel)?.getAttribute("content")?.trim() || "";
      return {
        title:       document.title || "",
        h1:          document.querySelector("h1")?.textContent?.trim() || "",
        body:        document.body?.innerText || "",
        ogTitle:     meta('meta[property="og:title"]'),
        description: meta('meta[name="description"]'),
        url:         location.href,
      };
    });

    const body   = buildExcerpt(d.body);
    const prices = extractPriceMatches(d.body);

    return {
      url:              d.url || url,
      title:            d.h1 || d.ogTitle || d.title || url,
      excerpts:         body ? [body] : [],
      price:            prices[0] || null,
      price_candidates: prices,
      on_domain:        true,
      source:           "live_search",
    };
  } catch (err) {
    logger?.warn?.({ url, error: err?.message }, "[inspect] page failed");
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  STRATEGY 1 — Google (address bar style)
//
//  Пише в адрес бара: praktiker.bg пътечка 50x100 цена
//  Намира линкове от домейна → кликва → извлича
//  Също хваща Google AI snippet ако има
// ═══════════════════════════════════════════════════════════════════════

async function googleSearch({ context, domain, query, logger }) {
  const started = Date.now();

  // Address bar style — domain + keywords, NO site: operator
  const searchText = `${domain} ${query}`;
  const googleUrl  = `https://www.google.com/search?q=${encodeURIComponent(searchText)}&hl=bg&num=10&gbv=1`;

  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    logger?.info?.({ searchText, googleUrl }, "[google] opening");

    await page.goto(googleUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });
    await dismissOverlays(page);
    await page.waitForTimeout(800);

    // ── Extract domain links from Google results ────────────────────
    const links = await page.evaluate(({ targetDomain }) => {
      const normHost = (h) => String(h || "").replace(/^www\./i, "");
      const isDomain = (href) => {
        try {
          const host = normHost(new URL(href).hostname);
          return host === targetDomain || host.endsWith("." + targetDomain);
        } catch { return false; }
      };
      const unwrap = (href) => {
        try {
          if (href?.startsWith("/url?")) {
            return new URL("https://www.google.com" + href).searchParams.get("q") || "";
          }
          const u = new URL(href);
          if (u.pathname === "/url" && u.searchParams.has("q"))
            return u.searchParams.get("q");
          return u.href;
        } catch { return href || ""; }
      };

      const selectors = [
        "div.yuRUbf a[href]",
        "a:has(h3)",
        "#search a[href]",
      ];

      const found = new Set();
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const raw = unwrap(el.getAttribute("href") || el.href || "");
          if (raw && raw.startsWith("http") && isDomain(raw)) {
            found.add(raw);
            if (found.size >= 8) break;
          }
        }
        if (found.size >= 8) break;
      }
      return [...found];
    }, { targetDomain: domain });

    logger?.info?.(
      { linksFound: links.length, links: links.slice(0, 5) },
      "[google] extracted links"
    );

    // ── If no links, try grabbing Google AI / featured snippet ───────
    if (!links.length) {
      const snippet = await page.evaluate(() => {
        const sels = [
          ".hgKElc", "[data-attrid] span",
          ".IZ6rdc", ".xpdopen .LGOjhe",
        ];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return "";
      }).catch(() => "");

      if (snippet) {
        logger?.info?.({ snippetLen: snippet.length }, "[google] got AI/featured snippet");
        return {
          ok: true,
          results: [{
            url: googleUrl,
            title: `Google snippet: ${query}`,
            excerpts: [buildExcerpt(snippet)],
            price: extractPriceMatches(snippet)[0] || null,
            price_candidates: extractPriceMatches(snippet),
            on_domain: false,
            source: "google_snippet",
          }],
          reason: null,
          elapsed_ms: Date.now() - started,
          strategy: "google",
        };
      }

      return {
        ok: false, results: [],
        reason: "no_domain_links_on_google",
        elapsed_ms: Date.now() - started,
        strategy: "google",
      };
    }

    // ── Rank links by keyword match, visit top ones ──────────────────
    const keywords = toKeywords(query);
    const ranked = links
      .map(url => ({ url, score: keywordScore(url, keywords) }))
      .sort((a, b) => b.score - a.score);

    const results = [];
    for (const { url } of ranked) {
      if (results.length >= MAX_PRODUCT_VISITS) break;
      const data = await inspectPage(context, url, logger);
      if (data) results.push(data);
    }

    return {
      ok: results.length > 0,
      results,
      reason: results.length > 0 ? null : "pages_not_extractable",
      elapsed_ms: Date.now() - started,
      strategy: "google",
    };

  } catch (err) {
    logger?.warn?.({ error: err?.message }, "[google] search failed");
    return {
      ok: false, results: [],
      reason: err?.message || "google_error",
      elapsed_ms: Date.now() - started,
      strategy: "google",
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  STRATEGY 2 — Site internal search (fallback)
//
//  Отваря сайта и търси вътрешно:
//  1. Пробва common search URL patterns
//  2. Ако не стане — отваря homepage, намира search input, пише, enter
// ═══════════════════════════════════════════════════════════════════════

async function siteInternalSearch({ context, siteUrl, domain, query, logger }) {
  const started = Date.now();
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  const baseUrl = siteUrl.replace(/\/+$/, "");

  try {
    // ── Try common search URL patterns ──────────────────────────────
    const searchPaths = [
      `/catalogsearch/result/?q=${encodeURIComponent(query)}`,
      `/search?q=${encodeURIComponent(query)}`,
      `/search/?q=${encodeURIComponent(query)}`,
      `/search?search=${encodeURIComponent(query)}`,
      `/търсене?q=${encodeURIComponent(query)}`,
      `/?s=${encodeURIComponent(query)}`,
    ];

    for (const path of searchPaths) {
      const tryUrl = `${baseUrl}${path}`;
      logger?.info?.({ tryUrl }, "[site-search] trying URL pattern");

      try {
        const resp = await page.goto(tryUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        });

        if (!resp || resp.status() >= 400) continue;
        await dismissOverlays(page);
        await page.waitForTimeout(1000);

        const productLinks = await extractProductLinks(page, domain);

        if (productLinks.length > 0) {
          logger?.info?.(
            { path, linksFound: productLinks.length },
            "[site-search] found product links"
          );

          const results = await visitTopLinks(context, productLinks, query, logger, "site_internal_search");
          if (results.length > 0) {
            return {
              ok: true, results, reason: null,
              elapsed_ms: Date.now() - started,
              strategy: "site_search",
            };
          }
        }
      } catch {
        continue;
      }
    }

    // ── Fallback: homepage → find search input → type → enter ────────
    logger?.info?.("[site-search] trying homepage search input");

    try {
      await page.goto(baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      await dismissOverlays(page);

      const inputSelectors = [
        'input[name="q"]', 'input[name="search"]', 'input[name="s"]',
        'input[type="search"]', 'input[placeholder*="Търсене"]',
        'input[placeholder*="Search"]', 'input[placeholder*="търси"]',
        '#search', '.search-input', 'input.search',
      ];

      for (const sel of inputSelectors) {
        try {
          const input = page.locator(sel).first();
          if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
            await input.click();
            await input.fill(query);
            await page.keyboard.press("Enter");
            await page.waitForLoadState("domcontentloaded", { timeout: PAGE_TIMEOUT_MS });
            await page.waitForTimeout(1500);

            logger?.info?.({ url: page.url() }, "[site-search] submitted search form");

            const productLinks = await extractProductLinks(page, domain);
            if (productLinks.length > 0) {
              const results = await visitTopLinks(context, productLinks, query, logger, "site_search_form");
              if (results.length > 0) {
                return {
                  ok: true, results, reason: null,
                  elapsed_ms: Date.now() - started,
                  strategy: "site_search_form",
                };
              }
            }
            break;
          }
        } catch {}
      }
    } catch (err) {
      logger?.debug?.({ error: err?.message }, "[site-search] homepage fallback failed");
    }

    return {
      ok: false, results: [],
      reason: "site_search_no_results",
      elapsed_ms: Date.now() - started,
      strategy: "site_search",
    };

  } catch (err) {
    logger?.warn?.({ error: err?.message }, "[site-search] failed");
    return {
      ok: false, results: [],
      reason: err?.message || "site_search_error",
      elapsed_ms: Date.now() - started,
      strategy: "site_search",
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Extract product-like links from a search results page */
async function extractProductLinks(page, domain) {
  return page.evaluate(({ targetDomain }) => {
    const normHost = (h) => String(h || "").replace(/^www\./i, "");
    const isDomain = (href) => {
      try {
        const host = normHost(new URL(href, location.href).hostname);
        return host === targetDomain || host.endsWith("." + targetDomain);
      } catch { return false; }
    };

    const selectors = [
      "a.product-item-link",
      ".product-name a", ".product-title a", ".product a[href]",
      "h2 a[href]", "h3 a[href]",
      ".search-result a[href]", ".results a[href]",
      "a[href*='/product']", "a[href*='/p/']", "a[href*='/catalog/']",
      "article a[href]",
    ];

    const found = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const href = el.href || el.getAttribute("href") || "";
        try {
          const full = new URL(href, location.href).href;
          if (full.startsWith("http") && isDomain(full)) {
            found.add(full);
            if (found.size >= 8) break;
          }
        } catch {}
      }
      if (found.size >= 8) break;
    }

    // Last resort — any non-utility link on domain
    if (found.size === 0) {
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.href || "";
        if (href.startsWith("http") && isDomain(href) &&
            !href.match(/\/(cart|login|register|account|checkout)/i)) {
          found.add(href);
          if (found.size >= 8) break;
        }
      }
    }

    return [...found];
  }, { targetDomain: domain });
}

/** Rank links by keyword relevance and visit the top ones */
async function visitTopLinks(context, links, query, logger, source) {
  const keywords = toKeywords(query);
  const ranked = links
    .map(url => ({ url, score: keywordScore(url, keywords) }))
    .sort((a, b) => b.score - a.score);

  const results = [];
  for (const { url } of ranked) {
    if (results.length >= MAX_PRODUCT_VISITS) break;
    const data = await inspectPage(context, url, logger);
    if (data) {
      data.source = source;
      results.push(data);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN ENTRY — Google first, site search fallback
// ═══════════════════════════════════════════════════════════════════════

export async function browserSearch({ siteUrl, query, logger }) {
  const started = Date.now();
  const domain  = safeDomain(siteUrl);

  if (!domain) {
    return {
      ok: false, results: [], reason: "invalid_site_url",
      elapsed_ms: Date.now() - started,
      strategy: "none", engine_sequence: [], failures: [],
    };
  }

  const context  = await getContext();
  const failures = [];

  // ── 1. Google address-bar style ────────────────────────────────────
  logger?.info?.({ domain, query }, "[search] → Strategy 1: Google");

  const googleResult = await googleSearch({ context, domain, query, logger });

  if (googleResult.ok && googleResult.results.length > 0) {
    logger?.info?.(
      { strategy: "google", count: googleResult.results.length, ms: Date.now() - started },
      "[search] ✓ Google returned results"
    );
    return {
      ...googleResult,
      elapsed_ms: Date.now() - started,
      engine_sequence: [{ engine: "google", searchQuery: `${domain} ${query}` }],
      failures,
    };
  }

  failures.push({
    engine: "google",
    searchQuery: `${domain} ${query}`,
    reason: googleResult.reason || "no_results",
  });

  // ── 2. Site internal search fallback ───────────────────────────────
  logger?.info?.({ domain, query }, "[search] → Strategy 2: Site internal search");

  const siteResult = await siteInternalSearch({ context, siteUrl, domain, query, logger });

  if (siteResult.ok && siteResult.results.length > 0) {
    logger?.info?.(
      { strategy: siteResult.strategy, count: siteResult.results.length, ms: Date.now() - started },
      "[search] ✓ Site search returned results"
    );
    return {
      ...siteResult,
      elapsed_ms: Date.now() - started,
      engine_sequence: [
        { engine: "google", searchQuery: `${domain} ${query}` },
        { engine: "site_search", searchQuery: query },
      ],
      failures,
    };
  }

  failures.push({
    engine: "site_search",
    searchQuery: query,
    reason: siteResult.reason || "no_results",
  });

  // ── Nothing found ─────────────────────────────────────────────────
  logger?.warn?.(
    { domain, query, ms: Date.now() - started },
    "[search] ✗ All strategies exhausted"
  );

  return {
    ok: false, results: [], confidence: 0,
    reason: failures.at(-1)?.reason || "no_results",
    elapsed_ms: Date.now() - started,
    strategy: "none",
    engine_sequence: [
      { engine: "google", searchQuery: `${domain} ${query}` },
      { engine: "site_search", searchQuery: query },
    ],
    failures,
  };
}

export async function browserSearchWithRetry(opts) {
  return browserSearch(opts);
}
