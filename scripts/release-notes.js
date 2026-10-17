// 从 src/changelog.ts 中提取指定版本的更新日志并输出到 stdout，
// 供 release 工作流生成 GitHub Release 正文。
// 用法: node scripts/release-notes.js <version>
//
// ⚠️ 条目正文是**模板字符串**，正文里的行内代码写作 \\`（转义反引号）。
// 因此结束定界符是「**未转义**的反引号」——若按 `[^`]*` 匹配，会在第一个 \\` 处提前截断
// （4.24.0 的发布正文就是这样只出了一行的）。
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

/**
 * 从 `start` 处（指向开头反引号之后）取模板字符串正文，遇到**未转义**的反引号结束。
 * 逐字符扫描而非正则：需要区分 `\\``（正文内容）与 `` ` ``（定界符）。
 * @returns 正文，未找到结束定界符时返回 null
 */
function readTemplateBody(text, start) {
  let out = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      // 转义序列整体保留（\\` → 输出 \`，交给调用方按需还原）
      out += ch;
      if (i + 1 < text.length) out += text[++i];
      continue;
    }
    if (ch === '`') return out;
    out += ch;
  }
  return null;
}

const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyRe = new RegExp(`"${esc}"\\s*:\\s*`);
const key = keyRe.exec(src);
if (!key || src[key.index + key[0].length] !== '`') {
  console.error(`src/changelog.ts 中未找到版本 ${version} 的更新日志`);
  process.exit(1);
}

const body = readTemplateBody(src, key.index + key[0].length + 1);
if (body === null) {
  console.error(`版本 ${version} 的更新日志模板字符串缺少结束反引号`);
  process.exit(1);
}

// 模板字符串里的 \\` 还原成普通反引号：更新日志正文要作为 Markdown 输出
console.log(`## ${version} 更新日志\n`);
console.log(body.replace(/\\`/g, '`').trim());
