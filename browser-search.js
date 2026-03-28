/**
 * browser-search.js — Production Live Fallback
 * Strategy: Google Search (Domain-Restricted) -> Universal Extraction
 */
import { chromium } from "playwright";

const SEARCH_ENGINE_URL = "https://www.google.com/search?q=";
const BROWSER_TIMEOUT_MS = 8000;

let _browser = null;

async function getBrowser() {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  return _browser;
}

export async function browserSearch({ siteUrl, query, logger }) {
  const domain = new URL(siteUrl).hostname.replace("www.", "");
  const fullSearchQuery = `${domain} ${query}`;
  const startTime = Date.now();
  
  let context = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    // 1. Search Google with domain constraint
    logger.info({ fullSearchQuery }, "[browser-search] querying google");
    await page.goto(`${SEARCH_ENGINE_URL}${encodeURIComponent(fullSearchQuery)}`, {
      waitUntil: "domcontentloaded",
      timeout: 4000
    });

    // 2. Identify the first relevant organic result for the domain
    const targetLink = await page.evaluate((targetDomain) => {
      const links = Array.from(document.querySelectorAll("a"));
      for (const link of links) {
        const href = link.href;
        if (href.includes(targetDomain) && !href.includes("google.com")) return href;
      }
      return null;
    }, domain);

    if (!targetLink) throw new Error(`No domain matches found for ${domain}`);

    // 3. Visit the product page
    logger.info({ targetLink }, "[browser-search] visiting result");
    await page.goto(targetLink, { waitUntil: "domcontentloaded", timeout: 4000 });

    // 4. Extract data using universal heuristics
    const product = await page.evaluate(() => {
      const findPrice = () => {
        // Regex handles: 12.99 лв, 12,99lv, 1200 BGN, etc.
        const regex = /([0-9]+[.,][0-9]{2})\s?(лв|lv|BGN|€|\$)/i;
        const text = document.body.innerText;
        const match = text.match(regex);
        return match ? match[0] : null;
      };

      return {
        title: document.querySelector("h1")?.innerText?.trim() || document.title,
        price: findPrice(),
        description: document.querySelector('meta[name="description"]')?.content || "",
        availability: document.body.innerText.toLowerCase().includes("наличност") || 
                      document.body.innerText.toLowerCase().includes("stock") ? "In Stock" : "Check website"
      };
    });

    return {
      ok: true,
      results: [{
        url: targetLink,
        title: product.title,
        price: product.price,
        snippet: product.description,
        availability: product.availability,
        source: "live_fallback"
      }],
      elapsed_ms: Date.now() - startTime
    };

  } catch (err) {
    logger.error({ error: err.message }, "[browser-search] failed");
    return { ok: false, results: [], reason: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

export async function browserSearchWithRetry(opts) {
  const attempt1 = await browserSearch(opts);
  if (attempt1.ok) return attempt1;
  opts.logger.warn("[browser-search] retrying...");
  return await browserSearch(opts);
}

export async function closeBrowser() {
  if (_browser) await _browser.close();
}
