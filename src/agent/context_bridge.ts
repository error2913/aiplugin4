// 记忆桥：从上下文事件账本消费原文并沉淀长期记忆（上下文不直接写记忆）。
// 消费进度持久化在 mem_cursor:<sid>，重载后不重复沉淀；失败保留待总结文本，下次重试。
import Config from "../config/config";
import { CompactionRuntime } from "../context/compact/runtime";
import type { ConversationEvent } from "../context/events";
import { type ReadCursor, readRaw } from "../context/recall";
import { getHost } from "../core/host";
import { getAuxLlm } from "../core/ports/aux_llm";
import { MemoryManager } from "../memory/manager";
import type { Session } from "../session/session";

interface BridgeState {
    /** 状态所属 epoch 起始 seq；切 epoch（purge）后进度作废 */
    epochStart: number;
    /** 已成功沉淀到的事件 seq（持久化） */
    consumed: number;
    /** 读取进度：已读到的 seq 与页内偏移（持久化，用于大事件续读） */
    readSeq: number;
    offset: number;
    /** 已读但尚未成功沉淀的原文（持久化，失败/水位不足时保留） */
    pending: string;
}

const states = new WeakMap<object, BridgeState>();
const compactions = new WeakMap<object, CompactionRuntime>();

function cursorKey(sessionId: string): string {
    return `mem_cursor:${sessionId}`;
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
        } catch {
            // 读取失败按新状态处理，宁可重复沉淀也不丢当前对话
        }
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
    } catch {
        // 进度持久化失败只影响重启后的去重，不阻塞回复
    }
}

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

/** 后台滚动摘要：run 结束后调用；水位/节流/小时上限/退避由 runtime 控制 */
export async function compactContextV2(session: Session): Promise<{ advanced: boolean; reason?: string } | null> {
    const runtime = compactionRuntimeFor(session);
    if (!runtime) return null;
    return runtime.maybeRun();
}

/** 记忆沉淀自己的水位；不复用摘要开关（摘要关闭不应让长期记忆停摆） */
const MEMORY_WATERMARK_TOKENS = 6000;

const SOURCE_KINDS = new Set<ConversationEvent['kind']>(['user', 'assistant', 'tool_result']);
const ROLE_LABEL: Record<string, string> = { user: '[用户] ', assistant: '[AI] ', tool_result: '[工具] ' };
/** 待总结缓冲上限：摘要器持续失败时避免存储无限增长（上下文原文仍完整保留） */
const MAX_PENDING_CHARS = 120_000;

/**
 * 消费事件到长期记忆：
 * - 水位 0 = 关闭；待总结文本不足水位时只推进读取进度；
 * - 成功才推进 consumed；失败保留 pending，下次重试；
 * - 读取/沉淀进度持久化，重载不会重复沉淀。
 */
export async function consumeContextV2(session: Session): Promise<number> {
    const service = session.contextV2;
    if (!service) return 0;
    const watermark = Config.context.SUMMARY_WATERMARK > 0
        ? Math.min(Config.context.SUMMARY_WATERMARK, MEMORY_WATERMARK_TOKENS)
        : MEMORY_WATERMARK_TOKENS;
    if (watermark <= 0) return 0;

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
    if (toSeq < state.consumed) return 0;

    const fromSeq = state.offset > 0 && state.readSeq > 0 ? state.readSeq : state.readSeq + 1;
    const rangeFrom = Math.max(fromSeq, state.consumed + 1);
    if (rangeFrom <= toSeq && state.pending.length < MAX_PENDING_CHARS) {
        const cursor: ReadCursor | null = state.offset > 0 && state.readSeq > 0
            ? { seq: state.readSeq, offset: state.offset }
            : null;
        const result = readRaw(service.getStore(), service.snapshot(), `e:${rangeFrom}-${toSeq}`, {
            maxItems: 200,
            maxChars: 12000,
            cursor,
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

    if (Math.ceil(state.pending.length / 3) < watermark) return 0;
    const messages = [{ role: 'user', contentItems: [{ text: state.pending }] }];
    let ok = false;
    try {
        ok = await MemoryManager.summarizeChunkWithRetry(session, messages as any);
    } catch {
        ok = false;
    }
    if (!ok) return 0;
    state.consumed = state.offset > 0 ? Math.max(state.consumed, state.readSeq - 1) : Math.max(state.consumed, state.readSeq);
    state.pending = '';
    saveState(session, state);
    return 1;
}

/** 最近一次成功沉淀到的事件 seq（测试/诊断用） */
export function consumedThrough(session: Session): number {
    return states.get(session)?.consumed ?? 0;
}

/** 清空消费进度（测试用） */
export function resetContextBridgeCursor(session: Session): void {
    states.delete(session);
    if (session.sessionId) {
        try {
            getHost().storage.set(cursorKey(session.sessionId), '');
        } catch {
            // ignore
        }
    }
}

/** 清空运行时状态（测试用） */
export function resetContextRuntime(session: Session): void {
    compactions.delete(session);
    states.delete(session);
}
