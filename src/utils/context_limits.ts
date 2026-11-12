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
// #163 D2（PR-09）：`TAG_ANCHOR_GAP_SEC` / `TAG_ANCHOR_EVERY_MESSAGES` 已删除 ——
// 历史层不再按"距上次显示多久 / 隔了多少条"决定是否渲染 `[time]`，因为它让同一段已发送
// 历史的字节随窗口位置漂移（正是本 issue 要消灭的 P6）。时间改由三处提供：
// `kind:'time'` 注入块、`get_time` 工具、`renderSystemEvent` 的 `[time]`（wake 等系统起轮）。
/** 旧回退路径（无事件账本）用户消息纯代码截断的 token 上限 */
export const LEGACY_USER_MESSAGE_MAX_TOKENS = 8192;
/**
 * 单事件渲染的**固定** token 上限（#163 REQ-D2-07）。
 *
 * 删掉预算选择器后，单元级截断不再由 `available` 决定（那会让同一事件的渲染字节随本轮
 * 预算抖动而变，违反 R1）。超限事件一律按这个常量截断并带 `read_raw` 指针 ——
 * 常量恒定 ⇒ 同一事件在任何一轮渲染出的字节都相同。
 */
export const HISTORY_EVENT_MAX_TOKENS = LEGACY_USER_MESSAGE_MAX_TOKENS;

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

/** 对话后总结触发系数（契约 k，写死，不做配置） */
export const ARCHIVE_TRIGGER_RATIO = 0.95;

// ---------------- 增量注入三层额度（#163 REQ-D3-29） ----------------
//
// 三层是**包含**关系：单轮增量 (512) ⊂ 活动总量 (4096) ⊂ 硬上界 (5120)。
// 三者都**不开放配置**：改动额度会改变归档时机 ⇒ 每次调参都要一次 rebase，
// 且这三个值是"缓存效率 × 预算冲击"的平衡点，不该让用户调（d3b G.1）。

/** 活动注入块总量上界（token）：超过**触发归档**，绝不跳过注入 */
export const INJECT_ACTIVE_WINDOW_TOKENS = 4096;
/** 单轮注入增量上界（token）：超出部分**拆到后续轮次**，绝不截断条目正文（d3b G.2） */
export const INJECT_PER_TURN_MAX_TOKENS = 512;
/** 冷启动（新会话首次注入）总量上界（token）：可拆 4×512 分批 */
export const INJECT_COLD_START_MAX_TOKENS = 2048;
/** 活动块总量硬上界：只用于断言/告警（超了说明归档没跟上），不用于丢弃 */
export const INJECT_ACTIVE_MAX_TOKENS = INJECT_ACTIVE_WINDOW_TOKENS + 1024;

/** v7 双水位：L=消息上下文预算（已扣固定提示词）、A=保留目标、B=对话触发线、C=待机归档线 */
export interface ArchiveWatermarks {
    L: number;
    A: number;
    B: number;
    C: number;
}

/**
 * 按契约计算双水位：
 * - `A = floor(L × n / 100)`（保留目标，单位是未归档原文 token）
 * - `B = floor(L × 0.95)`（对话后总结触发线）
 * - `C = L + (B − A)`（待机归档线，默认约 1.65L）
 */
export function resolveArchiveWatermarks(messageBudget: number, retainPercent: number): ArchiveWatermarks {
    const L = Number.isFinite(messageBudget) ? Math.max(0, Math.floor(messageBudget)) : 0;
    const pct = normalizeRetainPercent(retainPercent);
    const A = Math.floor((L * pct) / 100);
    const B = Math.floor(L * ARCHIVE_TRIGGER_RATIO);
    const C = L + (B - A);
    return { L, A, B, C };
}
