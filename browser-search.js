import { chromium } from "playwright";

const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 25000);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 15000);
const MAX_RESULT_LINKS = Number(process.env.MAX_RESULT_LINKS || 8);
const MAX_PRODUCT_VISITS = Number(process.env.MAX_PRODUCT_VISITS || 3);
const IDLE_BROWSER_MS = Number(process.env.IDLE_BROWSER_MS || 10 * 60 * 1000);

let browserPromise = null;
let contextPromise = null;
let idleTimer = null;

function safeDomain(siteUrl) {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildExcerpt(text) {
  return normalizeWhitespace(text).slice(0, 1200);
}

function unique(arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))];
}

function maxLinksSafe(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(n, 12);
}

function extractPriceMatches(text) {
  const source = normalizeWhitespace(text);
  if (!source) return [];

  const regex =
    /\b\d{1,6}(?:[.,]\d{1,2})?\s?(?:лв\.?|lv|eur|€)\b/gi;

  const matches = [];
  let match;

  while ((match = regex.exec(source)) !== null) {
    matches.push(match[0]);
    if (matches.length >= 10) break;
  }

  return unique(matches);
}

function buildSearchQueries(domain, query) {
  return unique([
    `site:${domain} ${query}`,
    `${domain} ${query}`,
    `site:${domain} ${query.replace(/\bцена\b/gi, "").trim()}`,
  ].filter(Boolean));
}

function buildSearchUrl(engine, searchQuery) {
  if (engine === "google") {
    return `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&hl=bg&num=10&gbv=1`;
  }

  if (engine === "bing") {
    return `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}&setlang=bg-BG`;
  }

  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);

  idleTimer = setTimeout(() => {
    closeBrowser().catch(() => {});
  }, IDLE_BROWSER_MS);

  if (typeof idleTimer.unref === "function") {
    idleTimer.unref();
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }

  return browserPromise;
}

async function getContext() {
  if (!contextPromise) {
    const browser = await getBrowser();

    contextPromise = browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "bg-BG",
    }).catch((err) => {
      contextPromise = null;
      throw err;
    });
  }

  resetIdleTimer();
  return contextPromise;
}

function normalizeResultUrl(rawHref, engine) {
  if (!rawHref) return "";

  try {
    if (rawHref.startsWith("/url?")) {
      const url = new URL(`https://www.google.com${rawHref}`);
      return url.searchParams.get("q") || "";
    }

    const parsed = new URL(rawHref);

    if (engine === "google") {
      const q = parsed.searchParams.get("q");
      if (parsed.pathname === "/url" && q) return q;
    }

    if (engine === "duckduckgo") {
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }

    return parsed.href;
  } catch {
    return rawHref;
  }
}

function sameDomain(targetUrl, domain) {
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./i, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

async function acceptConsentIfPresent(page) {
  const buttons = [
    'button:has-text("Приемам")',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Съгласен")',
    'button:has-text("Разбирам")',
    '#L2AGLb',
    'button[aria-label*="Accept"]',
  ];

  for (const selector of buttons) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click({ timeout: 1000 }).catch(() => {});
        return;
      }
    } catch {}
  }
}

async function extractEngineLinks(page, domain, engine) {
  const candidates = await page.evaluate(
    ({ expectedDomain, currentEngine, maxLinks }) => {
      const normalizeHost = (host) =>
        String(host || "").replace(/^www\./i, "");

      const sameDomain = (href) => {
        try {
          const url = new URL(href, location.href);
          const host = normalizeHost(url.hostname);
          return host === expectedDomain || host.endsWith(`.${expectedDomain}`);
        } catch {
          return false;
        }
      };

      const normalizeHref = (href) => {
        try {
          if (!href) return "";

          if (href.startsWith("/url?")) {
            const url = new URL(`https://www.google.com${href}`);
            return url.searchParams.get("q") || "";
          }

          const parsed = new URL(href, location.href);

          if (currentEngine === "google") {
            const q = parsed.searchParams.get("q");
            if (parsed.pathname === "/url" && q) return q;
          }

          if (currentEngine === "duckduckgo") {
            const uddg = parsed.searchParams.get("uddg");
            if (uddg) return decodeURIComponent(uddg);
          }

          return parsed.href;
        } catch {
          return href || "";
        }
      };

      const selectorsByEngine = {
        google: [
          "a h3",
          "div.yuRUbf a",
          "#search a[href]",
          "a[href]"
        ],
        bing: [
          "li.b_algo h2 a",
          "#b_results h2 a",
          "#b_results a[href]",
          "a[href]"
        ],
        duckduckgo: [
          "a.result__a",
          ".result a[href]",
          "a[href]"
        ],
      };

      const selectors = selectorsByEngine[currentEngine] || ["a[href]"];
      const found = [];

      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector));

        for (const node of nodes) {
          const anchor = node.closest ? node.closest("a[href]") : node;
          const href = anchor?.getAttribute?.("href") || anchor?.href || "";
          const normalized = normalizeHref(href);

          if (!normalized) continue;
          if (!normalized.startsWith("http")) continue;
          if (!sameDomain(normalized)) continue;

          found.push(normalized);
          if (found.length >= maxLinks) break;
        }

        if (found.length >= maxLinks) break;
      }

      return [...new Set(found)].slice(0, maxLinks);
    },
    {
      expectedDomain: domain,
      currentEngine: engine,
      maxLinks: maxLinksSafe(MAX_RESULT_LINKS),
    }
  );

  return unique(
    candidates
      .map((href) => normalizeResultUrl(href, engine))
      .filter((href) => href && href.startsWith("http"))
      .filter((href) => sameDomain(href, domain))
  ).slice(0, maxLinksSafe(MAX_RESULT_LINKS));
}

