/**
 * browser-search.js — Live fallback: go directly to the site and search there.
 *
 * Strategy (no Google — Google blocks headless bots):
 *   1. Open site_url directly
 *   2. Find the site's search input, type the query
 *   3. Grab the first product links from results
 *   4. Visit each, extract price/title/availability
 *
 * Fallback if no search bar found:
 *   Try common URL patterns: /search?q=..., /catalogsearch/result/?q=..., etc.
 */

import { chromium } from "playwright";

// ── Config ────────────────────────────────────────────────────────────────────
const BROWSER_TIMEOUT_MS = parseInt(process.env.BROWSER_TIMEOUT_MS || "10000", 10);
const NAV_TIMEOUT_MS = 6000;
const MAX_PRODUCT_VISITS = 2;

// ── Browser singleton ─────────────────────────────────────────────────────────
let _browser = null;
let _launching = null;

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  if (_launching) return _launching;

  _launching = chromium.launch({
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
    _browser = await _launching;
    _browser.on("disconnected", () => { _browser = null; _launching = null; });
    return _browser;
  } finally {
    _launching = null;
  }
}

export async function closeBrowser() {
  if (_browser?.isConnected()) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDomain(siteUrl) {
  try { return new URL(siteUrl).hostname.replace(/^www\./, ""); }
  catch { return siteUrl.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; }
}

function getOrigin(siteUrl) {
  try { return new URL(siteUrl).origin; }
  catch { return `https://${getDomain(siteUrl)}`; }
}

/**
 * Common search URL patterns used by e-commerce sites.
 * We try these if we can't find or interact with a search input.
 */
function buildSearchUrls(origin, query) {
  const q = encodeURIComponent(query);
  return [
    `${origin}/search?q=${q}`,
    `${origin}/catalogsearch/result/?q=${q}`,
    `${origin}/search?keyword=${q}`,
    `${origin}/search?text=${q}`,
    `${origin}/search/${q}`,
    `${origin}/?s=${q}`,
    `${origin}/search?search=${q}`,
  ];
}

// ── Product page extraction (universal, no hardcoding) ───────────────────────

async function extractProductData(page) {
  await page.waitForTimeout(600);

  return page.evaluate(() => {
    // Price
    function findPrice() {
      // JSON-LD
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const walk = (obj) => {
            if (!obj || typeof obj !== "object") return null;
            if (Array.isArray(obj)) { for (const i of obj) { const r = walk(i); if (r) return r; } return null; }
            const offers = obj.offers || obj.Offers;
            if (offers) {
              const list = Array.isArray(offers) ? offers : [offers];
              for (const o of list) { if (o.price) return `${o.price} ${o.priceCurrency || "лв."}`; }
            }
            if (obj.price) return `${obj.price} ${obj.priceCurrency || ""}`;
            for (const v of Object.values(obj)) { const r = walk(v); if (r) return r; }
            return null;
          };
          const r = walk(JSON.parse(s.textContent));
          if (r) return r;
        } catch {}
      }

      // itemprop
      const ip = document.querySelector('[itemprop="price"]');
      if (ip) return ip.getAttribute("content") || ip.textContent?.trim() || "";

      // og
      const og = document.querySelector('meta[property="og:price:amount"], meta[property="product:price:amount"]');
      if (og) return og.getAttribute("content") || "";

      // DOM class scan
      const priceRe = /(\d[\d\s.,]*\d)\s*(лв\.?|лева|BGN|EUR|€|\$|USD)/i;
      for (const el of document.querySelectorAll('[class*="price" i], [class*="Price"], [data-price]')) {
        const m = el.textContent?.trim()?.match(priceRe);
        if (m) return m[0];
      }

      // Full body scan (last resort)
      const bodyMatch = document.body?.innerText?.match(/(\d{1,6}[.,]\d{2})\s*(лв\.?|лева|BGN|EUR|€)/);
      return bodyMatch ? bodyMatch[0] : "";
    }

    // Title
    function findTitle() {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          const items = Array.isArray(j) ? j : [j];
          for (const i of items) if (i?.name && /product/i.test(i["@type"] || "")) return i.name;
        } catch {}
      }
      return document.querySelector('meta[property="og:title"]')?.content
        || document.querySelector("h1")?.textContent?.trim()
        || document.title || "";
    }

    // Availability
    function findAvailability() {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          const items = Array.isArray(j) ? j : [j];
          for (const i of items) {
            const offers = i?.offers || i?.Offers;
            if (offers) {
              const list = Array.isArray(offers) ? offers : [offers];
              for (const o of list) if (o.availability) return o.availability.replace(/https?:\/\/schema\.org\//g, "");
            }
          }
        } catch {}
      }
      const el = document.querySelector('[class*="stock" i], [class*="availab" i], [class*="наличност" i]');
      return el?.textContent?.trim()?.slice(0, 100) || "";
    }

    return {
      title: (findTitle() || "").slice(0, 250),
      price: findPrice() || "",
      description: (document.querySelector('meta[property="og:description"], meta[name="description"]')?.content || "").slice(0, 300),
      availability: findAvailability(),
      url: document.querySelector('link[rel="canonical"]')?.href || location.href,
    };
  });
}

