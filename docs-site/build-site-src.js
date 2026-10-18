#!/usr/bin/env node
/**
 * 把仓库里的 Markdown 汇总成 MkDocs 能用的 site-src/ 目录。
 *
 * 为什么不直接把 docs_dir 指向仓库根：
 *   1. `docs/` 与 `ccdocs/` 是两个分区，仓库根做 docs_dir 会把 src/、tools/ 等
 *      目录一起扫进来，还得靠 exclude_docs 逐个排除，容易漏；
 *   2. `docs/*.md` 之间的相对链接是 `.md` 结尾，README 里的 `../README.md`
 *      指向仓库根之外 —— 集中到 site-src/ 后统一改成站内路由更可控。
 *
 * 本脚本只读取源文件，输出全部落在 docs-site/site-src/（已 gitignore），
 * 不改动 docs/、README.md、ccdocs/ 任何一个字节。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'site-src');
const DOCS_OUT = path.join(OUT, 'kb');
const GUIDE_OUT = path.join(OUT, 'guide');
const REF_OUT = path.join(OUT, 'reference');

/** 源码类链接在站点里指回 GitHub。 */
const REPO_BLOB = 'https://github.com/error2913/aiplugin4/blob/main';

/** 文档源文件名 → 站内路由。显式列出，避免自动扫描把非文档 md 收进来。 */
const KB_FILES = [
  '01-项目概览',
  '02-架构设计',
  '03-核心模块详解',
  '04-工具系统',
  '05-命令与配置',
  '06-数据存储',
  '07-开发指南',
  '08-相关后端项目',
  '09-注意事项与常见问题',
  '10-TODO',
  '11-ob11-core-bridge-使用指南',
  '16-图片生命周期与图床方案',
];

/** docs/README.md 在站内作为知识库索引页。 */
const KB_INDEX_SRC = 'docs/README.md';
const KB_INDEX_OUT = 'kb/index.md';

const REF_FILES = [
  'amazon-bedrock',
  'google-vertex-ai',
  'hooks',
  'mcp',
  'settings-reference',
  'third-party-integrations',
];

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function read(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`缺少源文件：${rel}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

function write(rel, content) {
  const abs = path.join(OUT, rel);
  mkdirp(path.dirname(abs));
  fs.writeFileSync(abs, content, 'utf8');
}

/**
 * 把围绕本仓库布局写的相对链接，改写成站内路由。
 * 只处理 .md 链接，外部 http(s) 与页内 #锚点原样保留。
 */
function rewriteLinks(md, currentDir) {
  let out = md.replace(
    /\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/g,
    (whole, target, anchor) => {
      const hash = anchor || '';

      // docs/README.md -> 知识库索引
      if (/^(\.\.\/)?README\.md$/.test(target)) {
        // docs/README.md 里的 ../README.md 指用户手册
        if (whole.includes('../README.md')) {
          return currentDir === 'guide' ? `](index.md${hash})` : `](../guide/index.md${hash})`;
        }
        return currentDir === 'kb' ? `](index.md${hash})` : `](../kb/index.md${hash})`;
      }

      // docs/xx.md -> kb/xx.md（含 15 号文档里 "docs/07-开发指南" 这种带前缀的写法）
      let m = target.match(/^(?:\.\.\/)?(?:docs\/)?(\d{2}-[^/]+)\.md$/);
      if (m) {
        // kb/ 内部互相引用用同级相对路径；从 guide/ 等其它分区引用要回到 kb/
        const isKb = currentDir === 'kb';
        return isKb
          ? `](${m[1]}.md${hash})`
          : `](../kb/${m[1]}.md${hash})`;
      }

      // ccdocs/xx.md -> reference/xx.md
      m = target.match(/^(?:\.\.\/)?(?:ccdocs\/)?([a-z0-9-]+)\.md$/);
      if (m && REF_FILES.includes(m[1])) return `](../reference/${m[1]}.md${hash})`;

      return whole;
    },
  );

  // 指向仓库里非文档文件的相对链接（源码、示例等）改成 GitHub 绝对地址，
  // 否则在站点里是死链。
  out = out.replace(/\]\(\.\.\/((?:examples|src|scripts|tools)\/[^)\s]+)\)/g,
    (whole, p) => `](${REPO_BLOB}/${p})`);

  return out;
}

function main() {
  rmrf(OUT);
  mkdirp(OUT);

  // ---- 站点自有页面（docs-site/ 下维护，非生成物） ----
  write('index.md', read('docs-site/index.md'));
  write('reference/index.md', read('docs-site/reference-index.md'));

  // mkdocs.yml 里的写成 !!python/name:hooks_cjk_slug.slugify，需要它在 Python
  // 的 import 路径上；构建工作目录是 docs-site/，这里顺手同步一份到 site-src/。
  fs.copyFileSync(
    path.join(__dirname, 'hooks_cjk_slug.py'),
    path.join(OUT, 'hooks_cjk_slug.py'),
  );

  // ---- 用户手册：README.md 整篇挂到 /guide/ ----
  write('guide/index.md', rewriteLinks(read('README.md'), 'guide'));

  // ---- 开发者知识库 ----
  write(KB_INDEX_OUT, rewriteLinks(read(KB_INDEX_SRC), 'kb'));
  for (const name of KB_FILES) {
    const src = `docs/${name}.md`;
    if (!fs.existsSync(path.join(ROOT, src))) {
      throw new Error(`缺少知识库文档：${src}`);
    }
    write(`kb/${name}.md`, rewriteLinks(read(src), 'kb'));
  }

  // ---- 第三方参考存档 ----
  for (const name of REF_FILES) {
    const src = `ccdocs/${name}.md`;
    if (!fs.existsSync(path.join(ROOT, src))) {
      throw new Error(`缺少参考文档：${src}`);
    }
    write(`reference/${name}.md`, rewriteLinks(read(src), 'reference'));
  }

  const count = (d) =>
    fs.existsSync(d)
      ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).length
      : 0;
  console.log(
    `已生成 site-src/：guide ${count(GUIDE_OUT)} 篇、kb ${count(DOCS_OUT)} 篇、reference ${count(REF_OUT)} 篇`,
  );
}

main();
