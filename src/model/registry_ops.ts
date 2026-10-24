// 模型注册表候选解析（叶子）：用途资格、候选排序、三层解析（运行时覆盖 > 配置绑定 > 首个可用）、按 ref 反查。
// 从 model.ts 拆出——解析只依赖 entries/purposes/覆盖三份数据，便于单测；model.ts 保留同名静态方法委派。
import Logger from "../logger";

import type { ModelEntry } from "./entry";
import type { ModelUse } from "./types";

const log = Logger.withTag('model');

/** 解析所需的最小注册表视图（Model 静态注册表结构满足） */
export interface ModelRegistryHost {
    entries: ModelEntry[];
    purposeModelOverrides: Partial<Record<ModelUse, string>>;
    configPurposes: Partial<Record<ModelUse, string[]>>;
}

export function isEligible(e: ModelEntry, use: ModelUse): boolean {
    if (use === 'text-embedding') return e.tags.includes('embed');
    if (use === 'image-understanding') return e.tags.includes('vision');
    if (use === 'image-generation') return e.tags.includes('gen');
    if (use === 'tts') return e.tags.includes('tts');
    // chat / compression / summarization / judge：排除嵌入、生图与语音
    return !e.tags.includes('embed') && !e.tags.includes('gen') && !e.tags.includes('tts');
}

/**
 * 某用途的候选列表，**按用户的优先顺序排**（purposes 里列出的在前，下标越小越优先；
 * 未列出的排在其后，保持连接顺序 + 列表顺序）。
 *
 * 这是"按顺序取用"的唯一实现点：`resolveForUse` 取 pool[0]，
 * `pickFallbackModel` 顺着 pool 往后切 —— 两处都自动服从用户排序，不必各自改。
 * sort 是稳定的，所以未列出那批的相对顺序不变。
 */
export function listModelsForUse(host: ModelRegistryHost, use: ModelUse): ModelEntry[] {
    const pool = host.entries.filter(e => isEligible(e, use));
    const pref = host.configPurposes[use];
    if (!pref || pref.length === 0) return pool;
    const rank = new Map<string, number>();
    pref.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
    const unlisted = pref.length;
    return pool.slice().sort((a, b) => {
        const ra = rank.has(a.ref) ? rank.get(a.ref)! : unlisted;
        const rb = rank.has(b.ref) ? rank.get(b.ref)! : unlisted;
        return ra - rb;
    });
}

/**
 * 解析 use 当前生效模型，分三层（方案 6.3）：
 *   1. storage 运行时覆盖（.ai model 写的）—— 优先级最高，**单个** ref
 *   2. 配置里的 purposes —— **有序数组**，取第一个有效的
 *   3. 该用途候选中的第一个（已按用户顺序排过）
 * 任一层引用失效（模型退役/改名/用途不符）时**保留现场并记日志**，回退下一层。
 */
export function resolveForUse(host: ModelRegistryHost, use: ModelUse): ModelEntry | null {
    const overrideRef = host.purposeModelOverrides[use];
    if (overrideRef) {
        const e = findModelByRef(host, overrideRef, use);
        if (e) return e;
        log.warning(`运行时覆盖 ${overrideRef}（${use}）已失效，回退配置默认`);
    }

    const configList = host.configPurposes[use];
    if (configList && configList.length > 0) {
        // 依次试用户排的顺序，取第一个**仍然有效**的（前面几个可能已退役/改名）
        for (const id of configList) {
            const e = findModelByRef(host, id, use);
            if (e) return e;
        }
        log.warning(`配置绑定的 ${configList.join(' / ')}（${use}）均已失效，回退首个可用模型`);
    }

    const pool = listModelsForUse(host, use);
    return pool.length > 0 ? pool[0] : null;
}

/** 当前 use 的解析来源（供 .ai model 标注"这个绑定来自哪一层"） */
export function resolveSourceForUse(host: ModelRegistryHost, use: ModelUse): 'override' | 'config' | 'auto' | 'none' {
    const ov = host.purposeModelOverrides[use];
    if (ov && findModelByRef(host, ov, use)) return 'override';
    const cf = host.configPurposes[use];
    if (cf && cf.some(id => findModelByRef(host, id, use))) return 'config';
    return listModelsForUse(host, use).length > 0 ? 'auto' : 'none';
}

/** 按 ref 查找模型实例（可选 use 时校验用途资格），供 .ai model / 自动切换复用 */
export function findModelByRef(host: ModelRegistryHost, ref: string, use?: ModelUse): ModelEntry | null {
    if (!ref) return null;
    let entry: ModelEntry | null = null;
    const idxMatch = ref.match(/^\[(\d+)\]:\s*(.+)$/);
    if (idxMatch) {
        const connIndex = parseInt(idxMatch[1], 10);
        const name = idxMatch[2].trim();
        entry = host.entries.find(e => e.connIndex === connIndex && e.name === name) || null;
    } else {
        // 1) 精确匹配 ref：v5 是配置里的**模型 id**；v4/唯一名时 ref 就等于模型名
        entry = host.entries.find(e => e.ref === ref) || null;
        // 2) 退回按模型名匹配，但**仅当唯一** —— 重名时必须判为歧义，
        //    交由上层提示用户使用完整标识（保持 v4 既有语义）
        if (!entry) {
            const byName = host.entries.filter(e => e.name === ref);
            if (byName.length === 1) entry = byName[0];
        }
    }
    if (!entry) return null;
    if (use && !isEligible(entry, use)) return null;
    return entry;
}
