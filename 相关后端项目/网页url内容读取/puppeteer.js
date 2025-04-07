const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const port = 46799;

app.use(express.json());

app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // 禁用沙盒
    });

    const page = await browser.newPage();

    await page.goto(url, { waitUntil: 'networkidle2' });

    const data = await page.evaluate(() => {
      return {
        title: document.title,
        content: document.body.innerText,
        links: Array.from(document.querySelectorAll('a')).map(a => a.href),
      };
    });

    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while scraping the page' });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// 启动服务器
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});