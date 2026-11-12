#!/usr/bin/env node
// 前缀纯度守卫（#163 REQ-D9-05）：禁止渲染层依赖可变运行时状态。
//
// 为什么需要这个守卫：R1（严格前缀扩展）的成立条件是「已发送区的渲染字节只依赖
// 事件内冻结字段 + 只读常量/配置快照」。任何一处 `Date.now()` / `User.get()` / 宿主模板
// 读取都会让同一事件在不同轮次渲染出不同字节 —— 而这种违约**不会让任何测试失败**，
// 只会安静地把缓存命中率打下来。所以必须用静态扫描把它变成 CI 失败。
//
// 用法：node scripts/check-prefix-purity.mjs [--strict]
//   - 默认模式：白名单失效只提示（改造期行号/代码会变）
//   - --strict：白名单失效也算失败（CI 用这个，防止"改造没做完但也没报错"）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 扫描范围：历史渲染层（context/view/** 递归 + utils/message.ts 的渲染函数） */
const SCAN_TARGETS = ["src/context/view", "src/utils/message.ts"];

/** 禁止模式（规则表风格对齐 scripts/lib/deps.mjs） */
const RULES = [
    { id: "runtime-clock", re: /\bDate\s*(?:\.\s*now|\[\s*["']now["']\s*\])\s*\(/, why: "渲染不得依赖当前时钟" },
    { id: "runtime-date", re: /\bnew\s+(?:window\.|globalThis\.)?Date\s*\(/, why: "渲染不得依赖当前日期" },
    { id: "perf-clock", re: /\bperformance\s*(?:\.\s*now|\[\s*["']now["']\s*\])\s*\(/, why: "渲染不得依赖高精度时钟" },
    { id: "live-user", re: /\bUser\.get\s*\(/, why: "渲染不得读实时用户资料（[from] 必须写时冻结）" },
    { id: "seal-template", re: /\bseal\.formatTmpl\s*\(/, why: "渲染不得读宿主模板/可变文本" },
    { id: "aux-registry", re: /\bauxRegistry\./, why: "渲染不得读 aux 注册表（图床/资源数量）" },
];

/**
 * 白名单：**只按"行内容特征"匹配**（不按行号，避免改造后行号漂移导致失效）。
 * 每条必须写明理由 + expiresAt。
 *
 * 审核要点（AUDIT-007，P1）：初版只用 `/const name = User\.get\(uid\)\.userName;/` 一条，
 * 同时豁免了 `resolveUserName`（允许）与 `formatFromPrefix`（D2 必须改成读冻结 fromName），
 * 于是"D2 忘了改也发现不了"。现在正则**收窄到 `resolveUserName` / `legacyLiveName` 上下文**，
 * 且每条的 `context` 锚点必须命中才算豁免 —— 裸内容匹配不再生效。
 *
 * PR-09 收窄记录：`formatFromPrefix` 已改为读 `item.frozenName`（写时冻结），
 * 活读用户表只剩两处**同一语义**的旧数据回落，都在"文件头/函数注释里写明为何允许"：
 *   1. `resolveUserName`（v2 编译层的旧数据回落，REQ-D2-05）；
 *   2. `legacyLiveName`（legacy messages 路径的旧数据回落，同一条 REQ-D2-05）。
 * 新写入的事件一律带 `fromName`/`frozenName`，两者都不会被命中。
 */
const ALLOWLIST = [
    {
        file: "src/utils/message.ts",
        re: /^\s*const name = User\.get\(uid\)\.userName;\s*$/,
        // ★ 上下文锚：必须落在 `resolveUserName:` 之后 10 行内才算豁免。
        context: /resolveUserName\s*:\s*\(\s*uid\s*(?::\s*string\s*)?\)\s*=>\s*\{/,
        contextLines: 10,
        why: "resolveUserName 的旧数据回落（REQ-D2-05 明确允许）；v2 新事件走冻结 fromName",
        expiresAt: "长期保留（旧数据回落是设计的一部分）",
    },
    {
        file: "src/utils/message.ts",
        re: /^\s*return String\(User\.get\(uid\)\.userName \|\| ''\);\s*$/,
        // ★ 上下文锚：必须是 `legacyLiveName()` 函数体（不是任意一行活读）
        context: /function legacyLiveName\(uid: string\): string \{/,
        contextLines: 6,
        why: "legacyLiveName 的旧数据回落（legacy messages 路径的 REQ-D2-05）；新消息走 frozenName",
        expiresAt: "长期保留（旧数据回落是设计的一部分）",
    },
];

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
}

function targetFiles() {
    const files = [];
    for (const target of SCAN_TARGETS) {
        const full = path.join(ROOT, target);
        if (!fs.existsSync(full)) continue;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) files.push(...walk(full));
        else files.push(full);
    }
    return files.sort();
}

function relOf(file) {
    return path.relative(ROOT, file).split(path.sep).join("/");
}

function isAllowlisted(file, lines, index) {
    return ALLOWLIST.some(entry => {
        if (entry.file !== file) return false;
        if (!entry.re.test(lines[index])) return false;
        if (!entry.context) return true;
        // 上下文锚：在 index 之前 contextLines 行内必须出现 entry.context
        const from = Math.max(0, index - (entry.contextLines ?? 10));
        for (let i = from; i < index; i++) {
            if (entry.context.test(lines[i])) return true;
        }
        return false;
    });
}

/**
 * 扫描一份源码（纯函数，不读盘）。抽出来的目的：`--self-test` 可以喂人造样本
 * 验证"规则真的会红""上下文锚真的会收窄"，而不必去改真实源码再回滚。
 * @param {string} rel 仓库相对路径（用于白名单匹配）
 * @param {string} content 源码文本
 * @returns {{violations: Array<{file: string, line: number, id: string, why: string, text: string}>, used: Set<string>}}
 */
export function scanSource(rel, content) {
    const lines = String(content).split(/\r?\n/);
    const violations = [];
    const used = new Set();
    lines.forEach((line, index) => {
        for (const rule of RULES) {
            if (!rule.re.test(line)) continue;
            if (isAllowlisted(rel, lines, index)) {
                used.add(`${rel}:${rule.id}`);
                continue;
            }
            violations.push({ file: rel, line: index + 1, id: rule.id, why: rule.why, text: line.trim().slice(0, 160) });
        }
    });
    return { violations, used };
}

/** 白名单里"本次一条都没命中"的条目（`--strict` 下算失败） */
export function staleAllowlistEntries(usedByFile) {
    return ALLOWLIST.filter(entry => !usedByFile.has(entry.file));
}

// ---------------------------------------------------------------------------
// 自测（`--self-test`）：验证守卫本身会红、且白名单锚点真的收窄
// ---------------------------------------------------------------------------
function selfTest() {
    const cases = [];
    const expect = (name, ok, detail) => cases.push({ name, ok, detail });

    // ① 每条规则都必须能命中自己的"坏样本"
    const badSamples = {
        'runtime-clock': 'const t = Date.now();',
        'runtime-date': 'const d = new Date();',
        'perf-clock': 'const p = performance.now();',
        'live-user': "const n = User.get(uid).userName;",
        'seal-template': 'const s = seal.formatTmpl("{t}", {});',
        'aux-registry': 'const n = auxRegistry.size;',
    };
    for (const rule of RULES) {
        const sample = badSamples[rule.id];
        expect(`坏样本必红：${rule.id}`, Boolean(sample), '样本表必须覆盖规则表（新增规则请补样本）');
        if (!sample) continue;
        const { violations } = scanSource('src/context/view/__probe__.ts', sample);
        expect(`坏样本必红：${rule.id}`, violations.some(v => v.id === rule.id), `未命中 ${rule.id}`);
    }

    // ② 干净样本必绿
    const clean = scanSource(
        'src/context/view/__probe__.ts',
        ['const seq = event.seq;', "const from = item.frozenName || '';", 'return `[from:${from}]`;'].join('\n'),
    );
    expect('干净样本必绿', clean.violations.length === 0, JSON.stringify(clean.violations));

    // ③ 白名单锚点收窄：裸命中但**不在** `resolveUserName` 上下文 ⇒ 必须报红（AUDIT-007 回归点）
    const orphan = scanSource('src/utils/message.ts', ['function other(uid: string) {', '    const name = User.get(uid).userName;', '}'].join('\n'));
    expect('白名单上下文锚：孤儿活读必红', orphan.violations.length === 1, `实际 ${orphan.violations.length} 处`);

    // ④ 白名单锚点命中 ⇒ 放行且被记为"已使用"
    const allowlisted = scanSource(
        'src/utils/message.ts',
        ['resolveUserName: (uid: string) => {', '    try {', '        const name = User.get(uid).userName;', '        return name;', '    } catch {', '        return uid;', '    }', '},'].join('\n'),
    );
    expect('白名单上下文锚：锚内放行', allowlisted.violations.length === 0, JSON.stringify(allowlisted.violations));
    expect('白名单命中记账', allowlisted.used.has('src/utils/message.ts:live-user'), '未记入 used 集合');

    // ⑤ 白名单失效检测：一条都没用上 ⇒ stale
    const stale = staleAllowlistEntries(new Set());
    expect('白名单失效可检出', stale.length === ALLOWLIST.length, `实际 ${stale.length}/${ALLOWLIST.length}`);
    expect('白名单失效不误报', staleAllowlistEntries(new Set(ALLOWLIST.map(e => e.file))).length === 0, '全部命中时不应有 stale');

    const failed = cases.filter(c => !c.ok);
    if (failed.length === 0) {
        console.log(`[prefix-purity] SELF-TEST OK：${cases.length} 项断言通过`);
        return 0;
    }
    console.error(`[prefix-purity] SELF-TEST FAILED：${failed.length}/${cases.length} 项失败`);
    for (const c of failed) console.error(`  - ${c.name}：${c.detail}`);
    return 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes("--self-test")) {
    process.exit(selfTest());
}

const strict = process.argv.includes("--strict");
const files = targetFiles();
const violations = [];
const usedFiles = new Set();
for (const file of files) {
    const rel = relOf(file);
    const { violations: found, used } = scanSource(rel, fs.readFileSync(file, "utf8"));
    violations.push(...found);
    for (const key of used) usedFiles.add(key.slice(0, key.lastIndexOf(':')));
}

/**
 * 白名单"失效"：默认只提示（改造期行号/代码会变，避免反复改脚本）；
 * **`--strict` 模式下算失败**（AUDIT-007）。
 */
const stale = staleAllowlistEntries(usedFiles);

if (violations.length === 0 && stale.length === 0) {
    console.log(`[prefix-purity] OK：扫描 ${files.length} 个文件，0 处违约`);
    process.exit(0);
}

if (violations.length === 0 && stale.length > 0) {
    const msg = `[prefix-purity] 白名单有 ${stale.length} 条本次未命中（对应代码已删除/已改造）：`;
    const list = stale.map(e => `  ${e.file}  ${e.expiresAt ?? ""}`).join("\n");
    if (!strict) {
        console.log(`[prefix-purity] OK：扫描 ${files.length} 个文件，0 处违约`);
        console.log(`${msg}\n${list}\n  （默认模式只提示；CI 用 --strict 会失败）`);
        process.exit(0);
    }
    console.error(msg + "\n" + list);
    console.error("\n修复方式：删除已失效的 ALLOWLIST 条目，或确认改造未生效。");
    process.exit(1);
}

console.error(`[prefix-purity] 发现 ${violations.length} 处前缀纯度违约：`);
for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.id}] ${v.why}\n      ${v.text}`);
}
console.error("\n修复方式：渲染只允许依赖「事件内冻结字段 + 只读常量/配置快照」；若确属非渲染用途，请加入脚本 ALLOWLIST 并写明理由与 expiresAt。");
process.exit(1);
