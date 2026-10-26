// 记忆桥：只从上下文事件账本收集“待抽取原文”；抽取/巩固由 MemoryScheduler 后台执行。
// pending 是唯一事实源，job 只存引用。
import Config from "../config/config";
import { CompactionRuntime } from "../context/compact/runtime";
import type { ConversationEvent } from "../context/events";
import { type ReadCursor, readRaw } from "../context/recall";
import { getHost } from "../core/host";
import { getAuxLlm } from "../core/ports/aux_llm";
import { MemoryManager } from "../memory/manager";
import type { Session } from "../session/session";

interface BridgeState {
    epochStart: number;
    consumed: number;
    readSeq: number;
    offset: number;
    pending: string;
}

const states = new WeakMap<object, BridgeState>();
const compactions = new WeakMap<object, CompactionRuntime>();
const MEMORY_WATERMARK_TOKENS = 6000;
const MAX_PENDING_CHARS = 120_000;
const MAX_CHUNK_CHARS = 12_000;
const SOURCE_KINDS = new Set<ConversationEvent['kind']>(['user', 'assistant', 'tool_result']);
const ROLE_LABEL: Record<string, string> = { user: '[用户] ', assistant: '[AI] ', tool_result: '[工具] ' };

function estimateEventTokens(event: ConversationEvent): number {
    const parts = (event as { parts?: Array<{ type: string; text?: string }> }).parts ?? [];
    let chars = 0;
    for (const part of parts) if (part.type === 'text') chars += String(part.text ?? '').length;
    if (event.kind === 'tool_call') chars += String(event.args ?? '').length;
    return Math.max(1, Math.ceil(chars / 3)) + 4;
}

function compactionRuntimeFor(session: Session): CompactionRuntime | null {
    const service = session.contextV2;
    if (!service) return null;
    let runtime = compactions.get(session);
    if (runtime) return runtime;
    runtime = new CompactionRuntime(
        {
            watermarkTokens: Config.context.SUMMARY_WATERMARK,
            batchTokens: 6000,
            summaryMaxChars: 2000,
            hourlyCap: Config.context.HOURLY_COMPACT_CAP,
        },
        {
            service,
            summarize: async (text: string) => {
                try {
                    const out = await getAuxLlm().chat('summarize_agent', text);
                    return typeof out === 'string' && out.trim() ? out : null;
                } catch {
                    return null;
                }
            },
            estimateEventTokens,
        },
    );
    compactions.set(session, runtime);
    return runtime;
}

/** 后台滚动摘要：run 前后调用；与记忆抽取无关。 */
export async function compactContextV2(session: Session): Promise<{ advanced: boolean; reason?: string } | null> {
    const runtime = compactionRuntimeFor(session);
    if (!runtime) return null;
    return runtime.maybeRun();
}

function cursorKey(sessionId: string): string {
    return `mem_cursor:${sessionId}`;
}

function effectiveWatermark(): number {
    const configured = Config.context.SUMMARY_WATERMARK;
    return configured > 0 ? Math.min(configured, MEMORY_WATERMARK_TOKENS) : MEMORY_WATERMARK_TOKENS;
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
    if (toSeq < state.consumed) return { pendingTokens: Math.ceil(state.pending.length / 3), pendingChars: state.pending.length };
    const fromSeq = state.offset > 0 && state.readSeq > 0 ? state.readSeq : state.readSeq + 1;
    const rangeFrom = Math.max(fromSeq, state.consumed + 1);
    if (rangeFrom <= toSeq && state.pending.length < MAX_PENDING_CHARS) {
        const cursor: ReadCursor | null = state.offset > 0 && state.readSeq > 0 ? { seq: state.readSeq, offset: state.offset } : null;
        const result = readRaw(service.getStore(), service.snapshot(), `e:${rangeFrom}-${toSeq}`, {
            maxItems: 200, maxChars: 12000, cursor,
        });
        let lastSeq = 0;
        for (const item of result.items) {
            if (item.type !== 'event') continue;
            lastSeq = Math.max(lastSeq, item.seq);
            if (SOURCE_KINDS.has(item.kind)) state.pending += `${ROLE_LABEL[item.kind] ?? ''}${item.text}\n`;
        }
        if (result.cursor) {
            state.readSeq = result.cursor.seq;
            state.offset = result.cursor.offset;
        } else {
            state.readSeq = result.exhausted ? toSeq : (lastSeq || state.readSeq);
            state.offset = 0;
        }
        saveState(session, state);
    }
    return { pendingTokens: Math.ceil(state.pending.length / 3), pendingChars: state.pending.length };
}

export interface ExtractionChunk {
    text: string;
    throughSeq: number;
    textLength: number;
}

/** 取一段可抽取原文；不足水位且非 force 返回 null。 */
export function peekExtractionChunk(session: Session, force = false, maxChars = MAX_CHUNK_CHARS): ExtractionChunk | null {
    const state = states.get(session);
    if (!state?.pending) return null;
    if (!force) {
        const watermark = effectiveWatermark();
        if (Math.ceil(state.pending.length / 3) < watermark) return null;
    }
    const text = state.pending.slice(0, maxChars);
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
export { MEMORY_WATERMARK_TOKENS, MAX_CHUNK_CHARS };
