import { chromium } from "playwright";

const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || 20000);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 10000);
const MAX_PRODUCT_VISITS = Number(process.env.MAX_PRODUCT_VISITS || 3);

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

function safeDomain(siteUrl) {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function buildExcerpt(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 1200);
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
    };
  }

  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(
    `site:${domain} ${query}`
  )}`;

  let context = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    logger?.info?.({ searchUrl, domain, query }, "[browser-search] bing search start");

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TIMEOUT_MS,
    });

    const links = await page.$$eval(
      "li.b_algo h2 a",
      (anchors, expectedDomain) => {
        return anchors
          .map((a) => a.href)
          .filter((href) => {
            try {
              const url = new URL(href);
              return (
                url.hostname === expectedDomain ||
                url.hostname === `www.${expectedDomain}` ||
                url.hostname.endsWith(`.${expectedDomain}`)
              );
            } catch {
              return false;
            }
          })
          .slice(0, 5);
      },
      domain
    );

    if (!links.length) {
      return {
        ok: false,
        results: [],
        reason: "no_links_found_on_bing",
        elapsed_ms: Date.now() - startedAt,
      };
    }

    const results = [];

    for (const link of links) {
      if (results.length >= MAX_PRODUCT_VISITS) break;

      const detailPage = await context.newPage();
      detailPage.setDefaultTimeout(PAGE_TIMEOUT_MS);

      try {
        await detailPage.goto(link, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        });

        const data = await detailPage.evaluate(() => {
          const title = document.title || "";
          const bodyText = document.body?.innerText || "";
          const h1 = document.querySelector("h1")?.textContent?.trim() || "";
          return {
            title,
            h1,
            text: bodyText,
          };
        });

        const excerpt = buildExcerpt(data.text);

        results.push({
          url: link,
          title: data.h1 || data.title || link,
          excerpts: excerpt ? [excerpt] : [],
          on_domain: true,
          source: "bing_fallback",
        });
      } catch (err) {
        logger?.warn?.(
          {
            link,
            error: err instanceof Error ? err.message : String(err),
          },
          "[browser-search] failed to inspect result page"
        );
      } finally {
        await detailPage.close().catch(() => {});
      }
    }

    return {
      ok: results.length > 0,
      results,
      reason: results.length > 0 ? null : "no_extractable_results",
      elapsed_ms: Date.now() - startedAt,
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
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

export async function browserSearchWithRetry(opts) {
  return browserSearch(opts);
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
