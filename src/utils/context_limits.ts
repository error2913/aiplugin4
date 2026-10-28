// 上下文预算/保留强度/压缩参数的纯常量与纯函数（L1，无任何 import）。
//
// 与 `utils/context_budget.ts` 的分工：
// - 本文件只放"纯逻辑"：编译层（context/view/compile.ts，要求纯函数）与配置层（config/configs）直接用它，
//   避免把 Config 等 L2 依赖带进编译器/配置注册的模块加载图；
// - `utils/context_budget.ts` 放"配置/探测窗口解析"适配层（会 import Config/model）。

/** 保留强度默认值（百分比） */
export const DEFAULT_RETAIN_PERCENT = 30;
/** 单批压缩送入摘要器的 token 上限（沿用手写常量，避免摘要质量/成本波动） */
export const COMPACT_BATCH_TOKENS = 6000;
/** 单次自动压缩最多连续压多少批（防止一轮卡太久） */
export const COMPACT_MAX_BATCHES_PER_RUN = 20;
/** 手动 `.ai ctx archive` 单次最多压多少批（安全上限） */
export const COMPACT_ARCHIVE_MAX_BATCHES = 200;
/** 摘要文本硬上限（生成端与注入端统一） */
export const SUMMARY_MAX_CHARS = 4000;
/** 记忆桥后台抽取的积压水位（token）；原「摘要水位」默认行为等价常量 */
export const MEMORY_WATERMARK_TOKENS = 6000;
/** 时间锚点：与上一条已显示时间相隔多少秒时补 `[time]` */
export const TAG_ANCHOR_GAP_SEC = 3600;
/** 时间锚点：每经过多少条 user/assistant 消息至少显示一次 `[time]` */
export const TAG_ANCHOR_EVERY_MESSAGES = 100;
/** 每小时自动压缩批次数上限默认值 */
export const DEFAULT_HOURLY_COMPACT_CAP = 20;

/** 保留强度归一：1-100 之外的输入回退默认值（不静默抛错，由配置层决定是否 warning） */
export function normalizeRetainPercent(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_RETAIN_PERCENT;
    const v = Math.floor(n);
    return v >= 1 && v <= 100 ? v : DEFAULT_RETAIN_PERCENT;
}

/** 保留强度 → 压缩后保留的最新原文 token 目标（至少 1） */
export function retainedTargetTokens(permanentBudget: number, percent: number): number {
    const budget = Number.isFinite(permanentBudget) ? Math.max(0, Math.floor(permanentBudget)) : 0;
    if (budget <= 0) return 0;
    const pct = normalizeRetainPercent(percent);
    return Math.max(1, Math.floor((budget * pct) / 100));
}
