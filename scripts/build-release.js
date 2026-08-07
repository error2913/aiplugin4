// 发布打包：产出三类发布物
//   1. dist/aiplugin4.js                  本体 JS（由 npm run build 生成）
//   2. dist/aiplugin4-<版本>.sealpack     只含本体的豹包
//   3. dist/aiplugin4-full-<版本>.sealpack 包含本体与依赖插件的完整豹包
// 依赖插件地址在 scripts/deps.cjs 中配置（当前为空，待补充）。
const { execFile, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'dist', 'aiplugin4.js');
const sealpackDir = path.join(root, 'sealpack');
const fullDir = path.join(root, 'sealpack-full');
const depsFile = path.join(__dirname, 'deps.cjs');

const FULL_PACKAGE_ID = 'error2913/aiplugin4-full';
const FULL_PACKAGE_NAME = 'AI骰娘4-扩展';
const FULL_PACKAGE_DESC = 'AI骰娘4 扩展包（完整包）：包含本体与依赖插件，安装即用';

function getVersion() {
  const src = fs.readFileSync(path.join(root, 'src', 'config', 'static_config.ts'), 'utf8');
  const m = src.match(/VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) {
    console.error('未能在 src/config/static_config.ts 中找到 VERSION');
    process.exit(1);
  }
  return m[1];
}

function run(cmd, cwd = root) {
  execSync(cmd, { stdio: 'inherit', cwd });
}

function downloadWithCurl(url) {
  return new Promise((resolve, reject) => {
    const args = ['-fsSL', '--max-time', '120'];
    // Windows 的 schannel 在部分网络下会因吊销检查失败，跳过吊销检查（证书链校验保留）
    if (process.platform === 'win32') args.push('--ssl-no-revoke');
    args.push(url);
    execFile('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function downloadWithNode(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'aiplugin4-release' } }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function download(url) {
  try {
    return await downloadWithCurl(url);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 环境没有 curl 时回退到 Node 内置 https
      return downloadWithNode(url);
    }
    throw e;
  }
}

async function main() {
  const version = getVersion();

  if (!fs.existsSync(bundle)) {
    console.error(`构建产物不存在: ${bundle}，请先执行 npm run build`);
    process.exit(1);
  }

  // 1. 准备本体 sealpack 源目录（同步版本、复制 main.js）
  console.log('[build-release] 准备本体豹包源...');
  run(`node "${path.join(__dirname, 'prepare-sealpack.js')}"`);

  // 2. 构建完整包源目录：复制本体内容 + 下载依赖插件
  console.log('[build-release] 准备完整豹包源...');
  fs.rmSync(fullDir, { recursive: true, force: true });
  fs.mkdirSync(fullDir, { recursive: true });
  for (const entry of fs.readdirSync(sealpackDir)) {
    fs.cpSync(path.join(sealpackDir, entry), path.join(fullDir, entry), { recursive: true });
  }

  const deps = require(depsFile).dependencies || [];
  if (deps.length === 0) {
    console.warn('[build-release] scripts/deps.cjs 未配置依赖插件，完整包暂只包含本体');
  } else {
    fs.mkdirSync(path.join(fullDir, 'scripts'), { recursive: true });
    for (const dep of deps) {
      if (!dep.url) {
        console.error(`依赖插件 ${dep.name || '?'} 缺少 url`);
        process.exit(1);
      }
      const base = path.basename(dep.url);
      const filename = (dep.filename || base).replace(/[^\w.-]/g, '_');
      if (!filename.endsWith('.js')) {
        console.error(`依赖插件 ${dep.name || filename} 的文件名必须为 .js 结尾，当前: ${filename}`);
        process.exit(1);
      }
      console.log(`[build-release] 下载依赖插件: ${dep.name || filename} <- ${dep.url}`);
      try {
        const content = await download(dep.url);
        fs.writeFileSync(path.join(fullDir, 'scripts', filename), content);
      } catch (e) {
        console.error(`下载依赖插件失败: ${dep.url}（${e instanceof Error ? e.message : String(e)}）`);
        process.exit(1);
      }
    }
  }

  // 3. 修改完整包元数据（独立包 id，避免与本体包在 SealRepo 冲突）
  const fullToml = path.join(fullDir, 'info.toml');
  const toml = fs.readFileSync(fullToml, 'utf8')
    .replace(/^id\s*=\s*".*"$/m, `id = "${FULL_PACKAGE_ID}"`)
    .replace(/^name\s*=\s*".*"$/m, `name = "${FULL_PACKAGE_NAME}"`)
    .replace(/^description\s*=\s*".*"$/m, `description = "${FULL_PACKAGE_DESC}"`);
  fs.writeFileSync(fullToml, toml);

  // 4. 校验并打包两个豹包
  console.log('[build-release] 校验并打包...');
  run('npx --no-install sealpack validate sealpack');
  run('npx --no-install sealpack validate sealpack-full');
  run(`npx --no-install sealpack pack sealpack --out "dist/aiplugin4-${version}.sealpack"`);
  run(`npx --no-install sealpack pack sealpack-full --out "dist/aiplugin4-full-${version}.sealpack"`);

  console.log(`[build-release] 完成：
  - dist/aiplugin4.js
  - dist/aiplugin4-${version}.sealpack
  - dist/aiplugin4-full-${version}.sealpack（${deps.length} 个依赖插件）`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
