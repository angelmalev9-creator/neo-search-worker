/**
 * browser-search.js — Live fallback for NEO Search Worker
 * Strategy: Search Engine -> Domain Filter -> Visit -> Universal Extract
 */
import { chromium } from "playwright";

const BROWSER_TIMEOUT_MS = 8000;
const SEARCH_ENGINE_URL = "https://www.google.com/search?q=";

let _browser = null;

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });
  return _browser;
}

/**
 * Main Fallback Function
 */
export async function browserSearch({ siteUrl, query, logger }) {
  const domain = new URL(siteUrl).hostname.replace("www.", "");
  const fullSearchQuery = `${domain} ${query}`;
  const startTime = Date.now();
  
  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();

    // 1. Search Google
    logger.info({ fullSearchQuery }, "[browser-search] Querying Google");
    await page.goto(`${SEARCH_ENGINE_URL}${encodeURIComponent(fullSearchQuery)}`, {
      waitUntil: "domcontentloaded",
      timeout: 4000
    });

    // 2. Extract first result matching domain
    const targetLink = await page.evaluate((targetDomain) => {
      const links = Array.from(document.querySelectorAll("a"));
      for (const link of links) {
        const href = link.href;
        // Avoid ads or Google internal links
        if (href.includes(targetDomain) && !href.includes("google.com") && !href.includes("webcache")) {
          return href;
        }
      }
      return null;
    }, domain);

    if (!targetLink) throw new Error(`No results for ${domain} found on Google`);

    // 3. Visit the product page
    logger.info({ targetLink }, "[browser-search] Visiting direct link");
    await page.goto(targetLink, { waitUntil: "domcontentloaded", timeout: 4000 });

    // 4. Universal Extraction Logic (No hardcoding)
    const productData = await page.evaluate(() => {
      const findPrice = () => {
        // Regex for BGN, Euro, USD, and generic digits
        const priceRegex = /([0-9]{1,6}[.,][0-9]{2})\s?(лв|lv|BGN|€|\$)/i;
        const text = document.body.innerText;
        const match = text.match(priceRegex);
        return match ? match[0] : null;
      };

      const getAvailability = () => {
        const text = document.body.innerText.toLowerCase();
        if (text.includes("в наличност") || text.includes("in stock")) return "In Stock";
        if (text.includes("изчерпан") || text.includes("out of stock")) return "Out of Stock";
        return "Check Site";
      };

      return {
        title: document.querySelector("h1")?.innerText?.trim() || document.title,
        price: findPrice(),
        description: document.querySelector('meta[name="description"]')?.content || "",
        availability: getAvailability()
      };
    });

    return {
      ok: true,
      results: [{
        url: targetLink,
        title: productData.title,
        price: productData.price,
        snippet: productData.description,
        availability: productData.availability,
        source: "live_fallback"
      }],
      elapsed_ms: Date.now() - startTime
    };

  } catch (err) {
    logger.error({ error: err.message }, "[browser-search] Fallback failed");
    return { ok: false, results: [], reason: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

export async function browserSearchWithRetry(opts) {
  const firstAttempt = await browserSearch(opts);
  if (firstAttempt.ok && firstAttempt.results.length > 0) return firstAttempt;
  
  opts.logger.warn("[browser-search] Retry 1 triggered");
  return await browserSearch(opts);
}

export async function closeBrowser() {
  if (_browser) await _browser.close();
}
