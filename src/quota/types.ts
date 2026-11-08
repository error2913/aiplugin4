// 用量限制（配额）类型与错误类型（L1 纯逻辑，**零 import**）。
//
// 为什么不放在 `src/quota/` 之外：`deps.mjs:119` 的 `src/(\w+)/types.ts → L1` 规则让本文件
// 成为整个 quota 模块的依赖底座；任何 import 都会把它拉成 L2，进而与 manager 成环。
//
// 不变量（与 .dev/issue-59-requirements.md §6 对齐）：
// - 三个窗口（5 小时 / 周 / 月）**固定边界、惰性重置**（键变了就视 0），从不启动定时器；
// - 计数口径 = `prompt_tokens + completion_tokens`（缓存读写按 100% 计，不做价格换算）；
// - `limit === Infinity` 统一表示「不限」（配置里的 `0` 在判定处折算成 Infinity）。

/** 限额窗口：5 小时 / 周 / 月 */
export type WindowKey = 'h' | 'w' | 'm';

/** 命中维度：总量 / 会话 / 个人 / 用途 */
export type QuotaDimension = 'total' | 'session' | 'user' | 'purpose';

/** 受配额约束的语言模型用途（媒体用途不走配额） */
export type QuotaPurposeUse = 'summarization' | 'judge' | 'image-understanding' | 'text-embedding';

/** 单个窗口的计数器：`k` 是窗口键（与当前键不符 ⇒ 视为 0），`v` 是已用 token */
export interface Counter {
    k: string;
    v: number;
}

/** 三窗口一组 */
export interface WinCounter {
    h: Counter;
    w: Counter;
    m: Counter;
}

/** 一个维度的条目：三窗口 + 最后记账时刻（用于 31 天裁剪） */
export interface DimEntry extends WinCounter {
    seen: number;
}

/** 插件存储 `quotaUsage` 的结构（version 不符 ⇒ 整体丢弃重建） */
export interface QuotaStore {
    version: 1;
    /** 观测到的最大时间戳；用于检测时钟回拨（回拨时跳过窗口重置，保住计数） */
    lastNow: number;
    /** 全部 chat 流量的总量 */
    total: WinCounter;
    /** chat 按会话 */
    sessions: { [sid: string]: DimEntry };
    /** chat 按触发者（无触发者的轮次不建键） */
    users: { [uid: string]: DimEntry };
    /** 非 chat 的语言用途（≤4 个键） */
    purposes: { [use: string]: DimEntry };
}

/** 一次请求/一轮对话的配额归属；两者都可能缺失（缺 userId = 不受个人限制） */
export interface QuotaIdentity {
    sessionId?: string;
    userId?: string;
}

/** 峰时片段（已展开为「某 ISO 星期几的当日分钟区间」） */
export interface PeakSegment {
    /** ISO 星期几：1=周一 … 7=周日 */
    day: number;
    /** 开始（当日分钟数） */
    start: number;
    /** 结束（当日分钟数；跨 0 点的片段会被展开成次日 0 点起，故此值恒 > start） */
    end: number;
    /** 该片段内的预算百分比（1~100，是乘在总限制上的系数） */
    pct: number;
    /** 来源框号（1-based，告警文案用） */
    frame: number;
    /** 来源原文（渲染「命中「1-5 14:00-18:00-30」」用） */
    raw: string;
}

/** 解析后的峰时规则：空 segments = 不收紧（绝不回退默认值） */
export interface PeakRule {
    segments: PeakSegment[];
    /** 已带「第 N 框」前缀的告警文案，由调用方逐条 logger.warning */
    warnings: string[];
}

/** 一次拒绝的结构化原因（既用于 QuotaExceededError，也用于粗闸返回值） */
export interface QuotaDenial {
    window: WindowKey;
    dimension: QuotaDimension;
    /** dimension === 'purpose' 时标明是哪个用途 */
    use?: QuotaPurposeUse;
    /** 判定时刻的已用量（含 inflight 预留） */
    used: number;
    /** 判定时刻的有效上限；`Infinity` = 不限 */
    limit: number;
}

/** 预留句柄：`release()` 幂等且永不抛（漏释放会让该会话之后的所有 chat 被自己的预留挡住） */
export interface QuotaReserveHandle {
    readonly est: number;
    release(): void;
}

/** `.ai tk quota` 的渲染数据源（一次性快照，读内存缓存，无副作用） */
export interface QuotaStatus {
    enabled: boolean;
    now: number;
    /** 当前预算系数 0..1（未命中峰时 = 1） */
    peakPercent: number;
    /** 当前命中的峰时片段原文；未命中为 null */
    peakSegment?: string | null;
    windows: { [K in WindowKey]: { key: string; used: number; limit: number; resetAt: number } };
    session?: { used: number; limit: number };
    user?: { used: number; limit: number };
    purposes: { [use: string]: { used: number; limit: number } };
}

/** `.ai tk rank` 的一行：`percent === null` 表示该窗口不限（渲染 `-`，绝不除零） */
export interface QuotaRankRow {
    sessionId: string;
    used: number;
    percent: number | null;
}

/**
 * 配额拒绝错误。
 *
 * **故意不继承 `ApiError`**：继承会让 `handleModelError` 把它当成可恢复的 API 错误
 * （自动切模型 / 归档重试 / aux 熔断），把「超限」变成「反复重试」。
 * 因此每个 catch 都必须显式 `instanceof QuotaExceededError` 分流。
 */
export class QuotaExceededError extends Error {
    readonly denial: QuotaDenial;
    readonly window: WindowKey;
    readonly dimension: QuotaDimension;
    readonly use?: QuotaPurposeUse;
    readonly used: number;
    readonly limit: number;

    constructor(denial: QuotaDenial) {
        super(QuotaExceededError.describe(denial));
        this.name = 'QuotaExceededError';
        this.denial = denial;
        this.window = denial.window;
        this.dimension = denial.dimension;
        this.use = denial.use;
        this.used = denial.used;
        this.limit = denial.limit;
        // 保持原型链（ES2017 target 下 extends Error 需要显式修）
        Object.setPrototypeOf(this, QuotaExceededError.prototype);
    }

    /** 短摘要（结构化、不含全局预算）；面向用户的完整文案由 QuotaManager.formatDenialText 生成 */
    private static describe(denial: QuotaDenial): string {
        const win = denial.window === 'h' ? '5小时' : denial.window === 'w' ? '周' : '月';
        const dim = denial.dimension === 'purpose' && denial.use ? `用途(${denial.use})` : denial.dimension;
        const limit = Number.isFinite(denial.limit) ? String(denial.limit) : '∞';
        return `quota exceeded: ${win}/${dim} used=${denial.used} limit=${limit}`;
    }
}

/** 类型守卫：catch 里用它分流比裸 instanceof 更能兼容跨 bundle 场景 */
export function isQuotaExceeded(e: unknown): e is QuotaExceededError {
    return e instanceof QuotaExceededError;
}
