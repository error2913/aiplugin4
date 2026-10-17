#!/usr/bin/env node
/**
 * 校验构建产物里的站内链接与锚点是否都能解析。
 *
 * 主要盯两件事：
 *   1. README 的 53 条 `#中文标题` 目录链接在站点里是否仍然有效
 *      （MkDocs 默认 slugify 会把中文标题变成 _1/_2，那样整个目录就废了）；
 *   2. 分区重排（guide/ kb/ reference/）后跨分区相对链接有没有指错。
 *
 * 用法：node docs-site/check-links.js   （先跑 mkdocs build）
 */

const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, 'site');
const failures = [];
const upstream = []; // reference/ 第三方存档自身的链接问题，不算本站回归
const stats = { pages: 0, links: 0, anchors: 0 };

/**
 * 第三方存档（reference/）里的链接指向 Anthropic 官网，页内锚点也是
 * 官方文档的锚点，跑到本站自然会“失效”。这些属于上游噪音，单独统计，
 * 不让它们淹没本项目自己的文档回归。
 */
function isUpstreamPage(rel) {
  return rel.split(path.sep)[0] === 'reference';
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** 从一个 html 文件收集它定义的锚点 id。 */
function anchorsOf(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

/** 把链接目标解析成磁盘路径。 */
function resolveTarget(pageFile, href) {
  let clean = href.split('#')[0].split('?')[0];
  if (!clean) return pageFile; // 纯 #锚点
  if (/^[a-z]+:/i.test(clean) || clean.startsWith('//')) return null; // 外链

  // HTML 里的中文路径是百分号编码的，落到磁盘前要先解码
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* 编码不合法就按原样处理 */
  }

  const abs = clean.startsWith('/')
    ? path.join(SITE, clean)
    : path.resolve(path.dirname(pageFile), clean);

  // MkDocs 默认 use_directory_urls：kb/x.md -> kb/x/index.html，
  // 所以 href 末尾带 "/" 或指向目录时要补上 index.html。
  if (abs.endsWith(path.sep) || abs.endsWith('/')) {
    return path.join(abs, 'index.html');
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return path.join(abs, 'index.html');
  }
  // 无扩展名的裸路由（如 kb/01-项目概览）同样补 index.html
  if (!path.extname(abs) && fs.existsSync(abs + path.sep)) {
    return path.join(abs, 'index.html');
  }
  return abs;
}

function main() {
  if (!fs.existsSync(SITE)) {
    console.error('找不到构建产物 docs-site/site，请先运行 mkdocs build。');
    process.exit(1);
  }

  const pages = walk(SITE);
  const anchorCache = new Map();
  const getAnchors = (f) => {
    if (!anchorCache.has(f)) anchorCache.set(f, anchorsOf(fs.readFileSync(f, 'utf8')));
    return anchorCache.get(f);
  };

  for (const page of pages) {
    stats.pages++;
    const rel = path.relative(SITE, page);
    const sink = isUpstreamPage(rel) ? upstream : failures;
    const html = fs.readFileSync(page, 'utf8');
    // 只看正文区域，跳过 Material 自带的导航/页脚链接
    const main = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
    const body = main ? main[1] : html;

    for (const m of body.matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      stats.links++;
      const target = resolveTarget(page, href);
      if (target === null) continue;

      if (!fs.existsSync(target)) {
        sink.push(`死链  ${rel} -> ${href}`);
        continue;
      }

      const hash = href.includes('#') ? href.split('#')[1] : '';
      if (hash) {
        stats.anchors++;
        if (!getAnchors(target).has(hash)) {
          sink.push(`缺锚点  ${rel} -> ${href}`);
        }
      }
    }
  }

  console.log(
    `检查 ${stats.pages} 个页面、${stats.links} 条链接（其中 ${stats.anchors} 条带锚点）`,
  );
  if (upstream.length) {
    console.log(
      `（另有 ${upstream.length} 处位于 reference/ 第三方存档内部，属上游原有问题，未计入）`,
    );
  }

  if (failures.length) {
    console.error(`\n发现 ${failures.length} 处问题：`);
    for (const f of failures.slice(0, 40)) console.error('  ' + f);
    if (failures.length > 40) console.error(`  …还有 ${failures.length - 40} 处`);
    process.exit(1);
  }
  console.log('站内链接与锚点全部有效 ✅');
}

main();
