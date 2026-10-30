// 判定上下文选择（L2，纯函数）：按 token 预算从**最新往前**选历史（方案 §6.6）。
//
// 为什么单独成文件：`[model] context_tokens` 是 judge 的唯一范围口径（0 = 不注入历史），
// 旧实现按「最近 N 条消息」取，而待机群里所有群聊消息可能合并在同一条 user 消息内，
// 条数口径会失控。这里改成 token 口径：从最新往前累加，装不下就截断。
//
// 约定（与 utils/token_select 的通用口径一致）：
// - budget <= 0 → 返回空（0 = 不注入历史，不是「无限」）；
// - 返回顺序与入参一致（旧→新），便于拼接渲染；
// - alwaysKeepLatest（默认 true）：budget > 0 但最新一条自身超预算时仍保留它，避免判定
//   「瞎看历史」；需要严格预算的调用方传 false（judge/prompt 的历史区即传 false，因为当前
//   候选消息由独立字段保证注入）；
// - estimate 可注入；缺省按 `utils/token_estimate.estimateTextTokens` 估算字符串或 `{text}`。
//
// 实现已下沉到 `utils/token_select`（全插件统一的选择纯函数）；本文件只保留判定侧的默认
// 估算器与既有导出签名，避免调用点/单测因重构改动。
import { estimateTextTokens } from '../utils/token_estimate';
import { selectByTokenBudget } from '../utils/token_select';

/** 选择选项 */
export interface SelectHistoryOptions {
    /** 最新一条自身超预算时是否仍保留（默认 true） */
    alwaysKeepLatest?: boolean;
}

/** 缺省估算器：字符串直接用；对象取 `.text`；其余按空串 */
function defaultEstimate<T>(item: T): number {
    if (typeof item === 'string') return estimateTextTokens(item);
    if (item && typeof item === 'object') {
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') return estimateTextTokens(text);
    }
    return 0;
}

/**
 * 按 token 预算从最新往前选历史。
 * @param items 历史条目（旧 → 新）
 * @param budget token 预算（<=0 返回空）
 * @param estimate 条目的 token 估算（可注入，保证纯函数可测）
 * @param options alwaysKeepLatest 等选项
 */
export function selectHistoryByTokens<T>(
    items: readonly T[],
    budget: number,
    estimate: (item: T) => number = defaultEstimate as (item: T) => number,
    options: SelectHistoryOptions = {},
): T[] {
    return selectByTokenBudget(items, estimate, budget, { alwaysKeepLatest: options.alwaysKeepLatest !== false });
}
