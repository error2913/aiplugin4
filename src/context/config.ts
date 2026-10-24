// Context v2 的配置语义（纯逻辑）：新 7 键的默认值、范围校验与旧行为派生。
// 注册层（config/configs/context.ts）在 P2 切换时改为读取这些键；本文件不依赖 seal。
export interface ContextV2Settings {
    /** 上下文预算 token；0=跟随探测到的模型窗口×0.8 */
    budgetTokens: number;
    /** 保留强度（百分比，1-100）：最近内容至少占预算的比例 */
    retainPercent: number;
    /** 摘要水位 token；0=关闭自动摘要 */
    summaryWatermarkTokens: number;
    /** 原文保留天数；0=永久（默认） */
    retainDays: number;
    /** 待机群每小时入库配额；0=不限（高级） */
    standbyIngestQuota: number;
    /** 每小时自动压缩次数上限；0=不限（高级） */
    hourlyCompactCap: number;
    /** 原文保留页数上限；0=不限（高级） */
    maxRetainedPages: number;
}

export const DEFAULT_CONTEXT_V2_SETTINGS: Readonly<ContextV2Settings> = Object.freeze({
    budgetTokens: 0,
    retainPercent: 40,
    summaryWatermarkTokens: 6000,
    retainDays: 0,
    standbyIngestQuota: 0,
    hourlyCompactCap: 6,
    maxRetainedPages: 0,
});

export interface NormalizedSettings {
    settings: ContextV2Settings;
    warnings: string[];
}

function intOr(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
}

/**
 * 校验/归一配置：
 * - budget/watermark/retainDays/quota/hourlyCap/maxPages 允许 0（语义见字段注释）；
 * - retainPercent 限制在 1-100；
 * - 非法值回退默认并给 warning（不静默）。
 */
export function normalizeContextV2Settings(raw: Partial<Record<keyof ContextV2Settings, unknown>>): NormalizedSettings {
    const warnings: string[] = [];
    const d = DEFAULT_CONTEXT_V2_SETTINGS;
    const budgetTokens = intOr(raw.budgetTokens, d.budgetTokens);
    let retainPercent = intOr(raw.retainPercent, d.retainPercent);
    let summaryWatermarkTokens = intOr(raw.summaryWatermarkTokens, d.summaryWatermarkTokens);
    let retainDays = intOr(raw.retainDays, d.retainDays);
    let standbyIngestQuota = intOr(raw.standbyIngestQuota, d.standbyIngestQuota);
    let hourlyCompactCap = intOr(raw.hourlyCompactCap, d.hourlyCompactCap);
    let maxRetainedPages = intOr(raw.maxRetainedPages, d.maxRetainedPages);

    if (budgetTokens < 0) {
        warnings.push(`上下文预算 ${budgetTokens} 非法，按 0（跟随模型窗口）处理`);
    }
    if (retainPercent < 1 || retainPercent > 100) {
        warnings.push(`保留强度 ${retainPercent}% 超出 1-100，已回退 ${d.retainPercent}%`);
        retainPercent = d.retainPercent;
    }
    if (summaryWatermarkTokens < 0) {
        warnings.push(`摘要水位 ${summaryWatermarkTokens} 非法，按 0（关闭自动摘要）处理`);
        summaryWatermarkTokens = 0;
    }
    if (retainDays < 0) {
        warnings.push(`原文保留天数 ${retainDays} 非法，按 0（永久保留）处理`);
        retainDays = 0;
    }
    if (standbyIngestQuota < 0) {
        warnings.push(`待机入库配额 ${standbyIngestQuota} 非法，按 0（不限）处理`);
        standbyIngestQuota = 0;
    }
    if (hourlyCompactCap < 0) {
        warnings.push(`每小时压缩上限 ${hourlyCompactCap} 非法，按 0（不限）处理`);
        hourlyCompactCap = 0;
    }
    if (maxRetainedPages < 0) {
        warnings.push(`原文保留页数上限 ${maxRetainedPages} 非法，按 0（不限）处理`);
        maxRetainedPages = 0;
    }

    return {
        settings: {
            budgetTokens: Math.max(0, budgetTokens),
            retainPercent,
            summaryWatermarkTokens: Math.max(0, summaryWatermarkTokens),
            retainDays,
            standbyIngestQuota,
            hourlyCompactCap,
            maxRetainedPages,
        },
        warnings,
    };
}

/** 保留强度 → 最近内容的最小 token 预算（至少 1） */
export function retainedBudgetTokens(settings: ContextV2Settings, totalBudget: number): number {
    if (totalBudget <= 0) return 0;
    return Math.max(1, Math.floor(totalBudget * settings.retainPercent / 100));
}

export type ContextConfigKey =
    | '上下文预算'
    | '保留强度'
    | '摘要水位'
    | '原文保留天数'
    | '待机入库配额'
    | '每小时后台压缩上限'
    | '原文保留页数上限';

/** 从「新配置键 → 值」映射构造配置（注册层直接复用） */
export function settingsFromConfigValues(values: Partial<Record<ContextConfigKey, unknown>>): NormalizedSettings {
    return normalizeContextV2Settings({
        budgetTokens: values['上下文预算'],
        retainPercent: values['保留强度'],
        summaryWatermarkTokens: values['摘要水位'],
        retainDays: values['原文保留天数'],
        standbyIngestQuota: values['待机入库配额'],
        hourlyCompactCap: values['每小时后台压缩上限'],
        maxRetainedPages: values['原文保留页数上限'],
    });
}
