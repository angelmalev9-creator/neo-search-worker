import { chromium } from "playwright";

const BROWSER_TIMEOUT_MS = parseInt(process.env.BROWSER_TIMEOUT_MS || "20000", 10);
const MAX_PRODUCT_VISITS = 3;

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
  const elapsed = () => Date.now() - start;
  const start = Date.now();
  const domain = new URL(siteUrl).hostname.replace('www.', '');
  
  // Търсим в Bing само за конкретния домейн
  const searchUrl = `https://www.bing.com/search?q=site%3A${domain}+${encodeURIComponent(query)}`;
  
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    
    logger.info({ searchUrl }, "[browser-search] searching bing...");
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 10000 });

    // Екстрактваме първите няколко линка, които сочат към домейна
    const links = await page.$$eval('li.b_algo h2 a', (anchors, dom) => {
      return anchors
        .map(a => a.href)
        .filter(href => href.includes(dom))
        .slice(0, 3);
    }, domain);

    if (links.length === 0) {
      return { ok: false, results: [], reason: "no_links_found_on_bing" };
    }

    const results = [];
    // Обхождаме намерените страници за детайли
    for (const link of links) {
      if (results.length >= MAX_PRODUCT_VISITS) break;
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 7000 });
        const data = await page.evaluate(() => {
          const title = document.title || "";
          const text = document.body.innerText.slice(0, 1000); // Вземаме само началото за контекст
          return { title, text };
        });

        results.push({
          url: link,
          title: data.title,
          excerpts: [data.text],
          on_domain: true,
          source: "bing_fallback"
        });
      } catch (e) {
        continue;
      }
    }

    return { ok: results.length > 0, results, elapsed_ms: elapsed() };
  } catch (err) {
    logger.error({ error: err.message }, "[browser-search] failed");
    return { ok: false, results: [], reason: err.message };
  } finally {
    if (context) await context.close();
  }
}

export async function browserSearchWithRetry(opts) {
  return browserSearch(opts); // Опростено за бързина
}

export async function closeBrowser() {
  if (_browser) await _browser.close();
}
