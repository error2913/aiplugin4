// 依赖图计算核心（纯函数 + esbuild metafile 解析）
// 构建参数与生产构建一致（tools/build-config.js 的 build 段）：entryPoints/bundle/external/
// platform/target/treeShaking/tsconfig/define 全对齐；仅关掉 write/minify（对依赖图无影响）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export { ROOT };

/** 用 esbuild 生成 metafile（真实运行时图：类型导入已被剔除，动态 import 单独标记） */
export async function buildMetafile() {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
        absWorkingDir: ROOT,
        entryPoints: ['src/index.ts'],
        bundle: true,
        write: false,
        metafile: true,
        external: ['csharp', 'puerts'],
        platform: 'browser',
        target: 'es6',
        treeShaking: true,
        tsconfig: './tsconfig.json',
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        logLevel: 'silent',
    });
    return result.metafile;
}

/** 由 metafile 构建 src 内部的模块图；dynamicEdges 单独收集（禁止用 await import 掩盖循环） */
export function graphFromMetafile(metafile) {
    const files = Object.keys(metafile.inputs)
        .filter((p) => p.startsWith('src/'))
        .sort();
    const fileSet = new Set(files);
    const graph = new Map(files.map((f) => [f, new Set()]));
    const dynamicEdges = [];
    for (const f of files) {
        for (const imp of metafile.inputs[f].imports || []) {
            if (!fileSet.has(imp.path)) continue;
            graph.get(f).add(imp.path);
            if (imp.kind === 'dynamic-import') dynamicEdges.push(`${f} -> ${imp.path}`);
        }
    }
    const edges = [];
    for (const [from, tos] of graph) for (const to of tos) edges.push([from, to]);
    const fanIn = Object.fromEntries(files.map((f) => [f, 0]));
    for (const [, to] of edges) fanIn[to] += 1;
    return { files, graph, edges, fanIn, dynamicEdges: [...new Set(dynamicEdges)].sort() };
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
// 根目录文件按 basename 视为独立模块（logger/usage/pipeline…），否则会整条豁免。
// ---------------------------------------------------------------------------
const ROOT_FILE_LAYER = {
    logger: 1,
    token_calibration: 1,
    usage: 2,
    block: 2,
    timer: 2,
    pipeline: 4,
    index: 4,
    trigger: 4,
    changelog: 4,
};

const LAYER_RULES = [
    { layer: 0, name: 'L0 基础', test: (f) => /^src\/config\/static_config\//.test(f) },
    { layer: 0, name: 'L0 基础', test: (f) => /^src\/config\/ext\.ts$/.test(f) },
    { layer: 0, name: 'L0 基础', test: (f) => /^src\/(core|utils\/(target_id|url|raw_marker|markdown)\.ts$)/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/utils\/(json|revive|timeout)\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/config\/(domain|v5|hooks\.ts$|regex\.ts$)/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/(logger|token_calibration)\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/(\w+)\/types\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/model\/(api_dialect|base_url|catalog|window_cache)\.ts$/.test(f) },
    { layer: 1, name: 'L1 纯逻辑', test: (f) => /^src\/memory\/v2\/(storage|repository|bank_resolver|templates|prompt)\.ts$/.test(f) },
    { layer: 2, name: 'L2 能力', test: (f) => /^src\/config\/(config\.ts|configs\/|apply\/)/.test(f) },
    { layer: 2, name: 'L2 能力', test: (f) => /^src\/(model|resource|transport|memory|utils|web|pub|integration|media|judge|event)\//.test(f) },
    { layer: 2, name: 'L2 能力', test: (f) => /^src\/(usage|block|timer)\.ts$/.test(f) },
    { layer: 3, name: 'L3 领域', test: (f) => /^src\/(context|session|prompt|tool|agent)\//.test(f) },
    { layer: 4, name: 'L4 装配', test: (f) => /^src\/(index|pipeline|trigger|changelog)\.ts$/.test(f) },
    { layer: 4, name: 'L4 装配', test: (f) => /^src\/cmd\//.test(f) },
];

/** 顶层模块名：src/tool/x.ts → tool；src/logger.ts → logger（根文件各自独立） */
export function topModuleOf(file) {
    const parts = file.split('/');
    if (parts.length === 2) return parts[1].replace(/\.ts$/, '');
    return parts[1];
}

/** 未分类文件列表（layerOf 回退到 2，需要补规则） */
export function unclassifiedFiles(files) {
    return files.filter((f) => {
        if (ROOT_FILE_LAYER[topModuleOf(f)] !== undefined && f.split('/').length === 2) return false;
        if (f.split('/').length === 2) return true;
        return !LAYER_RULES.some((rule) => rule.test(f));
    }).sort();
}

export function layerOf(file) {
    if (file.split('/').length === 2) {
        const rootLayer = ROOT_FILE_LAYER[file.split('/')[1].replace(/\.ts$/, '')];
        if (rootLayer !== undefined) return rootLayer;
    }
    for (const rule of LAYER_RULES) if (rule.test(file)) return rule.layer;
    return 2; // 未分类默认按能力层，并在报告里提示补规则
}

/** 边 → "from -> to" 字符串 */
export function edgeKey([from, to]) {
    return `${from} -> ${to}`;
}

/**
 * 计算跨层违规边（低层 → 高层），返回 "from -> to" 排序数组。
 * 不豁免同顶层模块：`tool/types.ts(L1) → tool/tool.ts(L3)`、`config/ext.ts(L0) → config/domain(L1)`
 * 这类"包内反向依赖"同样算违规（同层之间的边不会命中，因为要求 layer(to) > layer(from)）。
 */
export function findLayerViolations(edges) {
    const out = [];
    for (const [from, to] of edges) {
        if (!from.startsWith('src/') || !to.startsWith('src/')) continue;
        if (from === to) continue;
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
    return {
        ...g,
        cycles,
        violations,
        inCycle,
        maxCycle: cycles[0] ? cycles[0].length : 0,
        unclassified: unclassifiedFiles(g.files),
    };
}
