const express = require('express');
const puppeteer = require('puppeteer');
const { marked } = require('marked');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const port = 37632;

// 配置 marked 选项
marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: true,
    mangle: false,
    pedantic: false,
    sanitize: false,
    smartLists: true,
    smartypants: false
});

// JSON 解析中间件
app.use(express.json({
    limit: '10mb',
    strict: false
}));

// 错误处理中间件
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('JSON 解析错误:', err.message);
        return res.status(400).json({
            status: 'error',
            message: 'Invalid JSON format: ' + err.message
        });
    }
    next(err);
});

app.use('/images', express.static('generated_images'));

const IMAGE_DIR = path.join(__dirname, 'generated_images');

function generateImageId() {
    return crypto.randomBytes(16).toString('hex');
}

// HTML模板
function generateHTML(content, contentType, theme = 'light', style = 'github') {
let bodyContent = content;

    if (contentType === 'markdown') {
        const mathBlocks = [];
        
        bodyContent = bodyContent.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
            const id = mathBlocks.length;
            mathBlocks.push(match); 
            return `%%%MATH_BLOCK_${id}%%%`;
        });

        bodyContent = bodyContent.replace(/\$([^\$\n]+?)\$/g, (match) => {
            const id = mathBlocks.length;
            mathBlocks.push(match);
            return `%%%MATH_BLOCK_${id}%%%`;
        });
        
        bodyContent = bodyContent.replace(/\\\[([\s\S]+?)\\\]/g, (match) => {
            const id = mathBlocks.length;
            mathBlocks.push(match);
            return `%%%MATH_BLOCK_${id}%%%`;
        });

        bodyContent = marked(bodyContent);

        bodyContent = bodyContent.replace(/%%%MATH_BLOCK_(\d+)%%%/g, (match, id) => {
            return mathBlocks[parseInt(id)];
        });
    }

    const themes = {
        light: {
            bg: '#ffffff',
            text: '#24292e',
            border: '#e1e4e8',
            code_bg: '#f6f8fa',
            blockquote_text: '#6a737d'
        },
        dark: {
            bg: '#0d1117',
            text: '#c9d1d9',
            border: '#30363d',
            code_bg: '#161b22',
            blockquote_text: '#8b949e'
        },
        gradient: {
            bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            text: '#ffffff',
            border: 'rgba(255,255,255,0.2)',
            code_bg: 'rgba(0,0,0,0.2)',
            blockquote_text: 'rgba(255,255,255,0.8)'
        }
    };

    const selectedTheme = themes[theme] || themes.light;

    if (contentType === 'markdown') {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" 
            onload="renderMathInElement(document.body, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false},
                    {left: '\\\\[', right: '\\\\]', display: true},
                    {left: '\\\\(', right: '\\\\)', display: false}
                ],
            ignoredTags: ['script', 'noscript', 'style', 'textarea'],
            trust: true,
            throwOnError: false
            });"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            background: ${selectedTheme.bg};
            color: ${selectedTheme.text};
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
            padding: 40px 20px;
            line-height: 1.6;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: flex-start;
        }
        
        .container {
            width: 100%;
            max-width: 900px;
            background: ${theme === 'gradient' ? 'rgba(255,255,255,0.1)' : selectedTheme.bg};
            padding: 40px;
            border-radius: 12px;
            ${theme !== 'gradient' ? `border: 1px solid ${selectedTheme.border};` : ''}
            backdrop-filter: blur(10px);
            word-wrap: break-word;
            overflow-wrap: break-word;
        }
        
        h1, h2, h3, h4, h5, h6 {
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
            line-height: 1.25;
            color: ${selectedTheme.text};
        }
        h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
        h1 { font-size: 2em; border-bottom: 1px solid ${selectedTheme.border}; padding-bottom: 0.3em; }
        h2 { font-size: 1.5em; border-bottom: 1px solid ${selectedTheme.border}; padding-bottom: 0.3em; }
        h3 { font-size: 1.25em; }
        h4 { font-size: 1em; }
        h5 { font-size: 0.875em; }
        h6 { font-size: 0.85em; }
        p { margin-bottom: 16px; color: ${selectedTheme.text}; }
        strong, b { font-weight: 600; color: ${selectedTheme.text}; }
        em, i { font-style: italic; }
        code {
            background: ${selectedTheme.code_bg};
            padding: 0.2em 0.4em;
            border-radius: 3px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 0.85em;
            color: ${selectedTheme.text};
            border: 1px solid ${selectedTheme.border};
        }
        pre {
            background: ${selectedTheme.code_bg};
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            margin-bottom: 16px;
            border: 1px solid ${selectedTheme.border};
        }
        pre code { background: none; padding: 0; border: none; font-size: 0.9em; line-height: 1.45; }
        blockquote {
            border-left: 4px solid ${selectedTheme.border};
            padding-left: 16px;
            margin: 16px 0;
            color: ${selectedTheme.blockquote_text};
        }
        blockquote > :first-child { margin-top: 0; }
        blockquote > :last-child { margin-bottom: 0; }
        ul, ol { margin-bottom: 16px; padding-left: 2em; }
        li { margin-bottom: 8px; color: ${selectedTheme.text}; }
        li > p { margin-bottom: 8px; }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-bottom: 16px;
            display: block;
            overflow-x: auto;
        }
        th, td {
            border: 1px solid ${selectedTheme.border};
            padding: 8px 12px;
            text-align: left;
            color: ${selectedTheme.text};
        }
        th { background: ${selectedTheme.code_bg}; font-weight: 600; }
        a { color: #58a6ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        img { max-width: 100%; height: auto; }
        hr {
            border: none;
            border-top: 1px solid ${selectedTheme.border};
            margin: 24px 0;
            background: none;
            height: 1px;
        }
        .katex { font-size: 1.1em; }
        .katex-display { margin: 1em 0; overflow-x: auto; overflow-y: hidden; }
        input[type="checkbox"] { margin-right: 0.5em; }
        del { text-decoration: line-through; opacity: 0.7; }
    </style>
</head>
<body>
    <div class="container">
        ${bodyContent}
    </div>
</body>
</html>
    `;
    } else {
        // 移除所有外层样式，让传入的 HTML 自行决定外观，但是不传外层样式的时候是不是太怪了
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" 
            onload="renderMathInElement(document.body, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false},
                    {left: '\\\\[', right: '\\\\]', display: true},
                    {left: '\\\\(', right: '\\\\)', display: false}
                ],
                throwOnError: false
            });"></script>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            background: #ffffff; 
        }
        body {
            display: inline-block; 
            min-width: 1px;
        }
    </style>
</head>
<body>
    ${bodyContent}
</body>
</html>
    `;
    }
}

