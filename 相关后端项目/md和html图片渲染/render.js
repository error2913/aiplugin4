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

// JSON 解析中间件，添加错误处理
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

async function ensureImageDir() {
    try {
        await fs.access(IMAGE_DIR);
    } catch {
        await fs.mkdir(IMAGE_DIR, { recursive: true });
    }
}

function generateImageId() {
    return crypto.randomBytes(16).toString('hex');
}

function detectContentType(content) {
    const htmlPattern = /<(?:html|head|body|div|p|h[1-6]|table|ul|ol|li|span|a)\b[^>]*>/i;
    return htmlPattern.test(content) ? 'html' : 'markdown';
}

// HTML模板
function generateHTML(content, contentType = 'auto', theme = 'light', style = 'github') {
    if (contentType === 'auto') {
        contentType = detectContentType(content);
    }
    
    const bodyContent = contentType === 'markdown' ? marked(content) : content;
    
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
        
        h1:first-child, h2:first-child, h3:first-child {
            margin-top: 0;
        }
        
        h1 {
            font-size: 2em;
            border-bottom: 1px solid ${selectedTheme.border};
            padding-bottom: 0.3em;
        }
        
        h2 {
            font-size: 1.5em;
            border-bottom: 1px solid ${selectedTheme.border};
            padding-bottom: 0.3em;
        }
        
        h3 { font-size: 1.25em; }
        h4 { font-size: 1em; }
        h5 { font-size: 0.875em; }
        h6 { font-size: 0.85em; }
        
        p {
            margin-bottom: 16px;
            color: ${selectedTheme.text};
        }
        
        strong, b {
            font-weight: 600;
            color: ${selectedTheme.text};
        }
        
        em, i {
            font-style: italic;
        }
        
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
        
        pre code {
            background: none;
            padding: 0;
            border: none;
            font-size: 0.9em;
            line-height: 1.45;
        }
        
        blockquote {
            border-left: 4px solid ${selectedTheme.border};
            padding-left: 16px;
            margin: 16px 0;
            color: ${selectedTheme.blockquote_text};
        }
        
        blockquote > :first-child {
            margin-top: 0;
        }
        
        blockquote > :last-child {
            margin-bottom: 0;
        }
        
        ul, ol {
            margin-bottom: 16px;
            padding-left: 2em;
        }
        
        li {
            margin-bottom: 8px;
            color: ${selectedTheme.text};
        }
        
        li > p {
            margin-bottom: 8px;
        }
        
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
        
        th {
            background: ${selectedTheme.code_bg};
            font-weight: 600;
        }
        
        a {
            color: #58a6ff;
            text-decoration: none;
        }
        
        a:hover {
            text-decoration: underline;
        }
        
        img {
            max-width: 100%;
            height: auto;
        }
        
        hr {
            border: none;
            border-top: 1px solid ${selectedTheme.border};
            margin: 24px 0;
            background: none;
            height: 1px;
        }
        
        /* KaTeX 样式 */
        .katex {
            font-size: 1.1em;
        }
        
        .katex-display {
            margin: 1em 0;
            overflow-x: auto;
            overflow-y: hidden;
        }
        
        /* 任务列表 */
        input[type="checkbox"] {
            margin-right: 0.5em;
        }
        
        /* 删除线 */
        del {
            text-decoration: line-through;
            opacity: 0.7;
        }
    </style>
</head>
<body>
    <div class="container">
        ${bodyContent}
    </div>
</body>
</html>
    `;
}

// 渲染内容为图片
async function renderToImage(content, options = {}) {
    const {
        contentType = 'auto',
        theme = 'light',
        style = 'github',
        width = 1200,
        quality = 90
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
            height: 600,
            deviceScaleFactor: 2  
        });

        const html = generateHTML(content, contentType, theme, style);
        await page.setContent(html, { 
            waitUntil: 'networkidle0',
            timeout: 30000
        });

        await new Promise(r => setTimeout(r, 500));

        const dimensions = await page.evaluate(() => {
            const container = document.querySelector('.container');
            return {
                width: container.offsetWidth,
                height: container.offsetHeight
            };
        });

        const actualWidth = dimensions.width + 80; 
        const actualHeight = dimensions.height + 80;

        await page.setViewport({ 
            width: actualWidth, 
            height: actualHeight,
            deviceScaleFactor: 2
        });

        const imageId = generateImageId();
        const fileName = `${imageId}.png`;
        const filePath = path.join(IMAGE_DIR, fileName);

        await page.screenshot({
            path: filePath,
            type: 'png',
            omitBackground: false
        });

        return { imageId, fileName, filePath };
    } finally {
        await browser.close();
    }
}

// API端点

app.get('/themes', (req, res) => {
    res.json({
        themes: ['light', 'dark', 'gradient'],
        contentTypes: ['auto', 'markdown', 'html'],
        default: {
            theme: 'light',
            contentType: 'auto'
        }
    });
});

app.post('/render', async (req, res) => {
    try {
        const { 
            content,
            markdown,
            html,
            contentType = 'auto',
            theme = 'light',
            width = 1200,
            quality = 90
        } = req.body;

        const inputContent = content || markdown || html;

        if (!inputContent) {
            return res.status(400).json({
                status: 'error',
                message: 'Content is required (use "content", "markdown", or "html" field)'
            });
        }

        await ensureImageDir();

        const result = await renderToImage(inputContent, {
            contentType,
            theme,
            width,
            quality
        });

        const imageUrl = `${req.protocol}://${req.get('host')}/images/${result.fileName}`;

        const detectedType = contentType === 'auto' 
            ? detectContentType(inputContent) 
            : contentType;

        res.json({
            status: 'success',
            imageId: result.imageId,
            url: imageUrl,
            fileName: result.fileName,
            contentType: detectedType,
            theme: theme
        });
    } catch (error) {
        console.error('Render error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

app.delete('/images/:imageId', async (req, res) => {
    try {
        const { imageId } = req.params;
        const filePath = path.join(IMAGE_DIR, `${imageId}.png`);

        await fs.unlink(filePath);

        res.json({
            status: 'success',
            message: 'Image deleted successfully'
        });
    } catch (error) {
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