// ── Search results page: extract product links ───────────────────────────────

async function extractSearchResultLinks(page, domain) {
  return page.evaluate((domain) => {
    const links = [];
    const seen = new Set();

    // Strategy 1: Look for product card links (most reliable)
    const productCardSelectors = [
      '.product-card a[href]', '.product-item a[href]', '.product a[href]',
      '[class*="product" i] a[href]', '[class*="item-card" i] a[href]',
      '.search-results a[href]', '[class*="search-result" i] a[href]',
      '[class*="listing" i] a[href]', '.category-products a[href]',
      '[data-product] a[href]', '[data-item] a[href]',
    ];

    for (const sel of productCardSelectors) {
      for (const a of document.querySelectorAll(sel)) {
        const href = a.href;
        if (!href || seen.has(href)) continue;

        let onDomain = false;
        try { onDomain = new URL(href).hostname.replace(/^www\./, "").includes(domain); } catch { continue; }
        if (!onDomain) continue;

        const path = new URL(href).pathname;
        if (path.length < 5) continue;
        if (/\/(search|login|cart|account|checkout|register|wishlist|category|categories)/i.test(path)) continue;

        // Prefer links that look like product pages (have slug-like paths)
        const segments = path.split("/").filter(Boolean);
        if (segments.length < 1) continue;

        const text = a.textContent?.trim() || a.getAttribute("title") || "";

        seen.add(href);
        links.push({ url: href, title: text.slice(0, 200) });
        if (links.length >= 5) break;
      }
      if (links.length >= 5) break;
    }

    // Strategy 2: Fallback — any link that looks like a product URL
    if (links.length === 0) {
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.href;
        if (!href || seen.has(href)) continue;

        let onDomain = false;
        try { onDomain = new URL(href).hostname.replace(/^www\./, "").includes(domain); } catch { continue; }
        if (!onDomain) continue;

        const path = new URL(href).pathname;
        if (path.length < 10) continue;
        if (/\/(search|login|cart|account|checkout|register|wishlist|category|categories|about|contact|faq|help|blog)/i.test(path)) continue;

        // Must have slug-like path (e.g. /product-name-123)
        const lastSeg = path.split("/").filter(Boolean).pop() || "";
        if (lastSeg.length < 5 || !/[a-z]/i.test(lastSeg)) continue;

        const text = a.textContent?.trim() || "";
        if (text.length < 3) continue;

        seen.add(href);
        links.push({ url: href, title: text.slice(0, 200) });
        if (links.length >= 5) break;
      }
    }

    return links;
  }, domain);
}

// ── Try interacting with the site's search bar ───────────────────────────────

