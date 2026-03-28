const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = 3210;

app.post('/search', async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.status(400).json({ error: "Missing search query" });
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
            ]
        });

        const page = await browser.newPage();
        
        // Настройка на език и регион за по-малко проверки
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
        console.log(`Searching Bing for: ${query}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Изчакване на резултатите да се заредят
        await page.waitForSelector('#b_results', { timeout: 10000 });

        const results = await page.evaluate(() => {
            const items = [];
            // Bing използва класа .b_algo за органичните резултати
            document.querySelectorAll('.b_algo').forEach((el) => {
                const titleEl = el.querySelector('h2 a');
                const snippetEl = el.querySelector('.b_caption p') || el.querySelector('.b_lineclamp2');
                
                if (titleEl) {
                    items.push({
                        title: titleEl.innerText,
                        link: titleEl.href,
                        snippet: snippetEl ? snippetEl.innerText : ""
                    });
                }
            });
            return items;
        });

        res.json({ success: true, count: results.length, data: results });

    } catch (error) {
        console.error("Worker Error:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Neo Search Worker (Bing Edition) running on port ${PORT}`);
});
