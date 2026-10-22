#!/usr/bin/env node
// 依赖边界守卫（ratchet）：冻结基线，只拦"结构退化"与"新增跨层依赖"。
// 用法：
//   npm run deps:check                      # 检查（CI 用）
//   npm run deps:update                     # 接受当前状态为新基线（需在 PR 说明原因）
//   npm run deps:update -- --allow-grow     # 环反而变大时显式放行（默认拒绝）
//
// 判定项（任一新增即失败）：
//   1) 最大强连通分量变大（maxCycle）
//   2) 环内模块总数变多（inCycle）
//   3) 基线中不在任何环里的文件新进入环
//   4) 新增跨层依赖（低层 import 高层，且跨顶层模块）
//   5) 新增动态 import（禁止用 await import() 掩盖循环依赖）
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, analyze } from './lib/deps.mjs';

const BASELINE_FILE = path.resolve(ROOT, 'scripts/deps-baseline.json');
const BASELINE_VERSION = 2;
const update = process.argv.includes('--update');
const allowGrow = process.argv.includes('--allow-grow');

const r = await analyze();

function currentState() {
    return {
        version: BASELINE_VERSION,
        generatedAt: new Date().toISOString(),
        modules: r.files.length,
        edges: r.edges.length,
        maxCycle: r.maxCycle,
        inCycle: r.inCycle.size,
        cycles: r.cycles.map((c) => [...c].sort()),
        violations: r.violations,
        dynamicEdges: r.dynamicEdges,
        unclassified: r.unclassified,
    };
}

if (update) {
    const previous = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null;
    const state = currentState();
    if (previous && previous.version === BASELINE_VERSION && state.maxCycle > previous.maxCycle && !allowGrow) {
        console.error(`拒绝更新基线：最大环 ${previous.maxCycle} → ${state.maxCycle}（变大了）。`);
        console.error('如果确属架构调整（例如两个环合并但总数下降），请加 --allow-grow 并在 PR 说明原因。');
        process.exit(2);
    }
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    console.log(`已更新基线：${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(`  模块 ${state.modules} / 边 ${state.edges} / 最大环 ${state.maxCycle} / 环内 ${state.inCycle} / 跨层违规 ${state.violations.length} / 动态 import ${state.dynamicEdges.length}`);
    if (state.unclassified.length) {
        console.log(`  ⚠ 未分类文件 ${state.unclassified.length} 个（layerOf 回退到 L2，建议补 scripts/lib/deps.mjs 规则）：`);
        for (const f of state.unclassified) console.log(`    - ${f}`);
    }
    process.exit(0);
}

if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`缺少基线文件 ${path.relative(ROOT, BASELINE_FILE)}；先运行 npm run deps:update`);
    process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
if (baseline.version !== BASELINE_VERSION) {
    console.error(`基线版本 ${baseline.version} 与守卫版本 ${BASELINE_VERSION} 不一致；请运行 npm run deps:update 重新生成。`);
    process.exit(2);
}

const failures = [];
const warnings = [];

// ---- 1) 规模 ratchet ----
if (r.maxCycle > baseline.maxCycle) {
    failures.push(`最大环变大：${baseline.maxCycle} → ${r.maxCycle}`);
}
if (r.inCycle.size > baseline.inCycle) {
    failures.push(`环内模块变多：${baseline.inCycle} → ${r.inCycle.size}`);
}

// ---- 2) 新文件进入环 ----
const baselineCycleMembers = new Set(baseline.cycles.flat());
for (const file of r.inCycle) {
    if (!baselineCycleMembers.has(file)) failures.push(`新文件进入环：${file}`);
}

// ---- 3) 跨层依赖 ----
const baseViolations = new Set(baseline.violations);
for (const v of r.violations) {
    if (!baseViolations.has(v)) failures.push(`新增跨层依赖：${v}`);
}

// ---- 4) 动态 import ----
const baseDynamic = new Set(baseline.dynamicEdges);
for (const d of r.dynamicEdges) {
    if (!baseDynamic.has(d)) failures.push(`新增动态 import（会掩盖循环依赖）：${d}`);
}

// ---- 5) 未分类提醒 ----
const baseUnclassified = new Set(baseline.unclassified);
for (const f of r.unclassified) {
    if (!baseUnclassified.has(f)) warnings.push(`新增未分类文件（已按 L2 计）：${f}`);
}

// ---- 汇报 ----
console.log('== aiplugin4 依赖边界检查 ==');
console.log(`模块 ${r.files.length}（基线 ${baseline.modules}）/ 依赖边 ${r.edges.length}（基线 ${baseline.edges}）`);
console.log(`最大环 ${r.maxCycle}（基线 ${baseline.maxCycle}）/ 环内 ${r.inCycle.size}（基线 ${baseline.inCycle}）/ 环数 ${r.cycles.length}（基线 ${baseline.cycles.length}）`);
console.log(`跨层违规 ${r.violations.length}（基线 ${baseline.violations.length}）/ 动态 import ${r.dynamicEdges.length}（基线 ${baseline.dynamicEdges.length}）`);

const fixedViolations = [...baseViolations].filter((v) => !r.violations.includes(v));
if (fixedViolations.length) {
    console.log(`\n已消除的跨层依赖 ${fixedViolations.length} 条：`);
    for (const v of fixedViolations.slice(0, 10)) console.log(`  - ${v}`);
    if (fixedViolations.length > 10) console.log(`  … 其余 ${fixedViolations.length - 10} 条`);
}
if (r.maxCycle < baseline.maxCycle || r.inCycle.size < baseline.inCycle) {
    console.log(`\n边界已改善：最大环 ${baseline.maxCycle} → ${r.maxCycle}，环内 ${baseline.inCycle} → ${r.inCycle.size}`);
    console.log('可运行 `npm run deps:update` 收紧基线。');
}

for (const w of warnings) console.warn(`[WARN] ${w}`);
if (failures.length) {
    console.error(`\n[FAIL] 发现 ${failures.length} 处边界退化：`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('\n修复方式：拆掉该 import，或改为注入/端口；确属有意的架构调整请运行 `npm run deps:update` 并在 PR 说明原因。');
    process.exit(1);
}
console.log('\n[OK] 无结构退化、无新增跨层依赖、无新增动态 import。');
