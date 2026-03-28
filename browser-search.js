import { chromium } from "playwright";

const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 25000);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 12000);
const MAX_RESULT_PAGES = Number(process.env.MAX_RESULT_PAGES || 4);
const MAX_EXCERPT_CHARS = Number(process.env.MAX_EXCERPT_CHARS || 1200);
const SEARCH_ENGINES = String(process.env.SEARCH_ENGINES || "bing,google")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

let browserPromise = null;

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

function safeUrl(raw) {
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

function safeDomain(siteUrl) {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function unique(array) {
  return [...new Set(array.filter(Boolean))];
}

function extractPriceCandidates(text) {
  const normalized = normalizeText(text);
  const matches = normalized.match(/\b\d{1,5}(?:[.,]\d{1,2})?\s?(?:лв\.?|lv|eur|€)\b/giu);
  return unique(matches || []).slice(0, 5);
}

function buildExcerpt(text, queryTokens) {
  const normalized = normalizeText(text);
  if (!normalized) return "";

  const lower = normalized.toLowerCase();
  let bestIndex = -1;

  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }

  if (bestIndex === -1) {
    return normalized.slice(0, MAX_EXCERPT_CHARS);
  }

  const start = Math.max(0, bestIndex - 180);
  const end = Math.min(normalized.length, bestIndex + 700);
  return normalized.slice(start, end).slice(0, MAX_EXCERPT_CHARS);
}

function scorePage({ title, text, queryTokens, prices }) {
  const haystack = `${normalizeText(title)} ${normalizeText(text)}`.toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    if (haystack.includes(token)) score += 3;
  }

  if (prices.length > 0) score += 4;
  if (/цена|цени|price|pricing|лв|eur|€/.test(haystack)) score += 2;
  if (/куп(и|ете)|добави|налич|размер|см\b|cm\b/.test(haystack)) score += 1;

  return score;
}

function buildSearchUrls(domain, query) {
  const encoded = encodeURIComponent(`site:${domain} ${query}`);
  return SEARCH_ENGINES.map((engine) => {
    if (engine === "google") {
      return {
        engine,
        url: `https://www.google.com/search?q=${encoded}&hl=bg`,
      };
    }

    return {
      engine: "bing",
      url: `https://www.bing.com/search?q=${encoded}&setlang=bg-BG`,
    };
  });
}

async function collectEngineLinks(page, engine, domain) {
  if (engine === "google") {
    return page.$$eval(
      'a[href^="http"]',
      (anchors, expectedDomain) => {
        const seen = new Set();
        const urls = [];

        for (const anchor of anchors) {
          const href = anchor.href;
          try {
            const url = new URL(href);
            const host = url.hostname.replace(/^www\./i, "").toLowerCase();
            const sameDomain = host === expectedDomain || host.endsWith(`.${expectedDomain}`);
            const blocked = /google\./i.test(host) || /webcache/i.test(href);
            if (!sameDomain || blocked || seen.has(href)) continue;
            seen.add(href);
            urls.push(href);
            if (urls.length >= 8) break;
          } catch {
            // noop
          }
        }

        return urls;
      },
      domain,
    );
  }

  return page.$$eval(
    'li.b_algo h2 a[href^="http"]',
    (anchors, expectedDomain) => {
      const seen = new Set();
      const urls = [];

      for (const anchor of anchors) {
        const href = anchor.href;
        try {
          const url = new URL(href);
          const host = url.hostname.replace(/^www\./i, "").toLowerCase();
          const sameDomain = host === expectedDomain || host.endsWith(`.${expectedDomain}`);
          if (!sameDomain || seen.has(href)) continue;
          seen.add(href);
          urls.push(href);
          if (urls.length >= 8) break;
        } catch {
          // noop
        }
      }

      return urls;
    },
    domain,
  );
}

