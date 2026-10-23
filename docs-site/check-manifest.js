#!/usr/bin/env node
// 文档清单校验（docs:manifest）：清单 = docs-site/manifest.js 为唯一事实源。
//   1. docs/*.md（除 README.md）↔ KB_FILES 双向一致（漏登记 / 清单过期都报错）
//   2. ccdocs/*.md ↔ REF_FILES 双向一致
//   3. docs-site/mkdocs.yml 的 nav 与清单一致（kb/ 与 reference/ 条目集合）
// 用法：node docs-site/check-manifest.js [--check-nav]（默认同时检查 nav）
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');

const { KB_FILES, REF_FILES } = require('./manifest');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function listMd(rel) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

/** 双向比对：磁盘 - 清单 = 漏登记；清单 - 磁盘 = 清单过期 */
function compare(label, disk, listed) {
  const diskSet = new Set(disk);
  const listedSet = new Set(listed);
  for (const name of diskSet) {
    if (!listedSet.has(name)) problems.push(`${label}：磁盘有但清单未登记 —— ${name}.md`);
  }
  for (const name of listedSet) {
    if (!diskSet.has(name)) problems.push(`${label}：清单有但磁盘不存在 —— ${name}.md`);
  }
}

compare('docs/', listMd('docs').filter((n) => n !== 'README'), KB_FILES);
compare('ccdocs/', listMd('ccdocs'), REF_FILES);

// nav 校验：收集 mkdocs.yml nav 里所有以 .md 结尾的路由
function collectNavRoutes(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectNavRoutes(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectNavRoutes(value, out);
    return out;
  }
  if (typeof node === 'string' && /\.md$/.test(node)) out.push(node);
  return out;
}

const mkdocsPath = path.join(ROOT, 'docs-site', 'mkdocs.yml');
if (fs.existsSync(mkdocsPath)) {
  // 只解析 nav 段：整份 mkdocs.yml 含 MkDocs 专有的 !!python/name: 标签，js-yaml 不支持
  const ymlText = fs.readFileSync(mkdocsPath, 'utf8');
  const navMatch = ymlText.match(/^nav:\s*\r?\n([\s\S]*)$/m);
  const config = navMatch ? YAML.load(`nav:\n${navMatch[1]}`) : { nav: [] };
  const routes = new Set(collectNavRoutes(config.nav || [], []));
  for (const name of KB_FILES) {
    if (!routes.has(`kb/${name}.md`)) problems.push(`mkdocs nav：缺少 kb/${name}.md（清单已登记）`);
  }
  for (const name of REF_FILES) {
    if (!routes.has(`reference/${name}.md`)) problems.push(`mkdocs nav：缺少 reference/${name}.md（清单已登记）`);
  }
  // 反向：nav 里有、清单没有 → 过期导航（固定页面 index/guide/reference 索引除外）
  const fixed = new Set(['index.md', 'guide/index.md', 'kb/index.md', 'reference/index.md']);
  const listed = new Set([...KB_FILES.map((n) => `kb/${n}.md`), ...REF_FILES.map((n) => `reference/${n}.md`)]);
  for (const route of routes) {
    if (!fixed.has(route) && !listed.has(route)) {
      problems.push(`mkdocs nav：多余条目 ${route}（清单未登记）`);
    }
  }
}

if (problems.length) {
  console.error('[FAIL] 文档清单与磁盘 / mkdocs nav 不一致：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n修复：编辑 docs-site/manifest.js 与 docs-site/mkdocs.yml（清单是唯一事实源）');
  process.exit(1);
}
console.log(`[OK] 文档清单一致：kb ${KB_FILES.length} 篇 / reference ${REF_FILES.length} 篇（含 mkdocs nav）`);
