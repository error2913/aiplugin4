// Token 预算选择（L2 纯函数）：按 token 预算从「最新」往前选条目，而不是按条数/轮数。
//
// 为什么需要（方案 §11.1）：插件内「读取/渲染/注入的范围」统一用 token 预算，条数只允许作为
// 速率/配额或非消息计数存在。调用点不要再写 `slice(-N)` / 「最近 N 条」。
//
// 约定（调用方必须理解；0 语义不隐式回退条数）：
// - items 必须按时间升序（旧 → 新）；返回值**保持升序**，便于直接拼接渲染；
// - budget <= 0（含 NaN/Infinity 等非有限值）→ 返回 []（0 = 不注入任何条目，不是「无限」）；
// - 从最新往前累加；遇到第一条装不下的条目就停（不跳过它去选更旧的，保证时间连续性）；
// - alwaysKeepLatest（默认 true）：budget > 0 但最新一条自身就超预算时仍保留它，避免
//   「看不到最新内容」；需要严格预算的调用方显式传 false（判定历史即传 false，当前候选消息
//   由独立字段保证注入）；
// - estimate 异常 / 返回非数值 / 返回负数 → 该条按 0 计（防呆，不因估算器抛错打断选择）；
// - opts.from 目前只支持 'newest'（从最新往前），其它值按 'newest' 处理（字段保留给未来扩展）；
// - 本文件不 import 任何模块（L2 叶子），估算器与条目全部由调用方注入，便于纯函数单测。
//
// 与 `utils/token_budget` 的分工：token_budget 裁「一段文本」，本文件选「一组条目」。
// 与 `judge/context_select` 的关系：后者是本函数的判定侧薄封装（保留既有导出签名）。

/** 选择方向/选项 */
export interface SelectByTokenBudgetOptions {
    /** 选择方向：目前仅 'newest'（按时间升序入参、从最新往前累加） */
    from?: 'newest';
    /** 最新条目自身超预算时是否仍保留（默认 true） */
    alwaysKeepLatest?: boolean;
}

/**
 * 按 token 预算从最新往前选择条目。
 * @param items 条目（必须按时间升序：旧 → 新）
 * @param estimate 条目 token 估算器（可注入，保证纯函数可测）
 * @param budget token 预算（<=0/非有限值返回空数组；0 = 不注入）
 * @param opts 选项（alwaysKeepLatest 默认 true）
 * @returns 选中的条目（保持入参升序）
 */
export function selectByTokenBudget<T>(
    items: readonly T[],
    estimate: (item: T) => number,
    budget: number,
    opts: SelectByTokenBudgetOptions = {},
): T[] {
    if (!Array.isArray(items) || items.length === 0) return [];
    const safeBudget = Number.isFinite(budget) ? budget : 0;
    if (safeBudget <= 0) return [];
    // from 目前只有 'newest'；非法/缺省都按 newest（字段保留兼容未来 'oldest' 扩展）
    const alwaysKeepLatest = opts.alwaysKeepLatest !== false;
    const costOf = (item: T): number => {
        if (typeof estimate !== 'function') return 0;
        let value: number;
        try {
            value = estimate(item);
        } catch (_e) {
            return 0;
        }
        return Number.isFinite(value) && value > 0 ? value : 0;
    };

    const picked: T[] = [];
    let used = 0;
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const cost = costOf(item);
        if (used + cost <= safeBudget) {
            picked.push(item);
            used += cost;
            continue;
        }
        // 超预算：一条都还没选时按 alwaysKeepLatest 决定是否保留最新一条；否则直接截断
        if (picked.length === 0 && alwaysKeepLatest) picked.push(item);
        break;
    }
    return picked.reverse();
}