async function inspectPage(context, link, queryTokens, logger) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(link, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    const data = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      const title = document.title || "";
      const h1 = document.querySelector("h1")?.textContent?.trim() || "";
      const metaDescription = document
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") || "";

      return {
        title,
        h1,
        metaDescription,
        text: bodyText,
      };
    });

    const combinedText = [data.metaDescription, data.text].filter(Boolean).join(" ");
    const prices = extractPriceCandidates(combinedText);
    const excerpt = buildExcerpt(combinedText, queryTokens);
    const score = scorePage({
      title: data.h1 || data.title,
      text: combinedText,
      queryTokens,
      prices,
    });

    return {
      url: link,
      title: data.h1 || data.title || link,
      excerpts: excerpt ? [excerpt] : [],
      price_hints: prices,
      score,
      source: "browser_search",
      on_domain: true,
    };
  } catch (err) {
    logger?.warn?.(
      {
        link,
        error: err instanceof Error ? err.message : String(err),
      },
      "[browser-search] failed to inspect result page"
    );
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function engineSearch(context, searchUrl, engine, domain, queryTokens, logger) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    logger?.info?.({ engine, searchUrl, domain }, "[browser-search] engine search start");

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });

    const links = await collectEngineLinks(page, engine, domain);
    if (!links.length) {
      return {
        ok: false,
        results: [],
        reason: `no_links_found_on_${engine}`,
        debug: { links_found: 0 },
      };
    }

    const results = [];
    for (const link of links) {
      if (results.length >= MAX_RESULT_PAGES) break;
      const inspected = await inspectPage(context, link, queryTokens, logger);
      if (inspected) results.push(inspected);
    }

    const filtered = results
      .filter((item) => item && item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULT_PAGES);

    return {
      ok: filtered.length > 0,
      results: filtered,
      reason: filtered.length > 0 ? null : `no_extractable_results_on_${engine}`,
      debug: {
        links_found: links.length,
        pages_scanned: results.length,
      },
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function siteInternalSearch(context, siteUrl, query, queryTokens, logger) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    await page.goto(siteUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });

    const searchFound = await page.evaluate((searchQuery) => {
      const searchSelectors = [
        'input[type="search"]',
        'input[name*="search" i]',
        'input[placeholder*="търс" i]',
        'input[placeholder*="search" i]',
        'form input[type="text"]',
      ];

      const input = document.querySelector(searchSelectors.join(", "));
      if (!input) return false;

      input.focus();
      input.value = searchQuery;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, query);

    if (!searchFound) {
      return {
        ok: false,
        results: [],
        reason: "site_search_input_not_found",
      };
    }

    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(2000);

    const sameDomain = safeDomain(siteUrl);
    const links = await page.$$eval(
      'a[href^="http"]',
      (anchors, expectedDomain) => {
        const seen = new Set();
        const urls = [];
        for (const anchor of anchors) {
          const href = anchor.href;
          try {
            const url = new URL(href);
            const host = url.hostname.replace(/^www\./i, "").toLowerCase();
            const same = host === expectedDomain || host.endsWith(`.${expectedDomain}`);
            if (!same || seen.has(href)) continue;
            seen.add(href);
            urls.push(href);
            if (urls.length >= 8) break;
          } catch {
            // noop
          }
        }
        return urls;
      },
      sameDomain,
    );

    if (!links.length) {
      return {
        ok: false,
        results: [],
        reason: "site_search_no_links",
      };
    }

    const results = [];
    for (const link of links) {
      if (results.length >= MAX_RESULT_PAGES) break;
      const inspected = await inspectPage(context, link, queryTokens, logger);
      if (inspected) {
        inspected.source = "site_search";
        results.push(inspected);
      }
    }

    const filtered = results
      .filter((item) => item && item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULT_PAGES);

    return {
      ok: filtered.length > 0,
      results: filtered,
      reason: filtered.length > 0 ? null : "site_search_no_extractable_results",
      debug: {
        links_found: links.length,
        pages_scanned: results.length,
      },
    };
  } catch (err) {
    logger?.warn?.(
      {
        siteUrl,
        error: err instanceof Error ? err.message : String(err),
      },
      "[browser-search] internal site search failed"
    );

    return {
      ok: false,
      results: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function browserSearch({ siteUrl, query, language, logger }) {
  const startedAt = Date.now();
  const normalizedSiteUrl = safeUrl(siteUrl);
  const domain = safeDomain(siteUrl);
  const queryTokens = unique(tokenize(query));

  if (!normalizedSiteUrl || !domain) {
    return {
      ok: false,
      results: [],
      reason: "invalid_site_url",
      engine_sequence: [],
      elapsed_ms: Date.now() - startedAt,
      debug: {},
    };
  }

  let context = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: language || "bg-BG",
    });

    const engineSequence = [];

    for (const item of buildSearchUrls(domain, query)) {
      engineSequence.push(item.engine);
      const engineResult = await engineSearch(
        context,
        item.url,
        item.engine,
        domain,
        queryTokens,
        logger,
      );

      if (engineResult.ok) {
        return {
          ok: true,
          results: engineResult.results,
          reason: null,
          confidence: engineResult.results.some((item) => item.price_hints?.length)
            ? 0.96
            : 0.88,
          engine_sequence: engineSequence,
          elapsed_ms: Date.now() - startedAt,
          debug: {
            mode: "search_engine",
            engine: item.engine,
            ...engineResult.debug,
          },
        };
      }

      logger?.info?.(
        {
          engine: item.engine,
          reason: engineResult.reason,
        },
        "[browser-search] engine search returned no usable results"
      );
    }

    engineSequence.push("site_internal_search");
    const internalResult = await siteInternalSearch(context, normalizedSiteUrl, query, queryTokens, logger);
    if (internalResult.ok) {
      return {
        ok: true,
        results: internalResult.results,
        reason: null,
        confidence: internalResult.results.some((item) => item.price_hints?.length)
          ? 0.93
          : 0.82,
        engine_sequence: engineSequence,
        elapsed_ms: Date.now() - startedAt,
        debug: {
          mode: "site_internal_search",
          ...internalResult.debug,
        },
      };
    }

    return {
      ok: false,
      results: [],
      reason: internalResult.reason || "no_browser_results",
      engine_sequence: engineSequence,
      elapsed_ms: Date.now() - startedAt,
      debug: {
        mode: "none",
        domain,
      },
    };
  } catch (err) {
    logger?.error?.(
      { error: err instanceof Error ? err.message : String(err) },
      "[browser-search] failed"
    );

    return {
      ok: false,
      results: [],
      reason: err instanceof Error ? err.message : String(err),
      engine_sequence: [],
      elapsed_ms: Date.now() - startedAt,
      debug: {
        mode: "error",
      },
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

export async function browserSearchWithRetry(opts) {
  const first = await browserSearch(opts);
  if (first.ok) return first;

  const second = await browserSearch(opts);
  if (second.ok) return second;

  return {
    ...second,
    engine_sequence: unique([...(first.engine_sequence || []), ...(second.engine_sequence || [])]),
    debug: {
      first_attempt_reason: first.reason || null,
      second_attempt_reason: second.reason || null,
      ...(second.debug || {}),
    },
  };
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
