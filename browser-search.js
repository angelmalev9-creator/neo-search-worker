/**
 * browser-search.js — Live fallback search via headless browser
 *
 * When structured_data lacks pricing or confidence is low,
 * this module performs a real Google search scoped to the site domain,
 * visits the top results, and extracts product data.
 *
 * Design goals:
 *   - Max 8s total timeout per call (configurable)
 *   - 1 retry on failure
 *   - No heavy ML — pure DOM extraction
 *   - Universal (no site-specific selectors)
 *   - Safe — every await is guarded, browser always closes
 */

import { chromium } from "playwright";

// ── Configuration ──────────────────────────────────────────────────────────────

const BROWSER_TIMEOUT_MS = parseInt(process.env.BROWSER_TIMEOUT_MS || "8000", 10);
const MAX_RESULTS_TO_VISIT = 3;
const NAVIGATION_TIMEOUT_MS = 6000;
const EXTRACT_TIMEOUT_MS = 4000;

// ── Browser pool (reuse across requests) ───────────────────────────────────────

let _browser = null;
let _browserLaunchPromise = null;

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;

  // Prevent concurrent launches
  if (_browserLaunchPromise) return _browserLaunchPromise;

  _browserLaunchPromise = chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--no-zygote",
    ],
  });

  try {
    _browser = await _browserLaunchPromise;

    _browser.on("disconnected", () => {
      _browser = null;
      _browserLaunchPromise = null;
    });

    return _browser;
  } finally {
    _browserLaunchPromise = null;
  }
}

/**
 * Gracefully shut down the shared browser (call on process exit).
 */
