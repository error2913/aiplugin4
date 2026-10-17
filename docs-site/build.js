#!/usr/bin/env node
/**
 * 构建文档站：生成 site-src/ → mkdocs build --strict → 站内链接自检。
 *
 * 为什么要这个包装脚本（而不是直接在 package.json 里串命令）：
 *   mkdocs.yml 用 `!!python/name:hooks_cjk_slug.slugify` 指定自定义 slugify，
 *   该模块必须能被 Python import。MkDocs 解析配置发生在加载 hook 之前，
 *   所以不能靠 hooks: 把自己塞进 sys.modules —— 只能提前把 docs-site/
 *   放进 PYTHONPATH。在 npm script 里跨平台设置环境变量很难看，这里用
 *   Node 设好再 spawn 子进程，Windows / Linux 行为一致。
 *
 * 用法：
 *   node docs-site/build.js            # 构建 + 自检
 *   node docs-site/build.js --serve    # 启动本地预览（改文档即时刷新）
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SITE_DIR = __dirname;
const serve = process.argv.includes('--serve');

const env = { ...process.env };
// 让 hooks_cjk_slug 可被 import；保留调用方已有的 PYTHONPATH
env.PYTHONPATH = env.PYTHONPATH
  ? `${SITE_DIR}${path.delimiter}${env.PYTHONPATH}`
  : SITE_DIR;

function run(cmd, args, opts = {}) {
  // Windows 上 node/python 可能是 .cmd 包装，需要 shell；此时不要传 args
  // （Node 会为 shell:true + args 报 DEP0190），改为拼一条命令行字符串。
  const useShell = process.platform === 'win32';
  const r = useShell
    ? spawnSync([cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), {
        stdio: 'inherit',
        env,
        cwd: opts.cwd || SITE_DIR,
        shell: true,
      })
    : spawnSync(cmd, args, {
        stdio: 'inherit',
        env,
        cwd: opts.cwd || SITE_DIR,
      });
  if (r.error) {
    console.error(`执行失败：${cmd} ${args.join(' ')}`);
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. 汇总源文档到 site-src/
run('node', [path.join(SITE_DIR, 'build-site-src.js')], {
  cwd: path.resolve(SITE_DIR, '..'),
});

// 2. 构建（--serve 时起本地预览服务器）
run('python', ['-m', 'mkdocs', serve ? 'serve' : 'build', ...(serve ? [] : ['--strict'])]);

// 3. 站内链接与锚点自检（serve 模式跳过，产物还没最终生成）
if (!serve) {
  run('node', [path.join(SITE_DIR, 'check-links.js')], {
    cwd: path.resolve(SITE_DIR, '..'),
  });
}
