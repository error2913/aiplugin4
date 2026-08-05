const fs = require('fs');
const path = require('path');
const root = process.cwd();

// 配置模块 -> 二级页签分组名
const groups = {
  'base.ts': '基础',
  'model.ts': '模型',
  'backend.ts': '后端',
  'received.ts': '消息接收',
  'trigger.ts': '消息触发',
  'image.ts': '图片',
  'tool.ts': '工具',
  'memory.ts': '记忆',
  'reply.ts': '回复',
  'message.ts': '对话',
  'prompt.ts': 'prompt模板',
  'resource.ts': '资源',
  'sample.ts': '示例',
};

// 找到从 open 开始的配对的闭合括号（跳过字符串字面量与转义）
function findClose(s, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

let total = 0;
for (const [file, group] of Object.entries(groups)) {
  const p = path.join(root, 'src/config/configs', file);
  let s = fs.readFileSync(p, 'utf8');

  // 1) 统一使用共享 ext：Config.getExt('模块名') -> Config.ext
  s = s.replace(/= Config\.getExt\('[^']*'\);/g, '= Config.ext;');

  // 2) 给每个 register*Config 调用追加 group 参数
  const re = /seal\.ext\.register(\w+)Config\(/g;
  let m;
  const inserted = [];
  while ((m = re.exec(s))) {
    const open = m.index + m[0].length - 1; // '(' 的位置
    const close = findClose(s, open);
    if (close === -1) continue;
    const before = s.slice(open + 1, close);
    if (before.endsWith(`"${group}"`)) continue; // 已追加过
    inserted.push([close, group]);
  }
  // 从后往前插入，避免索引失效
  inserted.sort((a, b) => b[0] - a[0]);
  for (const [idx, g] of inserted) {
    s = s.slice(0, idx) + `, "${g}"` + s.slice(idx);
    total++;
  }
  fs.writeFileSync(p, s);
}
console.log('已追加 group 参数的注册调用数:', total);