async function clickFirstVisibleResult(page, domain, engine, logger) {
  const selectorsByEngine = {
    google: [
      "div.yuRUbf a",
      "a:has(h3)",
      "#search a[href]"
    ],
    bing: [
      "li.b_algo h2 a",
      "#b_results h2 a",
      "#b_results a[href]"
    ],
    duckduckgo: [
      "a.result__a",
      ".result a[href]"
    ],
  };

  const selectors = selectorsByEngine[engine] || ["a[href]"];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 10); i++) {
      try {
        const link = locator.nth(i);
        const href = await link.getAttribute("href").catch(() => "");
        const normalized = normalizeResultUrl(href || "", engine);

        if (!normalized) continue;
        if (!sameDomain(normalized, domain)) continue;

        logger?.info?.(
          { engine, selector, target: normalized },
          "[browser-search] click first visible result"
        );

        await page.goto(normalized, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        });

        return normalized;
      } catch {}
    }
  }

  return null;
}

async function inspectResultPage(context, url, logger) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    const data = await page.evaluate(() => {
      const getMeta = (selector) =>
        document.querySelector(selector)?.getAttribute("content")?.trim() || "";

      const title = document.title || "";
      const h1 = document.querySelector("h1")?.textContent?.trim() || "";
      const bodyText = document.body?.innerText || "";

      return {
        title,
        h1,
        bodyText,
        ogTitle: getMeta('meta[property="og:title"]'),
        description: getMeta('meta[name="description"]'),
      };
    });

    const excerptSource =
      data.bodyText || data.description || data.h1 || data.title || "";

    const excerpt = buildExcerpt(excerptSource);
    const prices = extractPriceMatches(data.bodyText);

    return {
      url,
      title: data.h1 || data.ogTitle || data.title || url,
      excerpts: excerpt ? [excerpt] : [],
      price: prices[0] || null,
      price_candidates: prices,
      on_domain: true,
      source: "search_engine_live",
    };
  } catch (err) {
    logger?.warn?.(
      {
        url,
        error: err instanceof Error ? err.message : String(err),
      },
      "[browser-search] failed to inspect result page"
    );

    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runEngineSearch({ context, engine, domain, searchQuery, logger }) {
  const startedAt = Date.now();
  const searchUrl = buildSearchUrl(engine, searchQuery);

  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    logger?.info?.(
      { engine, searchUrl, domain, searchQuery },
      "[browser-search] engine search start"
    );

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });

    await acceptConsentIfPresent(page);

    let links = await extractEngineLinks(page, domain, engine);

    if (!links.length) {
      const clickedUrl = await clickFirstVisibleResult(page, domain, engine, logger);
      if (clickedUrl) {
        links = [clickedUrl];
      }
    }

    if (!links.length) {
      return {
        ok: false,
        results: [],
        reason: `no_links_found_on_${engine}`,
        elapsed_ms: Date.now() - startedAt,
      };
    }

    const results = [];

    for (const link of links) {
      if (results.length >= MAX_PRODUCT_VISITS) break;

      const data = await inspectResultPage(context, link, logger);
      if (!data) continue;
      results.push(data);
    }

    return {
      ok: results.length > 0,
      results,
      reason: results.length > 0 ? null : "no_extractable_results",
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (err) {
    logger?.warn?.(
      {
        engine,
        searchQuery,
        error: err instanceof Error ? err.message : String(err),
      },
      "[browser-search] engine search failed"
    );

    return {
      ok: false,
      results: [],
      reason: err instanceof Error ? err.message : String(err),
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function browserSearch({ siteUrl, query, logger }) {
  const startedAt = Date.now();
  const domain = safeDomain(siteUrl);

  if (!domain) {
    return {
      ok: false,
      results: [],
      reason: "invalid_site_url",
      elapsed_ms: Date.now() - startedAt,
      engine_sequence: [],
      failures: [],
    };
  }

  const context = await getContext();
  const queries = buildSearchQueries(domain, query);
  const engines = ["google", "bing", "duckduckgo"];

  const engineSequence = [];
  const failures = [];

  for (const searchQuery of queries) {
    for (const engine of engines) {
      engineSequence.push({ engine, searchQuery });

      const attempt = await runEngineSearch({
        context,
        engine,
        domain,
        searchQuery,
        logger,
      });

      if (attempt.ok && attempt.results.length > 0) {
        return {
          ok: true,
          results: attempt.results,
          reason: null,
          elapsed_ms: Date.now() - startedAt,
          engine_sequence: engineSequence,
          failures,
        };
      }

      failures.push({
        engine,
        searchQuery,
        reason: attempt.reason || "unknown_error",
      });
    }
  }

  return {
    ok: false,
    results: [],
    reason: failures.at(-1)?.reason || "no_results",
    elapsed_ms: Date.now() - startedAt,
    engine_sequence: engineSequence,
    failures,
  };
}

export async function browserSearchWithRetry(opts) {
  return browserSearch(opts);
}

export async function closeBrowser() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (contextPromise) {
    const context = await contextPromise.catch(() => null);
    contextPromise = null;
    if (context) {
      await context.close().catch(() => {});
    }
  }

  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
