// 从 src/changelog.ts 中提取指定版本的更新日志并输出到 stdout，
// 供 release 工作流生成 GitHub Release 正文。
// 用法: node scripts/release-notes.js <version>
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('用法: node scripts/release-notes.js <version>');
  process.exit(1);
}

const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'changelog.ts'),
  'utf8'
);
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = new RegExp(`"${esc}"\\s*:\\s*\\\`([^\\\`]*)\\\``);
const m = src.match(re);
if (!m) {
  console.error(`src/changelog.ts 中未找到版本 ${version} 的更新日志`);
  process.exit(1);
}

console.log(`## ${version} 更新日志\n`);
console.log(m[1].trim());