export async function closeBrowser() {
  if (_browser?.isConnected()) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ── Query builder ──────────────────────────────────────────────────────────────

/**
 * Build a Google-ready search query scoped to the site domain.
 *
 * @param {string} siteUrl  — e.g. "https://praktiker.bg"
 * @param {string} query    — user's raw query
 * @returns {string}
 */
function buildSearchQuery(siteUrl, query) {
  let domain = "";
  try {
    domain = new URL(siteUrl).hostname.replace(/^www\./, "");
  } catch {
    domain = siteUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
  // site:domain + original query — Google narrows results to that domain
  return `site:${domain} ${query}`;
}

// ── Google SERP extraction ─────────────────────────────────────────────────────

/**
 * Search Google and extract organic result links.
 * Returns up to `MAX_RESULTS_TO_VISIT` URLs from the target domain.
 */
async function searchGoogle(page, searchQuery, targetDomain) {
  const encodedQ = encodeURIComponent(searchQuery);
  const url = `https://www.google.com/search?q=${encodedQ}&hl=bg&num=10`;

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  // Wait briefly for results to render
  await page.waitForSelector("div#search", { timeout: 3000 }).catch(() => {});

  const links = await page.evaluate((domain) => {
    const anchors = document.querySelectorAll("div#search a[href]");
    const results = [];
    const seen = new Set();

    for (const a of anchors) {
      const href = a.href;
      if (!href || href.includes("google.") || href.includes("webcache") || href.includes("translate.google")) continue;

      // Extract clean URL
      let cleanUrl = href;
      try {
        const u = new URL(href);
        // Google sometimes wraps in /url?q=...
        if (u.pathname === "/url" && u.searchParams.has("q")) {
          cleanUrl = u.searchParams.get("q");
        }
      } catch { continue; }

      if (seen.has(cleanUrl)) continue;
      seen.add(cleanUrl);

      // Prefer same-domain results
      let isDomain = false;
      try {
        isDomain = new URL(cleanUrl).hostname.replace(/^www\./, "").includes(domain);
      } catch { /* skip */ }

      if (isDomain) {
        // Get visible text near the link as a title hint
        const title = a.textContent?.trim()?.slice(0, 200) || "";
        results.push({ url: cleanUrl, title, onDomain: true });
      }
    }

    // If no on-domain results, take any organic results
    if (results.length === 0) {
      for (const a of anchors) {
        const href = a.href;
        if (!href || href.includes("google.") || href.includes("webcache")) continue;
        let cleanUrl = href;
        try {
          const u = new URL(href);
          if (u.pathname === "/url" && u.searchParams.has("q")) {
            cleanUrl = u.searchParams.get("q");
          }
        } catch { continue; }
        if (seen.has(`off:${cleanUrl}`)) continue;
        seen.add(`off:${cleanUrl}`);
        const title = a.textContent?.trim()?.slice(0, 200) || "";
        results.push({ url: cleanUrl, title, onDomain: false });
        if (results.length >= 3) break;
      }
    }

    return results;
  }, targetDomain);

  return links.slice(0, MAX_RESULTS_TO_VISIT);
}

// ── Product data extraction ────────────────────────────────────────────────────

/**
 * Visit a product page and extract structured product info via DOM heuristics.
 * Works on arbitrary sites — no hardcoded selectors.
 */
async function extractProductData(page, targetUrl) {
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  // Give JS-rendered content a brief moment
  await page.waitForTimeout(800);

  const data = await page.evaluate(() => {
    // ── Price extraction ──────────────────────────────────────────────────
    function findPrices() {
      const prices = [];

      // 1) JSON-LD structured data (most reliable)
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        try {
          const json = JSON.parse(s.textContent);
          const items = Array.isArray(json) ? json : [json];
          for (const item of items) {
            const offer = item?.offers || item?.Offers;
            if (offer) {
              const offerList = Array.isArray(offer) ? offer : [offer];
              for (const o of offerList) {
                if (o.price) {
                  prices.push({
                    value: String(o.price),
                    currency: o.priceCurrency || "BGN",
                    source: "json-ld",
                  });
                }
              }
            }
            if (item?.price) {
              prices.push({ value: String(item.price), currency: item.priceCurrency || "", source: "json-ld" });
            }
          }
        } catch { /* malformed JSON-LD, skip */ }
      }

      // 2) Microdata / itemprop="price"
      const priceEls = document.querySelectorAll('[itemprop="price"]');
      for (const el of priceEls) {
        const val = el.getAttribute("content") || el.textContent?.trim();
        if (val) prices.push({ value: val, currency: "", source: "microdata" });
      }

      // 3) Meta og:price
      const ogPrice = document.querySelector('meta[property="og:price:amount"], meta[property="product:price:amount"]');
      if (ogPrice) {
        prices.push({ value: ogPrice.getAttribute("content") || "", currency: "", source: "og" });
      }

      // 4) DOM heuristic — look for common price patterns
      if (prices.length === 0) {
        const priceRegex = /(\d[\d\s.,]*\d)\s*(лв\.?|лева|BGN|EUR|€|\$|USD)/i;
        const altRegex = /(лв\.?|BGN|EUR|€|\$)\s*(\d[\d\s.,]*\d)/i;

        // Common price class/attribute patterns
        const candidates = document.querySelectorAll(
          '[class*="price"], [class*="Price"], [class*="cost"], [class*="amount"], ' +
          '[id*="price"], [id*="Price"], [data-price], ' +
          '.product-price, .current-price, .sale-price, .regular-price'
        );

        for (const el of candidates) {
          const text = el.textContent?.trim() || "";
          const match = text.match(priceRegex) || text.match(altRegex);
          if (match) {
            prices.push({ value: text.slice(0, 60), currency: "", source: "dom" });
            break; // one is enough
          }
        }

        // Last resort: scan all visible text for price patterns
        if (prices.length === 0) {
          const body = document.body?.innerText || "";
          const matches = body.match(/(\d{1,6}[.,]\d{2})\s*(лв\.?|лева|BGN|EUR|€)/g);
          if (matches && matches.length > 0) {
            prices.push({ value: matches[0], currency: "", source: "text-scan" });
          }
        }
      }

      return prices;
    }

    // ── Title extraction ──────────────────────────────────────────────────
    function findTitle() {
      // JSON-LD name
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        try {
          const json = JSON.parse(s.textContent);
          const items = Array.isArray(json) ? json : [json];
          for (const item of items) {
            if (item?.name && (item["@type"] === "Product" || item["@type"] === "IndividualProduct")) {
              return item.name;
            }
          }
        } catch { /* skip */ }
      }

      // og:title
      const og = document.querySelector('meta[property="og:title"]');
      if (og?.content) return og.content;

      // h1
      const h1 = document.querySelector("h1");
      if (h1?.textContent?.trim()) return h1.textContent.trim();

      // document title
      return document.title || "";
    }

    // ── Description extraction ────────────────────────────────────────────
    function findDescription() {
      const og = document.querySelector('meta[property="og:description"], meta[name="description"]');
      if (og?.content) return og.content.slice(0, 300);

      const descEl = document.querySelector(
        '[class*="description"], [class*="Description"], [itemprop="description"]'
      );
      if (descEl?.textContent?.trim()) return descEl.textContent.trim().slice(0, 300);

      return "";
    }

    // ── Availability extraction ───────────────────────────────────────────
    function findAvailability() {
      // JSON-LD
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        try {
          const json = JSON.parse(s.textContent);
          const items = Array.isArray(json) ? json : [json];
          for (const item of items) {
            const offer = item?.offers || item?.Offers;
            if (offer) {
              const offerList = Array.isArray(offer) ? offer : [offer];
              for (const o of offerList) {
                if (o.availability) {
                  return o.availability.replace("https://schema.org/", "").replace("http://schema.org/", "");
                }
              }
            }
          }
        } catch { /* skip */ }
      }

      // DOM text scan
      const avail = document.querySelector(
        '[class*="availab"], [class*="stock"], [class*="наличност"], [class*="Наличност"]'
      );
      if (avail?.textContent?.trim()) return avail.textContent.trim().slice(0, 100);

      return "";
    }

    return {
      title: findTitle()?.slice(0, 250) || "",
      prices: findPrices().slice(0, 3),
      description: findDescription(),
      availability: findAvailability(),
      canonical: document.querySelector('link[rel="canonical"]')?.href || "",
    };
  });

  return data;
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Perform a live browser search + extraction.
 *
 * @param {Object}  opts
 * @param {string}  opts.siteUrl   — the business site URL (e.g. "https://praktiker.bg")
 * @param {string}  opts.query     — the user's search query
 * @param {Object}  [opts.logger]  — Fastify-compatible logger (optional)
 * @returns {Promise<{ ok: boolean, results: Array, source: string, elapsed_ms: number }>}
 */
