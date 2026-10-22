#!/usr/bin/env node
// 依赖边界守卫（ratchet）：冻结基线，只拦"结构退化"。
// 用法：
//   npm run deps:check                      # 检查（CI 用）
//   npm run deps:update                     # 接受当前状态为新基线（检测到恶化会拒绝）
//   npm run deps:update -- --allow-grow     # 确有架构调整导致指标恶化时显式放行
//
// 判定项（任一命中即失败）：
//   1) 最大强连通分量变大（maxCycle）
//   2) 环内模块总数变多（inCycle）
//   3) 基线中不在环里的文件新进入环
//   4) 新增跨层依赖（低层 import 高层；不再豁免同顶层模块）
//   5) 新增动态 import（禁止用 await import() 掩盖循环依赖）
//   6) 复活本分支已删除的依赖边（retiredEdges，防止把拆掉的耦合加回去）
//   7) 新增未分类文件（分层规则漏配，默认 L2 会掩盖问题）
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, analyze, edgeKey } from './lib/deps.mjs';

const BASELINE_FILE = path.resolve(ROOT, 'scripts/deps-baseline.json');
const BASELINE_VERSION = 3;
const update = process.argv.includes('--update');
const allowGrow = process.argv.includes('--allow-grow');

const r = await analyze();
const currentEdges = [...new Set(r.edges.map(edgeKey))].sort();
const currentEdgeSet = new Set(currentEdges);

function currentState() {
    return {
        version: BASELINE_VERSION,
        generatedAt: new Date().toISOString(),
        modules: r.files.length,
        edgeCount: currentEdges.length,
        edges: currentEdges,
        maxCycle: r.maxCycle,
        inCycle: r.inCycle.size,
        cycles: r.cycles.map((c) => [...c].sort()),
        violations: r.violations,
        dynamicEdges: r.dynamicEdges,
        unclassified: r.unclassified,
    };
}

/** 相对上一版基线的所有「恶化」项；非空时 update 需 --allow-grow */
function regressionsOf(previous, state) {
    if (!previous || previous.version !== BASELINE_VERSION) return [];
    const out = [];
    if (state.maxCycle > previous.maxCycle) out.push(`最大环 ${previous.maxCycle} → ${state.maxCycle}`);
    if (state.inCycle > previous.inCycle) out.push(`环内模块 ${previous.inCycle} → ${state.inCycle}`);
    const pv = new Set(previous.violations ?? []);
    for (const v of state.violations) if (!pv.has(v)) out.push(`新增跨层依赖 ${v}`);
    const pd = new Set(previous.dynamicEdges ?? []);
    for (const d of state.dynamicEdges) if (!pd.has(d)) out.push(`新增动态 import ${d}`);
    const pu = new Set(previous.unclassified ?? []);
    for (const u of state.unclassified) if (!pu.has(u)) out.push(`新增未分类文件 ${u}`);
    for (const e of previous.retiredEdges ?? []) if (currentEdgeSet.has(e)) out.push(`复活已删除依赖 ${e}`);
    return out;
}

if (update) {
    const previous = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : null;
    const state = currentState();
    // retiredEdges 只增不减：上一版存在、现在消失的边全部并入冻结名单
    const prevRetired = previous?.retiredEdges ?? [];
    const prevEdges = previous?.edges ?? [];
    const newlyRetired = prevEdges.filter((e) => !currentEdgeSet.has(e));
    state.retiredEdges = [...new Set([...prevRetired, ...newlyRetired])].sort();

    const regressions = regressionsOf(previous, state);
    if (regressions.length && !allowGrow) {
        console.error('拒绝更新基线：检测到边界退化，需 --allow-grow 显式放行并在 PR 说明原因：');
        for (const item of regressions) console.error(`  ✗ ${item}`);
        process.exit(2);
    }
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    console.log(`已更新基线：${path.relative(ROOT, BASELINE_FILE)}`);
    console.log(`  模块 ${state.modules} / 边 ${state.edgeCount} / 最大环 ${state.maxCycle} / 环内 ${state.inCycle}`);
    console.log(`  跨层违规 ${state.violations.length} / 动态 import ${state.dynamicEdges.length} / 已冻结删除边 ${state.retiredEdges.length}`);
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

// ---- 1/2) 规模 ratchet ----
if (r.maxCycle > baseline.maxCycle) failures.push(`最大环变大：${baseline.maxCycle} → ${r.maxCycle}`);
if (r.inCycle.size > baseline.inCycle) failures.push(`环内模块变多：${baseline.inCycle} → ${r.inCycle.size}`);

// ---- 3) 新文件进入环 ----
const baselineCycleMembers = new Set(baseline.cycles.flat());
for (const file of r.inCycle) {
    if (!baselineCycleMembers.has(file)) failures.push(`新文件进入环：${file}`);
}

// ---- 4) 跨层依赖 ----
const baseViolations = new Set(baseline.violations);
for (const v of r.violations) if (!baseViolations.has(v)) failures.push(`新增跨层依赖：${v}`);

// ---- 5) 动态 import ----
const baseDynamic = new Set(baseline.dynamicEdges);
for (const d of r.dynamicEdges) if (!baseDynamic.has(d)) failures.push(`新增动态 import（会掩盖循环依赖）：${d}`);

// ---- 6) 已删除依赖复活 ----
for (const e of baseline.retiredEdges ?? []) {
    if (currentEdgeSet.has(e)) failures.push(`恢复已删除依赖：${e}`);
}

// ---- 7) 新增未分类文件 ----
const baseUnclassified = new Set(baseline.unclassified ?? []);
for (const f of r.unclassified) if (!baseUnclassified.has(f)) failures.push(`新增未分类文件（分层规则漏配）：${f}`);

// ---- 汇报 ----
console.log('== aiplugin4 依赖边界检查 ==');
console.log(`模块 ${r.files.length}（基线 ${baseline.modules}）/ 依赖边 ${currentEdges.length}（基线 ${baseline.edgeCount}）`);
console.log(`最大环 ${r.maxCycle}（基线 ${baseline.maxCycle}）/ 环内 ${r.inCycle.size}（基线 ${baseline.inCycle}）/ 环数 ${r.cycles.length}（基线 ${baseline.cycles.length}）`);
console.log(`跨层违规 ${r.violations.length}（基线 ${baseline.violations.length}）/ 动态 import ${r.dynamicEdges.length}（基线 ${baseline.dynamicEdges.length}）/ 已冻结删除边 ${(baseline.retiredEdges ?? []).length}`);

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

if (failures.length) {
    console.error(`\n[FAIL] 发现 ${failures.length} 处边界退化：`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('\n修复方式：拆掉该 import，或改为注入/端口；确属有意的架构调整请编辑 scripts/deps-baseline.json 并在 PR 说明原因。');
    process.exit(1);
}
console.log('\n[OK] 无结构退化、无新增跨层依赖、无新增动态 import、无复活已删依赖。');
