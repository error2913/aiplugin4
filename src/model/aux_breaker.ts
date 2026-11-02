// 辅助 LLM 进程级熔断（L2，不依赖 seal/Config 之外的可变状态）。
//
// 背景：记忆/归档的 aux 调用失败过去会被 `sendChatRequest` 吞成空串或由各回调兜底，
// 导致 402/401 期间调度器继续排队、每个 AI 轮次都重试。这里把「fatal 类错误」
// 提升为进程级 30 分钟熔断：scheduler 与 context 归档在调用前都查 `isAuxPaused()`。
//
// 同时负责余额类错误时把 `summarization` 用途切到备用模型（只动 summarization，
// 不写 chat 覆盖，避免与主链 handleModelError 互相覆盖）。
import { savePurposeModelOverrides } from "../config/apply/model";
import Config from "../config/config";
import { logger } from "../logger";

import type { ApiErrorKind } from "./api_error";
import { pickNextModel } from "./fallback";
import Model, { type ModelEntry } from "./model";

const log = logger.withTag('aux-breaker');

/** 熔断时长（与 memory_scheduler 的 BREAKER_SEC 对齐） */
const BREAKER_MS = 30 * 60 * 1000;

let pausedUntil = 0;

export function isAuxPaused(now = Date.now()): boolean {
    return pausedUntil > now;
}

export function auxPausedUntil(): number {
    return pausedUntil;
}

/** 记录一次 fatal aux 错误：进入/续期熔断，并打日志。 */
export function noteFatalAuxError(kind?: ApiErrorKind, detail?: string): void {
    pausedUntil = Math.max(pausedUntil, Date.now() + BREAKER_MS);
    log.warning(`[aux] 熔断 ${Math.round(BREAKER_MS / 60000)} 分钟（kind=${kind ?? '?'}${detail ? `: ${detail}` : ''}）`);
}

/** 测试/热重载用 */
export function resetAuxBreaker(): void {
    pausedUntil = 0;
}

/**
 * 余额类错误后把 summarization 用途切到备用模型。
 * 复用「错误处理」页的开关与策略；无候选/开关关闭返回 null。
 */
export function trySwitchSummarizationModel(): ModelEntry | null {
    const { ENABLED, AUTO_SWITCH_MODEL, SWITCH_KINDS, SWITCH_STRATEGY } = Config.error;
    if (!ENABLED || !AUTO_SWITCH_MODEL || !SWITCH_KINDS.includes('balance')) return null;
    const current = Model.getChatModel('summarization');
    const next = pickNextModel(Model.listModelsForUse('summarization'), current, SWITCH_STRATEGY);
    if (!next) return null;
    Model.purposeModelOverrides['summarization'] = next.ref;
    savePurposeModelOverrides();
    log.warning(`[aux] 记忆模型 ${current?.ref ?? '?'} → ${next.ref}（余额类错误自动切换）`);
    return next;
}
