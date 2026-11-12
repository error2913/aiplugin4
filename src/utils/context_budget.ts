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

// ---------------- 归档预算 L（#163 REQ-D7-10/11，唯一实现） ----------------
//
// `L` = 永久预算 − 固定提示词（system + samples + 工具 schema + runtime 段）。
// 编译层与「注入写入前的预算闸」必须调**同一函数**，否则两处口径漂移会出现
// 「注入以为装得下、编译以为装不下」的裂缝（REQ-D7-11）。

export interface ArchiveBudgetInput {
    /** 永久预算（已乘校准系数，不含 context_too_long 临时 cap） */
    permanentBudget: number;
    /** system + samples 的 token 估算 */
    prefixTokens: number;
    /** 元工具 schema 预留（D8-05 常量） */
    toolsReserveTokens: number;
    /** runtime 段（PR-08 后恒为 0；保留字段以维持单一口径） */
    runtimeTokens: number;
}

/**
 * `L = max(1, permanentBudget − prefix − tools − runtime)`（纯函数，无 Config/无副作用）。
 *
 * 数值与旧内联写法**逐位相同**（`message.ts` 的 `Math.max(1, permanentBudget - fixedPromptTokens)`），
 * 抽出来的唯一目的是让注入侧不必复制公式。
 */
export function resolveArchiveL(input: ArchiveBudgetInput): number {
    const permanent = Math.max(0, Math.floor(Number(input.permanentBudget) || 0));
    const fixed = Math.max(0, Math.floor(Number(input.prefixTokens) || 0))
        + Math.max(0, Math.floor(Number(input.toolsReserveTokens) || 0))
        + Math.max(0, Math.floor(Number(input.runtimeTokens) || 0));
    return Math.max(1, permanent - fixed);
}

export interface ContextBudgets {
    /** 永久预算：配置/会话覆盖 → 探测窗口；**不含** context_too_long 的临时 cap */
    permanentBudget: number;
    /** 本轮请求预算：permanentBudget 与临时 cap 的较小值 */
    requestBudget: number;
    retainPercent: number;
    /** 压缩后保留的最新原文目标 token（永久预算 × 保留强度） */
    targetTokens: number;
    // #163 D2（PR-09）：`tagBoundaryTokens` 已删除 —— 标签分级（[msg_id]/[time] 按预算边界开合）
    // 整体移除后，`targetTokens` 是唯一保留强度口径。保留重复字段只会诱导后人重新引入边界逻辑。
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
    };
}
