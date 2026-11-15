// 缓存命中率展示（纯函数叶子，零 import）：`.ai ctx` 与 `.ai status` 共用同一口径。
// 只读：不写存储、不读配置、不触发编译，任何字段缺失返回 null（降级为「无数据」）。
export interface CacheWindowLike {
    /** 窗口内的有效轮次（只累计 prompt_tokens > 0 的成功请求） */
    turns: number;
    /** 窗口内输入 token 合计（分母） */
    prompt: number;
    /** 窗口内命中缓存的 token 合计（分子） */
    read: number;
}

/** 归一化命中率（0~1）；无有效样本返回 null（调用方降级为「暂无数据」，不得用 0 冒充实测值） */
export function cacheHitRate(w?: CacheWindowLike | null): number | null {
    const turns = Math.max(0, Math.floor(Number(w?.turns) || 0));
    const prompt = Math.max(0, Math.floor(Number(w?.prompt) || 0));
    if (turns <= 0 || prompt <= 0) return null;
    const read = Math.max(0, Math.floor(Number(w?.read) || 0));
    // 夹紧：各方言的 prompt_tokens 都含缓存读（见 model/adapter.ts:66-81），read<=prompt 恒成立；
    // 夹紧只为防中转/网关回传异常值导致展示出「140.0%」
    return Math.min(1, read / prompt);
}

/** 展示片段：`73.5%（近 8 轮）` / `-（本会话暂无数据）` */
export function formatCachePercent(w?: CacheWindowLike | null): string {
    const rate = cacheHitRate(w);
    if (rate === null) return '-（本会话暂无数据）';
    const turns = Math.max(0, Math.floor(Number(w?.turns) || 0));
    return `${(rate * 100).toFixed(1)}%（近 ${turns} 轮）`;
}