export async function browserSearch({ siteUrl, query, logger = console }) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  // Global abort — never exceed BROWSER_TIMEOUT_MS
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => abortController.abort(), BROWSER_TIMEOUT_MS);

  let context = null;

  try {
    // Extract domain for filtering
    let targetDomain = "";
    try {
      targetDomain = new URL(siteUrl).hostname.replace(/^www\./, "");
    } catch {
      targetDomain = siteUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    }

    const searchQuery = buildSearchQuery(siteUrl, query);
    logger.info?.({ searchQuery, targetDomain }, "[browser-search] starting fallback search");

    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "bg-BG",
      timezoneId: "Europe/Sofia",
      viewport: { width: 1280, height: 720 },
      javaScriptEnabled: true,
    });

    // Block heavy resources for speed
    await context.route("**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,mp4,mp3,avi}", (route) =>
      route.abort()
    );
    await context.route("**/{analytics,tracking,ads,facebook,google-analytics,gtag,doubleclick}**", (route) =>
      route.abort()
    );

    const page = await context.newPage();

    // ── Step 1: Google search ──────────────────────────────────────────
    if (abortController.signal.aborted) throw new Error("timeout");

    const serpResults = await searchGoogle(page, searchQuery, targetDomain);
    logger.info?.({ count: serpResults.length, elapsed: elapsed() }, "[browser-search] SERP results collected");

    if (serpResults.length === 0) {
      return {
        ok: false,
        results: [],
        source: "browser_fallback",
        elapsed_ms: elapsed(),
        reason: "no_serp_results",
      };
    }

    // ── Step 2: Visit top results and extract product data ─────────────
    const extractedResults = [];

    for (const serp of serpResults) {
      if (abortController.signal.aborted) break;
      if (elapsed() > BROWSER_TIMEOUT_MS - 1000) break; // leave 1s margin

      try {
        const raw = await Promise.race([
          extractProductData(page, serp.url),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("extract_timeout")), EXTRACT_TIMEOUT_MS)
          ),
        ]);

        const priceStr = raw.prices?.[0]?.value || "";
        const title = raw.title || serp.title || "";

        if (title || priceStr) {
          extractedResults.push({
            title: title.slice(0, 250),
            price: priceStr,
            url: raw.canonical || serp.url,
            snippet: raw.description || "",
            availability: raw.availability || "",
            on_domain: serp.onDomain ?? false,
            source: "browser_fallback",
          });
        }
      } catch (err) {
        logger.warn?.(
          { url: serp.url, error: err.message, elapsed: elapsed() },
          "[browser-search] extraction failed for URL"
        );
      }
    }

    logger.info?.(
      { found: extractedResults.length, elapsed: elapsed() },
      "[browser-search] extraction complete"
    );

    return {
      ok: extractedResults.length > 0,
      results: extractedResults,
      source: "browser_fallback",
      elapsed_ms: elapsed(),
    };
  } catch (err) {
    const msg = err.message || String(err);
    if (msg !== "timeout") {
      logger.error?.({ error: msg, elapsed: elapsed() }, "[browser-search] fallback failed");
    }

    return {
      ok: false,
      results: [],
      source: "browser_fallback",
      elapsed_ms: elapsed(),
      reason: msg === "timeout" ? "global_timeout" : msg,
    };
  } finally {
    clearTimeout(globalTimer);
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

/**
 * Wrapper with 1 retry.
 */
export async function browserSearchWithRetry(opts) {
  const first = await browserSearch(opts);
  if (first.ok && first.results.length > 0) return first;

  opts.logger?.info?.("[browser-search] retrying once…");
  return browserSearch(opts);
}

// ── Cleanup on process exit ────────────────────────────────────────────────────
process.on("SIGINT", closeBrowser);
process.on("SIGTERM", closeBrowser);
