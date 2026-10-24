// 从 src/changelog/<version>.ts 中提取指定版本的更新日志并输出到 stdout，
// 供 release 工作流生成 GitHub Release 正文。
// 用法: node scripts/release-notes.js <version>
//
// ⚠️ 数据文件正文是**模板字符串**，正文里的行内代码写作 \`（转义反引号）。
// 因此结束定界符是「**未转义**的反引号」——若按 `[^`]*` 匹配，会在第一个 \` 处提前截断
// （4.24.0 的发布正文就是这样只出了一行的）。
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('用法: node scripts/release-notes.js <version>');
  process.exit(1);
}

const file = path.resolve(__dirname, '..', 'src', 'changelog', `${version}.ts`);
if (!fs.existsSync(file)) {
  console.error(`src/changelog/${version}.ts 不存在（版本号是否正确？新版本请先建数据文件）`);
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');

/**
 * 从 `start` 处（指向开头反引号之后）取模板字符串正文，遇到**未转义**的反引号结束。
 * 逐字符扫描而非正则：需要区分 `\``（正文内容）与 `` ` ``（定界符）。
 * @returns 正文，未找到结束定界符时返回 null
 */
function readTemplateBody(text, start) {
  let out = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      // 转义序列整体保留（\` → 输出 \`，交给调用方按需还原）
      out += ch;
      if (i + 1 < text.length) out += text[++i];
      continue;
    }
    if (ch === '`') return out;
    out += ch;
  }
  return null;
}

const startMarker = 'export default `';
const at = src.indexOf(startMarker);
if (at < 0) {
  console.error(`src/changelog/${version}.ts 缺少 "export default \`正文\`;"`);
  process.exit(1);
}

const body = readTemplateBody(src, at + startMarker.length);
if (body === null) {
  console.error(`版本 ${version} 的更新日志模板字符串缺少结束反引号`);
  process.exit(1);
}

// 模板字符串里的 \` 还原成普通反引号：更新日志正文要作为 Markdown 输出
console.log(`## ${version} 更新日志\n`);
console.log(body.replace(/\\`/g, '`').trim());
