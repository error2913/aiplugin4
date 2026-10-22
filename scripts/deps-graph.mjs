#!/usr/bin/env node
// 生成依赖图快照（.dev/deps-graph.json）并打印摘要。
// 用法：npm run deps:graph [-- --out .dev/deps-graph.json]
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, analyze, layerOf } from './lib/deps.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : '.dev/deps-graph.json');

const r = await analyze();
const maxCycle = r.cycles[0] ? r.cycles[0].length : 0;
const topFanIn = Object.entries(r.fanIn)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

const snapshot = {
    generatedAt: new Date().toISOString(),
    modules: r.files.length,
    edges: r.edges.length,
    cycles: r.cycles.map((c) => [...c].sort()),
    maxCycle,
    inCycle: r.inCycle.size,
    violations: r.violations,
    fanIn: r.fanIn,
    layers: Object.fromEntries(r.files.map((f) => [f, layerOf(f)])),
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

console.log('== aiplugin4 依赖图 ==');
console.log(`模块 ${snapshot.modules} / 依赖边 ${snapshot.edges}`);
console.log(`环 ${snapshot.cycles.length} 个，最大强连通分量 ${maxCycle} 个模块，环内模块合计 ${snapshot.inCycle}`);
console.log(`跨层违规边（低层→高层，跨顶层模块） ${snapshot.violations.length} 条`);
console.log('扇入 Top10：');
for (const [f, n] of topFanIn) console.log(`  ${String(n).padStart(3)}  ${f}`);
if (snapshot.cycles.length) {
    console.log('各环规模：');
    for (const c of snapshot.cycles) console.log(`  [${c.length}] ${c.slice(0, 4).join(' | ')}${c.length > 4 ? ' | …' : ''}`);
}
console.log(`\n已写入 ${path.relative(ROOT, outFile)}`);
