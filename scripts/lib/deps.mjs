// 依赖图计算核心（纯函数 + esbuild metafile 解析）
// 与生产构建同参数：entryPoints/tsconfig/treeShaking/external 均对齐 tools/build-config.js。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export { ROOT };

/** 用 esbuild 生成 metafile（真实运行时图：类型导入已被剔除） */
export async function buildMetafile() {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
        absWorkingDir: ROOT,
        entryPoints: ['src/index.ts'],
        bundle: true,
        write: false,
        metafile: true,
        external: ['csharp', 'puerts'],
        format: 'esm',
        target: 'es2020',
        platform: 'browser',
        treeShaking: true,
        tsconfig: './tsconfig.json',
        logLevel: 'silent',
    });
    return result.metafile;
}

/** 由 metafile 构建 src 内部的模块图 */
export function graphFromMetafile(metafile) {
    const files = Object.keys(metafile.inputs)
        .filter((p) => p.startsWith('src/'))
        .sort();
    const fileSet = new Set(files);
    const graph = new Map(files.map((f) => [f, new Set()]));
    for (const f of files) {
        for (const imp of metafile.inputs[f].imports || []) {
            if (fileSet.has(imp.path)) graph.get(f).add(imp.path);
        }
    }
    const edges = [];
    for (const [from, tos] of graph) for (const to of tos) edges.push([from, to]);
    const fanIn = Object.fromEntries(files.map((f) => [f, 0]));
    for (const [, to] of edges) fanIn[to] += 1;
    return { files, graph, edges, fanIn };
}

/** Tarjan 强连通分量（只保留 size > 1 的环，按大小降序） */
export function findCycles({ files, graph }) {
    let index = 0;
    const stack = [];
    const onStack = new Set();
    const idxMap = new Map();
    const lowMap = new Map();
    const components = [];
    const rec = (v) => {
        idxMap.set(v, index);
        lowMap.set(v, index);
        index += 1;
        stack.push(v);
        onStack.add(v);
        for (const w of graph.get(v) || []) {
            if (!idxMap.has(w)) {
                rec(w);
                lowMap.set(v, Math.min(lowMap.get(v), lowMap.get(w)));
            } else if (onStack.has(w)) {
                lowMap.set(v, Math.min(lowMap.get(v), idxMap.get(w)));
            }
        }
        if (lowMap.get(v) === idxMap.get(v)) {
            const comp = [];
            let w;
            do {
                w = stack.pop();
                onStack.delete(w);
                comp.push(w);
            } while (w !== v);
            components.push(comp);
        }
    };
    for (const f of files) if (!idxMap.has(f)) rec(f);
    return components.filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// 分层规则：数值越大越"上层"。低层 import 高层 = 违规（reverse dependency）。
// 只判跨顶层模块的边；同模块内部（如 utils/x → utils/y）不判，避免噪音。
// ---------------------------------------------------------------------------
const LAYER_RULES = [
    { layer: 0, name: 'L0 基础', test: (f) => /^src\/config\/static_config\//.test(f) },
    { layer: 0, name: 'L0 基础', test: (f) => /^src\/(core|utils\/(target_id|url|raw_marker|json|markdown)\.ts$)/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/config\/(domain|v5)\//.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/(logger|token_calibration)\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/(\w+)\/types\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/model\/(api_dialect|base_url|catalog|window_cache)\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/memory\/v2\/(storage|repository|bank_resolver|templates|prompt)\.ts$/.test(f) },
    { layer: 2, name: 'L2 能力', test: (f) => /^src\/config\/(config\.ts|configs\/)/.test(f) },
    { layer: 2, name: 'L2 能力', test: (f) => /^src\/(model|resource|transport|memory|utils|web|pub|integration|media|judge)\//.test(f) },
    { layer: 2, name: 'L2 能力', test: (f) => /^src\/(usage|block|timer)\.ts$/.test(f) },
    { layer: 3, name: 'L3 领域', test: (f) => /^src\/(context|session|prompt|tool|agent)\//.test(f) },
    { layer: 4, name: 'L4 装配', test: (f) => /^src\/(index|pipeline|trigger|changelog)\.ts$/.test(f) },
    { layer: 4, name: 'L4 装配', test: (f) => /^src\/cmd\//.test(f) },
];

export function layerOf(file) {
    for (const rule of LAYER_RULES) if (rule.test(file)) return rule.layer;
    return 2; // 未分类默认按能力层，并在报告里提示补规则
}

export function topModuleOf(file) {
    const parts = file.split('/');
    return parts.length === 2 ? '(root)' : parts[1];
}

/** 计算跨层违规边（低层 → 高层），返回 "from -> to" 排序数组 */
export function findLayerViolations(edges) {
    const out = [];
    for (const [from, to] of edges) {
        if (!from.startsWith('src/') || !to.startsWith('src/')) continue;
        if (topModuleOf(from) === topModuleOf(to)) continue;
        if (layerOf(to) > layerOf(from)) out.push(`${from} -> ${to}`);
    }
    return [...new Set(out)].sort();
}

/** 一次性汇总当前状态 */
export async function analyze() {
    const metafile = await buildMetafile();
    const g = graphFromMetafile(metafile);
    const cycles = findCycles(g);
    const violations = findLayerViolations(g.edges);
    const inCycle = new Set(cycles.flat());
    return { ...g, cycles, violations, inCycle };
}