async function trySearchOnSite(page, siteUrl, query, logger) {
  const origin = getOrigin(siteUrl);

  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(800);

  // ── Dismiss overlays that block clicks (cookie consent, newsletter popups) ──
  await page.evaluate(() => {
    // Remove Cookiebot overlay
    document.querySelector('#CybotCookiebotDialog')?.remove();
    document.querySelector('#CybotCookiebotDialogBodyUnderlay')?.remove();

    // Try clicking common cookie accept buttons
    const cookieBtns = document.querySelectorAll(
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, ' +
      '#CybotCookiebotDialogBodyButtonAccept, ' +
      '[id*="cookie" i] button, [class*="cookie" i] button, ' +
      'button[class*="accept" i], button[class*="agree" i], ' +
      'a[class*="accept" i], a[class*="agree" i]'
    );
    for (const btn of cookieBtns) { try { btn.click(); } catch {} }

    // Remove newsletter/modal popups
    document.querySelectorAll(
      '.modal.show, [class*="newsletter" i].show, [class*="popup" i].show, ' +
      '[class*="modal-subscribe"], [class*="pop-up"]'
    ).forEach(el => el.remove());

    // Remove any remaining overlays/backdrops
    document.querySelectorAll(
      '.modal-backdrop, [class*="overlay" i], [class*="underlay" i]'
    ).forEach(el => el.remove());

    // Reset body scroll locks
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open', 'no-scroll');
  }).catch(() => {});

  await page.waitForTimeout(300);

  const searchSelectors = [
    'input[type="search"]',
    'input[name="q"]',
    'input[name="search"]',
    'input[name="keyword"]',
    'input[name="text"]',
    'input[name="s"]',
    'input[placeholder*="търс" i]',
    'input[placeholder*="search" i]',
    'input[aria-label*="search" i]',
    'input[aria-label*="търс" i]',
    'input[id*="search" i]',
    'input[class*="search" i]',
  ];

  for (const sel of searchSelectors) {
    const input = await page.$(sel);
    if (!input) continue;

    let visible = await input.isVisible().catch(() => false);
    if (!visible) {
      // Click search icon/toggle to reveal it
      const toggle = await page.$('[class*="search" i] button, [class*="search" i] a, button[aria-label*="search" i], .search-toggle, .search-icon');
      if (toggle) {
        await toggle.click({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      visible = await input.isVisible().catch(() => false);
      if (!visible) continue;
    }

    // Use force:true to bypass any remaining overlay issues
    try {
      await input.click({ force: true, timeout: 2000 });
    } catch {
      // If click still fails, try focus via JS
      await page.evaluate((s) => document.querySelector(s)?.focus(), sel).catch(() => {});
    }

    await input.fill(query);
    await page.waitForTimeout(200);
    await input.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(800);

    logger.info?.({ method: "search_input", selector: sel }, "[browser-search] submitted search on site");
    return true;
  }

  return false;
}

// ── Try common search URL patterns ───────────────────────────────────────────

async function trySearchUrls(page, siteUrl, query, logger) {
  const origin = getOrigin(siteUrl);
  const urls = buildSearchUrls(origin, query);

  for (const url of urls) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      if (!resp || resp.status() >= 400) continue;

      await page.waitForTimeout(500);
      const hasContent = await page.evaluate(() => document.querySelectorAll("a[href]").length > 10);
      if (hasContent) {
        logger.info?.({ method: "url_pattern", url }, "[browser-search] found results via URL pattern");
        return true;
      }
    } catch { continue; }
  }

  return false;
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function browserSearch({ siteUrl, query, logger = console }) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  let context = null;

  try {
    const domain = getDomain(siteUrl);
    logger.info?.({ query, domain }, "[browser-search] starting direct site search");

    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      locale: "bg-BG",
      timezoneId: "Europe/Sofia",
      viewport: { width: 1280, height: 720 },
    });

    // Block images/fonts/analytics for speed
    await context.route("**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,eot,mp4,avi}", (r) => r.abort());
    await context.route("**/{analytics,tracking,facebook,google-analytics,gtag,doubleclick,hotjar}**", (r) => r.abort());

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // ── Step 1: Search on the site ────────────────────────────────────
    let foundResults = await trySearchOnSite(page, siteUrl, query, logger);

    if (!foundResults) {
      logger.info?.("[browser-search] no search input found, trying URL patterns");
      foundResults = await trySearchUrls(page, siteUrl, query, logger);
    }

    if (!foundResults) {
      logger.warn?.("[browser-search] could not search on site at all");
      return { ok: false, results: [], source: "browser_fallback", elapsed_ms: elapsed(), reason: "no_search_method" };
    }

    // ── Step 2: Try extracting products with prices directly from search results page ──
    //    (Many sites show prices in search results — no need to visit individual pages)
    const searchPageProducts = await page.evaluate((domain) => {
      const products = [];
      const priceRe = /(\d[\d\s.,]*\d)\s*(лв\.?|лева|BGN|EUR|€|\$|USD)/i;
      
      // Look for product cards that contain both a link and a price
      const cardSelectors = [
        '.product-card', '.product-item', '.product', '[class*="product" i]',
        '[data-product]', '[data-item]', '.search-result-item', '[class*="item-card" i]',
        '.category-products > div', '.category-products > li',
        '[class*="listing" i] > div', '[class*="listing" i] > li',
      ];
      
      for (const sel of cardSelectors) {
        for (const card of document.querySelectorAll(sel)) {
          const link = card.querySelector('a[href]');
          if (!link) continue;
          
          const href = link.href;
          try { 
            if (!new URL(href).hostname.replace(/^www\./, "").includes(domain)) continue; 
          } catch { continue; }
          
          const cardText = card.textContent || "";
          const priceMatch = cardText.match(priceRe);
          if (!priceMatch) continue;
          
          const title = link.getAttribute("title") || link.textContent?.trim() || 
                        card.querySelector("h2, h3, h4, [class*='name' i], [class*='title' i]")?.textContent?.trim() || "";
          if (!title || title.length < 3) continue;
          
          products.push({
            title: title.slice(0, 250),
            price: priceMatch[0],
            url: href,
            snippet: "",
            availability: "",
            on_domain: true,
            source: "browser_fallback",
          });
          
          if (products.length >= 5) break;
        }
        if (products.length >= 5) break;
      }
      
      return products;
    }, getDomain(siteUrl));
    
    if (searchPageProducts.length > 0) {
      logger.info?.({ found: searchPageProducts.length, elapsed: elapsed() }, "[browser-search] extracted products from search results page");
      return { ok: true, results: searchPageProducts, source: "browser_fallback", elapsed_ms: elapsed() };
    }

    // ── Step 3: Extract product links from search results ─────────────
    const productLinks = await extractSearchResultLinks(page, domain);
    logger.info?.({ count: productLinks.length, elapsed: elapsed() }, "[browser-search] product links found");

    if (productLinks.length === 0) {
      // Maybe we landed directly on a product page?
      const directData = await extractProductData(page);
      if (directData.price) {
        return {
          ok: true,
          results: [{
            title: directData.title, price: directData.price, url: directData.url,
            snippet: directData.description, availability: directData.availability,
            on_domain: true, source: "browser_fallback",
          }],
          source: "browser_fallback",
          elapsed_ms: elapsed(),
        };
      }
      return { ok: false, results: [], source: "browser_fallback", elapsed_ms: elapsed(), reason: "no_product_links" };
    }

    // ── Step 4: Visit top product pages, extract data ─────────────────
    const results = [];

    for (const link of productLinks.slice(0, MAX_PRODUCT_VISITS)) {
      if (elapsed() > BROWSER_TIMEOUT_MS - 2000) break;

      try {
        await page.goto(link.url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        await page.waitForTimeout(300);
        const data = await extractProductData(page);

        const title = data.title || link.title || "";
        const price = data.price || "";

        if (title || price) {
          results.push({
            title: title.slice(0, 250), price,
            url: data.url || link.url,
            snippet: data.description || "",
            availability: data.availability || "",
            on_domain: true, source: "browser_fallback",
          });
          logger.info?.({ title: title.slice(0, 60), price, elapsed: elapsed() }, "[browser-search] extracted product");
        }
      } catch (err) {
        logger.warn?.({ url: link.url, error: err.message }, "[browser-search] product extraction failed");
      }
    }

    logger.info?.({ found: results.length, elapsed: elapsed() }, "[browser-search] done");

    return { ok: results.length > 0, results, source: "browser_fallback", elapsed_ms: elapsed() };

  } catch (err) {
    logger.error?.({ error: err.message, elapsed: elapsed() }, "[browser-search] fallback failed");
    return { ok: false, results: [], source: "browser_fallback", elapsed_ms: elapsed(), reason: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

export async function browserSearchWithRetry(opts) {
  const globalStart = Date.now();
  const first = await browserSearch(opts);
  if (first.ok && first.results.length > 0) return first;

  // Don't retry if we already used more than half the timeout budget
  const elapsedSoFar = Date.now() - globalStart;
  if (elapsedSoFar > (BROWSER_TIMEOUT_MS / 2)) {
    opts.logger?.info?.({ elapsed: elapsedSoFar }, "[browser-search] skipping retry — not enough time left");
    return first;
  }

  opts.logger?.info?.("[browser-search] retrying once…");
  return browserSearch(opts);
}

process.on("SIGINT", closeBrowser);
process.on("SIGTERM", closeBrowser);
