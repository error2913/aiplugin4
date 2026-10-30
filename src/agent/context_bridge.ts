// 记忆桥：只从上下文事件账本收集“待抽取原文”；抽取/巩固由 MemoryScheduler 后台执行。
// pending 是唯一事实源，job 只存引用。
import { compactionRuntimeFor } from "../context/compact/session_runtime";
import type { ConversationEvent } from "../context/events";
import { type ReadCursor, readRaw } from "../context/recall";
import { getHost } from "../core/host";
import { MemoryManager } from "../memory/manager";
import type { Session } from "../session/session";
import { MEMORY_WATERMARK_TOKENS } from "../utils/context_limits";
import { CONTEXT_BRIDGE_ROLE_LABEL } from "../utils/protocol";
import { truncateToTokenBudget } from "../utils/token_budget";
import { estimateTextTokens } from "../utils/token_estimate";

interface BridgeState {
    epochStart: number;
    consumed: number;
    readSeq: number;
    offset: number;
    pending: string;
}

const states = new WeakMap<object, BridgeState>();
//
// 范围口径（方案 §11.2 B3）：记忆桥（pending 积压 / 单次抽取块）统一按 **token 预算**，
// 不再按字符；条数（maxItems）只作安全上限，不是范围。
/** pending 原文 token 安全上限（≈ 旧 120000 字符口径）；满了由 peek/commit 分块推进 */
const MAX_PENDING_TOKENS = 40_000;
/** 单次抽取块 token 上限（≈ 旧 12000 字符口径） */
const MAX_CHUNK_TOKENS = 4_000;
/**
 * `context/recall.readRaw` 仍是字符分页 API（不属于「消息范围」口径，本次不改它）：
 * token 预算 → 字符读取上限时取 4 字符/token（估算口径里 1 token 最多约 4 字符，英文为主），
 * 保证一次读到的原文**不少于** token 预算；真正的 token 预算在追加 pending 时精确裁剪。
 */
const CHARS_PER_TOKEN_FOR_RAW_READ = 4;
const SOURCE_KINDS = new Set<ConversationEvent['kind']>(['user', 'assistant', 'tool_result']);

/**
 * 后台滚动摘要（自动路径）：只在「编译发现未摘要原文被预算裁掉」且本会话额度未用时调用。
 * 不在空闲会话上设置定时器；runtime 由 `context/compact/session_runtime` 按会话共享（与手动 archive 同一单飞）。
 */
export async function compactContextV2(session: Session, targetTokens: number): Promise<{ advanced: boolean; reason?: string; batches?: number } | null> {
    const runtime = compactionRuntimeFor(session);
    if (!runtime) return null;
    const result = await runtime.maybeRun(targetTokens);
    return { advanced: result.advanced, reason: result.reason, batches: result.batches };
}

function cursorKey(sessionId: string): string {
    return `mem_cursor:${sessionId}`;
}

function effectiveWatermark(): number {
    // 上下文与记忆解耦：记忆抽取水位用内部常量（原「摘要水位」默认行为等价）
    return MEMORY_WATERMARK_TOKENS;
}

function loadState(session: Session, epochStartSeq: number): BridgeState {
    let state = states.get(session);
    if (state) return state;
    state = { epochStart: epochStartSeq, consumed: Math.max(0, epochStartSeq - 1), readSeq: 0, offset: 0, pending: '' };
    if (session.sessionId) {
        try {
            const raw = getHost().storage.get(cursorKey(session.sessionId));
            if (raw) {
                const parsed = JSON.parse(raw) as Partial<BridgeState>;
                if (Number.isFinite(parsed.consumed) && Number.isFinite(parsed.readSeq)) {
                    state = {
                        epochStart: Number(parsed.epochStart ?? epochStartSeq),
                        consumed: Math.max(0, Math.floor(parsed.consumed!)),
                        readSeq: Math.max(0, Math.floor(parsed.readSeq!)),
                        offset: Math.max(0, Math.floor(parsed.offset ?? 0)),
                        pending: typeof parsed.pending === 'string' ? parsed.pending : '',
                    };
                }
            }
        } catch { /* ignore */ }
    }
    if (state.epochStart !== epochStartSeq || state.consumed < epochStartSeq - 1) {
        state = { epochStart: epochStartSeq, consumed: epochStartSeq - 1, readSeq: epochStartSeq - 1, offset: 0, pending: '' };
    }
    states.set(session, state);
    return state;
}

