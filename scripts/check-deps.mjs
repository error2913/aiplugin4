#!/usr/bin/env node
// 依赖边界守卫（ratchet）：冻结基线，只拦"新增环"与"新增跨层依赖"。
// 用法：
//   npm run deps:check           # 检查（CI 用）
//   npm run deps:update          # 接受当前状态为新基线（需在 PR 里说明原因）
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, analyze } from './lib/deps.mjs';

const BASELINE_FILE = path.resolve(ROOT, 'scripts/deps-baseline.json');
const update = process.argv.includes('--update');

const r = await analyze();
const maxCycle = r.cycles[0] ? r.cycles[0].length : 0;

function currentState() {
    return {
        modules: r.files.length,
        edges: r.edges.length,
        cycles: r.cycles.map((c) => [...c].sort()),
        violations: r.violations,
    };
}

if (update) {
    const baseline = { generatedAt: new Date().toISOString(), ...currentState() };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(`已更新基线：${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(`  模块 ${baseline.modules} / 边 ${baseline.edges} / 环 ${baseline.cycles.length} / 跨层违规 ${baseline.violations.length}`);
    process.exit(0);
}

if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`缺少基线文件 ${path.relative(ROOT, BASELINE_FILE)}；先运行 npm run deps:update`);
    process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const failures = [];

// ---- 1) 环检查 ----
const baseSccOf = new Map();
baseline.cycles.forEach((members, i) => members.forEach((f) => baseSccOf.set(f, i)));
const curSccOf = new Map();
r.cycles.forEach((members, i) => members.forEach((f) => curSccOf.set(f, i)));

for (const [file, curId] of curSccOf) {
    const baseId = baseSccOf.get(file);
    const curSize = r.cycles[curId].length;
    if (baseId === undefined) {
        failures.push(`新增环成员：${file}（当前环大小 ${curSize}）`);
        continue;
    }
    const baseSize = baseline.cycles[baseId].length;
    if (curSize > baseSize) {
        failures.push(`环变大：${file} 所在环 ${baseSize} → ${curSize}`);
    }
}

// ---- 2) 跨层违规检查 ----
const baseViolations = new Set(baseline.violations);
const curViolations = new Set(r.violations);
for (const v of curViolations) {
    if (!baseViolations.has(v)) failures.push(`新增跨层依赖：${v}`);
}
const fixed = [...baseViolations].filter((v) => !curViolations.has(v));

// ---- 3) 汇报 ----
const uniq = [...new Set(failures)];
console.log('== aiplugin4 依赖边界检查 ==');
console.log(`模块 ${r.files.length}（基线 ${baseline.modules}）/ 依赖边 ${r.edges.length}（基线 ${baseline.edges}）`);
console.log(`环 ${r.cycles.length} 个（基线 ${baseline.cycles.length}），最大 SCC ${maxCycle}（基线 ${baseline.cycles[0]?.length ?? 0}）`);
console.log(`跨层违规边 ${r.violations.length}（基线 ${baseline.violations.length}）`);

if (fixed.length) {
    console.log(`\n已消除的跨层依赖 ${fixed.length} 条：`);
    for (const v of fixed.slice(0, 10)) console.log(`  - ${v}`);
    if (fixed.length > 10) console.log(`  … 其余 ${fixed.length - 10} 条`);
}

if (uniq.length) {
    console.error(`\n[FAIL] 发现 ${uniq.length} 处边界退化：`);
    for (const f of uniq) console.error(`  ✗ ${f}`);
    console.error('\n修复方式：拆掉该 import，或改为注入/端口；确属有意的架构调整请运行 `npm run deps:update` 并在 PR 说明原因。');
    process.exit(1);
}

if (baseline.violations.length > r.violations.length || (baseline.cycles[0]?.length ?? 0) > maxCycle) {
    console.log('\n[提示] 边界已改善，可运行 `npm run deps:update` 收紧基线。');
}
console.log('\n[OK] 无新增环、无新增跨层依赖。');