// 渲染内容为图片
async function renderToImage(content, options = {}) {
    const {
        contentType,
        theme = 'light',
        style = 'github',
        width = 1200, 
        quality = 90,
        hasImages = false
    } = options;

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security'
        ]
    });

    try {
        const page = await browser.newPage();

        await page.setViewport({
            width,
            height: 3000,
            deviceScaleFactor: 2
        });

        const html = generateHTML(content, contentType, theme, style);
        
        // 如果有图片，增加超时时间（图片加载需要更长时间）
        const timeout = hasImages ? 60000 : 30000;
        
        await page.setContent(html, {
            waitUntil: 'networkidle0',
            timeout: timeout
        });

        await new Promise(r => setTimeout(r, 1500)); 

        const imageId = generateImageId();

        let clip;
        let omitBackground = false;

        if (contentType === 'markdown') {
            clip = await page.evaluate(() => {
                const container = document.querySelector('.container');
                if (!container) return null;
                const rect = container.getBoundingClientRect();
                return {
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height
                };
            });

            if (!clip) {
                throw new Error('Could not find .container element for Markdown rendering.');
            }
            omitBackground = false; 

        } else {
            clip = await page.evaluate(() => {
                const body = document.body;
                return {
                    x: 0,
                    y: 0,
                    width: body.scrollWidth,
                    height: body.scrollHeight
                };
            });
            omitBackground = false; 
        }

        let base64;
        if (!clip || clip.width === 0 || clip.height === 0) {
            console.warn('Clipping failed, screenshotting full page as fallback.');
            base64 = await page.screenshot({
                type: 'png',
                omitBackground: omitBackground,
                fullPage: true,
                encoding: 'base64'
            });
        } else {
            base64 = await page.screenshot({
                type: 'png',
                omitBackground: omitBackground,
                clip: {
                    x: clip.x,
                    y: clip.y,
                    width: Math.ceil(clip.width),
                    height: Math.ceil(clip.height)
                },
                encoding: 'base64'
            });
        }

        return { imageId, base64 };
    } finally {
        await browser.close();
    }
}

// 渲染 Markdown 
app.post('/render/markdown', async (req, res) => {
    try {
        const { markdown, theme = 'light', width = 1200, quality = 90, hasImages = false } = req.body;
        if (!markdown) {
            return res.status(400).json({ status: 'error', message: 'Field "markdown" is required' });
        }

        const result = await renderToImage(markdown, {
            contentType: 'markdown', 
            theme,
            width,
            quality,
            hasImages
        });

        res.json({
            status: 'success',
            imageId: result.imageId,
            base64: result.base64,
            contentType: 'markdown',
            theme
        });
    } catch (error) {
        console.error('Render markdown error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 渲染 HTML
app.post('/render/html', async (req, res) => {
    try {
        const { html, width = 1200, quality = 90, hasImages = false } = req.body;
        if (!html) {
            return res.status(400).json({ status: 'error', message: 'Field "html" is required' });
        }

        const result = await renderToImage(html, {
            contentType: 'html', 
            width,
            quality,
            hasImages
        });

        res.json({
            status: 'success',
            imageId: result.imageId,
            base64: result.base64,
            contentType: 'html'
        });
    } catch (error) {
        console.error('Render html error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.delete('/images/:imageId', async (req, res) => {
    try {
        const { imageId } = req.params;
        const safeImageId = path.basename(imageId);
        if (safeImageId !== imageId) {
             return res.status(400).json({ status: 'error', message: 'Invalid image ID' });
        }
        
        const filePath = path.join(IMAGE_DIR, `${safeImageId}.png`);

        await fs.unlink(filePath);

        res.json({
            status: 'success',
            message: 'Image deleted successfully'
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ status: 'error', message: 'Image not found' });
        }
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(port, () => {
    console.log(`Content renderer service running on http://localhost:${port}`);
    console.log(`Supports: Markdown, HTML, LaTeX formulas`);
    console.log(`Themes: light, dark, gradient`);
});