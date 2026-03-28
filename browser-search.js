import { chromium } from "playwright";

const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 25000);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 12000);
const MAX_RESULT_LINKS = Number(process.env.MAX_RESULT_LINKS || 5);
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

function extractPriceMatches(text) {
  const source = normalizeWhitespace(text);
  if (!source) return [];

  const regex =
    /\b\d{1,5}(?:[.,]\d{1,2})?\s?(?:лв\.?|lv|eur|€)\b/gi;

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
  ]);
}

function buildSearchUrl(engine, searchQuery) {
  if (engine === "google") {
    return `https://www.google.com/search?q=${encodeURIComponent(
      searchQuery
    )}&hl=bg&num=10`;
  }

  return `https://www.bing.com/search?q=${encodeURIComponent(
    searchQuery
  )}&setlang=bg-BG`;
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

    contextPromise = browser
      .newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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

async function extractEngineLinks(page, domain) {
  return page.evaluate(
    ({ expectedDomain, maxLinks }) => {
      const isSameDomain = (href) => {
        try {
          const url = new URL(href);
          const host = url.hostname.replace(/^www\./i, "");
          return (
            host === expectedDomain ||
            host.endsWith(`.${expectedDomain}`)
          );
        } catch {
          return false;
        }
      };

      const badPatterns = [
        "/search?",
        "/preferences?",
        "/policies?",
        "/advanced_search",
        "/imgres?",
        "/url?",
        "google.com",
        "bing.com",
        "webcache",
        "/translate",
      ];

      const links = [];

      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = a.href || "";
        if (!href.startsWith("http")) continue;
        if (!isSameDomain(href)) continue;
        if (badPatterns.some((part) => href.includes(part))) continue;
        links.push(href);
      }

      return [...new Set(links)].slice(0, maxLinks);
    },
    { expectedDomain: domain, maxLinks: maxLinksSafe(MAX_RESULT_LINKS) }
  );
}

function maxLinksSafe(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(n, 10);
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

    const links = await extractEngineLinks(page, domain);

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
  const engines = ["google", "bing"];

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
