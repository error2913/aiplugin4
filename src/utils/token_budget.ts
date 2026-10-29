// Token 预算文本截断（L1 叶子）：按注入的 token 估算器把文本裁到给定 token 上限。
//
// 为什么单独成文件：工具结果截断（编译层/旧回退路径/子代理）与旧用户消息截断都需要
// "按 token 而不是字符"裁剪，但各层可用的估算器不同（主链 estimateTextTokens / 子代理
// 自带估算）。本文件不 import 任何模块，估算器由调用方注入，便于复用与单测。
//
// 约定：
// - `maxTokens <= 0` 表示**不截断**（与配置 0=关闭一致），原样返回；
// - 估算器必须随文本长度单调不减（本文件用二分查找最长可保留前缀/后缀）；
// - 截断只做文本裁剪，不追加任何标记（标记由调用方按协议追加）。

/** 截断后的切片结果 */
export interface TokenBudgetSlice {
    /** 截断后的文本（head-only 或 head+tail；未截断时为原文） */
    text: string;
    /** 是否发生截断 */
    truncated: boolean;
    /** 展示部分估算 token */
    shownTokens: number;
    /** 原文本估算 token */
    totalTokens: number;
}

/** token 估算器：输入文本返回 token 数（必须随长度单调不减） */
export type TokenEstimator = (text: string) => number;

/** 中段截断占位符（与 window_policy.truncateMiddle 一致） */
const MIDDLE_ELLIPSIS = '…';

/**
 * 二分查找最长前缀长度，使 estimate(prefix) <= maxTokens。
 * 前缀估算单调不减，所以可直接二分；结果不会切在 UTF-16 代理对中间。
 */
function largestPrefix(text: string, maxTokens: number, estimate: TokenEstimator): number {
    if (maxTokens <= 0 || text.length === 0) return 0;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimate(text.slice(0, mid)) <= maxTokens) lo = mid;
        else hi = mid - 1;
    }
    return safeCut(text, lo);
}

/**
 * 二分查找最长后缀长度，使 estimate(suffix) <= maxTokens。
 * 后缀同样单调；结果不会切在 UTF-16 代理对中间。
 */
function largestSuffix(text: string, maxTokens: number, estimate: TokenEstimator): number {
    if (maxTokens <= 0 || text.length === 0) return 0;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimate(text.slice(text.length - mid)) <= maxTokens) lo = mid;
        else hi = mid - 1;
    }
    return safeCut(text, lo);
}

/** 避免把代理对拆成两半：切点落在低位代理前时回退一位 */
function safeCut(text: string, cut: number): number {
    if (cut <= 0 || cut >= text.length) return Math.max(0, Math.min(cut, text.length));
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) return cut - 1;
    return cut;
}

/**
 * 只保留开头（head-only），按 token 上限裁剪。
 * 适合"第 1 页 = 前 N token，后续用 read_raw 游标继续读"的截断分页语义。
 */
export function truncateToTokenBudget(text: string, maxTokens: number, estimate: TokenEstimator): TokenBudgetSlice {
    const source = String(text ?? '');
    const totalTokens = estimate(source);
    if (maxTokens <= 0 || totalTokens <= maxTokens) {
        return { text: source, truncated: false, shownTokens: totalTokens, totalTokens };
    }
    const keep = largestPrefix(source, maxTokens, estimate);
    const kept = source.slice(0, keep);
    return { text: kept, truncated: true, shownTokens: estimate(kept), totalTokens };
}

/**
 * 保留头 + 尾（头约占 2/3、尾约占 1/3），按 token 上限裁剪。
 * 与 `window_policy.truncateMiddle` 的字符版语义一致，供旧用户消息兜底使用。
 */
export function truncateMiddleToTokenBudget(text: string, maxTokens: number, estimate: TokenEstimator): TokenBudgetSlice {
    const source = String(text ?? '');
    const totalTokens = estimate(source);
    if (maxTokens <= 0 || totalTokens <= maxTokens) {
        return { text: source, truncated: false, shownTokens: totalTokens, totalTokens };
    }
    const headBudget = Math.max(1, Math.floor((maxTokens * 2) / 3));
    const tailBudget = Math.max(0, maxTokens - headBudget);
    const headLen = largestPrefix(source, headBudget, estimate);
    const tailLen = largestSuffix(source, tailBudget, estimate);
    // 头尾已覆盖全文（估算为整数舍入导致）：仍算截断，但不产生重复/倒序内容
    if (headLen + tailLen >= source.length) {
        const kept = source.slice(0, Math.max(0, source.length - 0));
        return { text: kept, truncated: true, shownTokens: estimate(kept), totalTokens };
    }
    const middle = `${MIDDLE_ELLIPSIS}`;
    const kept = tailLen > 0
        ? `${source.slice(0, headLen)}${middle}${source.slice(source.length - tailLen)}`
        : `${source.slice(0, headLen)}${middle}`;
    return { text: kept, truncated: true, shownTokens: estimate(kept), totalTokens };
}