function saveState(session: Session, state: BridgeState): void {
    if (!session.sessionId) return;
    try {
        getHost().storage.set(cursorKey(session.sessionId), JSON.stringify(state));
    } catch { /* ignore */ }
}

/** 只读事件账本→pending；0 LLM。AI 路径调用。 */
export function collectContextBacklog(session: Session): { pendingTokens: number; pendingChars: number } {
    const service = session.contextV2;
    if (!service) return { pendingTokens: 0, pendingChars: 0 };
    const watermark = effectiveWatermark();
    if (watermark <= 0) return { pendingTokens: 0, pendingChars: 0 };
    const head = service.head();
    const toSeq = head.nextSeq - 1;
    const state = loadState(session, head.epochStartSeq);
    if (state.epochStart !== head.epochStartSeq) {
        state.epochStart = head.epochStartSeq;
        state.consumed = head.epochStartSeq - 1;
        state.readSeq = head.epochStartSeq - 1;
        state.offset = 0;
        state.pending = '';
    }
    if (toSeq < state.consumed) return { pendingTokens: estimateTextTokens(state.pending), pendingChars: state.pending.length };
    const fromSeq = state.offset > 0 && state.readSeq > 0 ? state.readSeq : state.readSeq + 1;
    const rangeFrom = Math.max(fromSeq, state.consumed + 1);
    // pending / 单次抽取块都按 token 控量：readRaw 仍按字符多读一点（4 字符/token 上界），
    // 追加 pending 时再按 token 精确裁剪；裁剪点写回游标，下一轮从同一事件的事件内偏移续读。
    const pendingTokens = estimateTextTokens(state.pending);
    if (rangeFrom <= toSeq && pendingTokens < MAX_PENDING_TOKENS) {
        const cursor: ReadCursor | null = state.offset > 0 && state.readSeq > 0 ? { seq: state.readSeq, offset: state.offset } : null;
        const result = readRaw(service.getStore(), service.snapshot(), `e:${rangeFrom}-${toSeq}`, {
            maxItems: 200,
            maxChars: MAX_CHUNK_TOKENS * CHARS_PER_TOKEN_FOR_RAW_READ,
            cursor,
        });
        let lastSeq = 0;
        let pendingUsed = pendingTokens;
        let chunkUsed = 0;
        let partialCursor: ReadCursor | null = null;
        for (const item of result.items) {
            if (item.type !== 'event') continue;
            lastSeq = Math.max(lastSeq, item.seq);
            if (!SOURCE_KINDS.has(item.kind)) continue;
            const label = CONTEXT_BRIDGE_ROLE_LABEL[item.kind] ?? '';
            const eventOffset = item.offset ?? 0;
            // 本次 collect 的块预算与 pending 余量取更紧者；1 = 换行符 token 余量
            const room = Math.min(MAX_CHUNK_TOKENS - chunkUsed, MAX_PENDING_TOKENS - pendingUsed);
            const textBudget = room - estimateTextTokens(label) - 1;
            if (textBudget <= 0) {
                partialCursor = { seq: item.seq, offset: eventOffset };
                break;
            }
            const kept = truncateToTokenBudget(item.text, textBudget, estimateTextTokens);
            if (kept.text.length > 0) {
                const line = `${label}${kept.text}\n`;
                const lineTokens = estimateTextTokens(line);
                state.pending += line;
                pendingUsed += lineTokens;
                chunkUsed += lineTokens;
            }
            if (kept.truncated) {
                // 该事件只追加了 token 预算内的前缀：游标指到事件内字符偏移，下一轮续读
                partialCursor = { seq: item.seq, offset: eventOffset + kept.text.length };
                break;
            }
        }
        if (partialCursor) {
            state.readSeq = partialCursor.seq;
            state.offset = partialCursor.offset;
        } else if (result.cursor) {
            state.readSeq = result.cursor.seq;
            state.offset = result.cursor.offset;
        } else {
            state.readSeq = result.exhausted ? toSeq : (lastSeq || state.readSeq);
            state.offset = 0;
        }
        saveState(session, state);
    }
    return { pendingTokens: estimateTextTokens(state.pending), pendingChars: state.pending.length };
}

