// 构建 sealpack 打包源目录（sealpack/）：
// 1. 从 src/config/static_config/meta.ts 读取插件版本 VERSION；
// 2. 将构建产物 dist/aiplugin4.js 复制为 sealpack/scripts/main.js；
// 3. 同步 sealpack/info.toml 中的 version，保证与插件版本一致；
// 4. 在 stdout 输出版本号，供 CI 拼装产物文件名。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const staticConfig = path.join(root, 'src', 'config', 'static_config', 'meta.ts');
const bundle = path.join(root, 'dist', 'aiplugin4.js');
const sealpackDir = path.join(root, 'sealpack');
const mainJs = path.join(sealpackDir, 'scripts', 'main.js');
const infoToml = path.join(sealpackDir, 'info.toml');

const src = fs.readFileSync(staticConfig, 'utf8');
const m = src.match(/VERSION\s*=\s*["']([^"']+)["']/);
if (!m) {
  console.error('未能在 src/config/static_config/meta.ts 中找到 VERSION');
  process.exit(1);
}
const version = m[1];

if (!fs.existsSync(bundle)) {
  console.error(`构建产物不存在: ${bundle}，请先执行 npm run build`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(mainJs), { recursive: true });
fs.copyFileSync(bundle, mainJs);

const toml = fs.readFileSync(infoToml, 'utf8').replace(
  /^version\s*=\s*".*"$/m,
  `version = "${version}"`
);
fs.writeFileSync(infoToml, toml);

console.log(version);
