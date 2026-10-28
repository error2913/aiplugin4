// 会话预算解析适配层（L2）：把「配置/会话覆盖/探测窗口/临时 cap」解析成编译与压缩共用的口径。
//
// 纯常量/纯函数在 `utils/context_limits.ts`（L1，无 import），编译层与配置层直接用它；
// 本文件会 import Config/model，只给调用方（message/commands/bridge）使用。
import Config from "../config/config";
import { resolveEffectiveMaxTokens } from "../model/api_error";
import { getProbedContextWindow } from "../model/window_cache";

import { normalizeRetainPercent, retainedTargetTokens } from "./context_limits";

/** 会话级预算解析所需的最小结构（不 import session，避免 L2→L3 反向依赖） */
export interface BudgetSessionLike {
    setting?: { overrides?: Record<string, unknown> };
    context?: { v2BudgetCapValue?: number | null };
}

export interface ContextBudgets {
    /** 永久预算：配置/会话覆盖 → 探测窗口；**不含** context_too_long 的临时 cap */
    permanentBudget: number;
    /** 本轮请求预算：permanentBudget 与临时 cap 的较小值 */
    requestBudget: number;
    retainPercent: number;
    /** 压缩后保留的最新原文目标 token（永久预算 × 保留强度） */
    targetTokens: number;
    /** 标签边界 token（与 targetTokens 相同；单列便于调用方语义化） */
    tagBoundaryTokens: number;
}

/**
 * 解析会话预算（编译、压缩、命令三处共用同一口径）：
 * - 会话 `overrides.ctxBudgetTokens` 优先于全局「上下文预算」；
 * - 0 = 跟随报错探测到的模型窗口 × 0.8（未探测回退默认值）；
 * - 永久预算不受 `v2BudgetCap`（context_too_long 临时收紧）影响；请求预算才扣 cap。
 * - 会话 `overrides.ctxRetainPercent` 可覆盖全局保留强度（1-100）。
 */
export function resolveContextBudgets(session: BudgetSessionLike | undefined, modelName = ''): ContextBudgets {
    const overrideBudget = session?.setting?.overrides?.ctxBudgetTokens;
    const base = typeof overrideBudget === 'number' && overrideBudget > 0 ? overrideBudget : Config.context.BUDGET_TOKENS;
    const probed = getProbedContextWindow(modelName || '');
    const resolved = resolveEffectiveMaxTokens(base, probed).tokens;
    const permanentBudget = Math.max(1, Math.floor(resolved));
    const cap = session?.context?.v2BudgetCapValue;
    const requestBudget = typeof cap === 'number' && cap > 0
        ? Math.min(permanentBudget, Math.floor(cap))
        : permanentBudget;
    const overrideRetain = session?.setting?.overrides?.ctxRetainPercent;
    const retainPercent = typeof overrideRetain === 'number'
        ? normalizeRetainPercent(overrideRetain)
        : normalizeRetainPercent(Config.context.RETAIN_PERCENT);
    const targetTokens = retainedTargetTokens(permanentBudget, retainPercent);
    return {
        permanentBudget,
        requestBudget,
        retainPercent,
        targetTokens,
        tagBoundaryTokens: targetTokens,
    };
}