export interface ExtractionChunk {
    text: string;
    throughSeq: number;
    textLength: number;
}

/**
 * 取一段可抽取原文（按 **token 预算**取 pending 前缀；不足水位且非 force 返回 null）。
 *
 * 0 语义：
 * - `maxTokens <= 0` → 返回 null（0 = 不取块，不是「不限」）；
 * - `force=false` 时 pending 估算 token 低于 `MEMORY_WATERMARK_TOKENS` → 返回 null。
 *
 * `textLength` 仍是**字符**数：commitExtraction 按字符前缀消费 pending（内部游标单位）。
 */
export function peekExtractionChunk(session: Session, force = false, maxTokens: number = MAX_CHUNK_TOKENS): ExtractionChunk | null {
    const state = states.get(session);
    if (!state?.pending) return null;
    if (!force) {
        const watermark = effectiveWatermark();
        if (estimateTextTokens(state.pending) < watermark) return null;
    }
    const budget = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 0;
    if (budget <= 0) return null;
    const slice = truncateToTokenBudget(state.pending, budget, estimateTextTokens);
    const text = slice.text;
    if (!text.trim()) return null;
    return {
        text,
        throughSeq: state.offset > 0 ? Math.max(state.consumed, state.readSeq - 1) : Math.max(state.consumed, state.readSeq),
        textLength: text.length,
    };
}

/** 抽取成功后提交：清除已处理前缀并推进 consumed；失败不调用。 */
export function commitExtraction(session: Session, throughSeq: number, textLength: number): void {
    const state = states.get(session);
    if (!state) return;
    state.pending = state.pending.slice(Math.max(0, textLength));
    state.consumed = Math.max(state.consumed, throughSeq);
    saveState(session, state);
}

/** 兼容旧调用：collect + 旧同步 summarize（仅测试/legacy；运行路径不再使用）。 */
export async function consumeContextV2(session: Session): Promise<number> {
    collectContextBacklog(session);
    const chunk = peekExtractionChunk(session);
    if (!chunk) return 0;
    const ok = await MemoryManager.summarizeChunkWithRetry(session, [{ role: 'user', contentItems: [{ text: chunk.text }] }]);
    if (!ok) return 0;
    commitExtraction(session, chunk.throughSeq, chunk.textLength);
    return 1;
}

export function consumedThrough(session: Session): number {
    return states.get(session)?.consumed ?? 0;
}

export function pendingThrough(session: Session): { consumed: number; readSeq: number; pendingChars: number; epochStart: number } {
    const s = states.get(session);
    return s ? { consumed: s.consumed, readSeq: s.readSeq, pendingChars: s.pending.length, epochStart: s.epochStart } : { consumed: 0, readSeq: 0, pendingChars: 0, epochStart: 0 };
}

export function resetContextBridgeCursor(session: Session): void {
    states.delete(session);
    if (session.sessionId) {
        try { getHost().storage.set(cursorKey(session.sessionId), ''); } catch { /* ignore */ }
    }
}

export function resetContextRuntime(session: Session): void {
    states.delete(session);
}

// 旧导出兼容：compactContextV2 在 agent/context_bridge 原实现中；这里不重复实现。
// 字符常量已改 token 口径（方案 §11.2 B3）：MAX_CHUNK_CHARS → MAX_CHUNK_TOKENS，
// 另导出 MAX_PENDING_TOKENS 供测试/诊断使用。
export { MEMORY_WATERMARK_TOKENS, MAX_CHUNK_TOKENS, MAX_PENDING_TOKENS };
