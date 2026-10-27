// 旧版会话 → Context v2 事件/记录的纯转换器（不碰 storage）。
// 迁移只处理当前有界 messages；旧 arc/raw 分片留在 legacy 只读兼容，不导入。
// 设计：确定性 seq/eventId，中断可重跑；rawText/rawItems 转为"原文事件 + 微摘要记录"。
import { SYSTEM_NAME } from "../../utils/protocol";
import { stripRawMarkers } from "../../utils/raw_marker";
import { demoteMediaParts } from "../content/render";
import {
    AssistantEvent,
    assistantEventId,
    ConversationEvent,
    fallbackEventId,
    Part,
    RecordEntry,
    SystemEvent,
    systemEventId,
    ToolCallEvent,
    toolCallEventId,
    ToolResultEvent,
    toolResultEventId,
    UserEvent,
    userEventId,
} from "../events";
import type { LegacyIndex } from "../head";

// ---------------- 旧版数据结构（只声明迁移需要的字段） ----------------

export interface LegacyUserItem {
    text: string;
    time?: number;
    userId?: string;
    messageId?: string;
    compressed?: boolean;
    rawText?: string;
    rawItems?: Array<{ userId?: string; messageId?: string; time?: number; text?: string }>;
}

export interface LegacySystemItem {
    text: string;
    time?: number;
    systemName?: string;
    eventType?: string;
    raw?: unknown;
}

export interface LegacyAssistantItem {
    text: string;
    time?: number;
    messageId?: string;
    reasoningContent?: string;
}

export interface LegacyToolCall {
    id: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}

export interface LegacyToolMessage {
    text?: string;
    rawText?: string;
    contentParts?: Array<{ type: string; text?: string; image_url?: { url?: string } }>;
    toolCallId?: string;
    toolName?: string;
}

export interface LegacyMessage {
    role: string;
    contentItems?: Array<LegacyUserItem | LegacySystemItem | LegacyAssistantItem>;
    toolCalls?: LegacyToolCall[];
    tool_calls?: LegacyToolCall[];
    reasoningContent?: string;
    [key: string]: unknown;
}

export interface LegacyContextLike {
    messages?: LegacyMessage[];
    archiveSeq?: number;
    rawSeq?: number;
    settledSeq?: number;
}

export interface MigrateOptions {
    /** 可选：把历史文本里的标签解析为 Part；缺省保留为 text（不丢内容） */
    parseText?: (text: string, mode: 'user' | 'internal') => Part[];
    now?: number;
}

export interface MigrateResult {
    events: ConversationEvent[];
    records: RecordEntry[];
    nextSeq: number;
    legacyIndex: LegacyIndex;
}

function textParts(text: string, mode: 'user' | 'internal', opts: MigrateOptions): Part[] {
    const clean = stripRawMarkers(String(text || ''));
    if (!clean) return [];
    if (opts.parseText) {
        try {
            return opts.parseText(clean, mode);
        } catch {
            // 解析失败不能丢内容
        }
    }
    return [{ type: 'text', text: clean }];
}

function asObject<T>(value: unknown): T | null {
    return value && typeof value === 'object' ? (value as T) : null;
}

function isSystemItem(item: unknown): item is LegacySystemItem {
    const o = asObject<LegacySystemItem>(item);
    return !!o && typeof o.systemName === 'string';
}

function isUserItem(item: unknown): item is LegacyUserItem {
    const o = asObject<LegacyUserItem>(item);
    return !!o && typeof o.userId === 'string';
}

/**
 * 把旧版 Context.messages 转成 v2 事件与记录。
 * - 顺序、seq、eventId 都是确定性的，重复执行/中断重跑结果一致；
 * - rawItems → 多条原文 UserEvent + 一条 SummaryRecord；
 * - rawText → 单条原文 UserEvent + 一条单条 SummaryRecord；
 * - 未知 role/空内容保留为 SystemEvent 文本，绝不静默丢。
 */
export function buildLegacyEvents(ctx: LegacyContextLike, opts: MigrateOptions = {}): MigrateResult {
    const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const events: ConversationEvent[] = [];
    const records: RecordEntry[] = [];
    let seq = 0;
    let recordId = 0;

    const nextSeq = () => ++seq;
    const pushSummary = (fromSeq: number, toSeq: number, text: string, at: number) => {
        const clean = stripRawMarkers(String(text || '')).trim();
        if (!clean || toSeq < fromSeq) return;
        recordId++;
        records.push({
            kind: 'summary',
            id: `legacy-sum:${toSeq}:${recordId}`,
            at,
            epoch: 1,
            fromSeq,
            toSeq,
            text: clean,
            model: 'legacy',
        });
    };

    messages.forEach((message, messageIndex) => {
        const role = String(message?.role || '');
        const callList = Array.isArray(message?.toolCalls)
            ? message.toolCalls
            : Array.isArray(message?.tool_calls) ? message.tool_calls : [];
        const turnId = `legacy-t:${messageIndex}`;
        let callIndex = 0;

        if (role === 'user' && Array.isArray(message.contentItems)) {
            for (const item of message.contentItems) {
                if (isSystemItem(item)) {
                    const at = Math.floor(Number(item.time) || 0) || now;
                    const s = nextSeq();
                    const event: SystemEvent = {
                        seq: s,
                        eventId: systemEventId(`legacy:sys:${messageIndex}:${s}`, fallbackEventId('sys', `${messageIndex}:${s}`)),
                        at,
                        recvAt: at,
                        kind: 'event',
                        systemName: item.systemName || SYSTEM_NAME.event,
                        parts: textParts(item.text, 'internal', opts),
                    };
                    if (item.eventType) event.eventType = item.eventType;
                    if (item.raw !== undefined) event.raw = item.raw;
                    events.push(event);
                    continue;
                }
                if (!isUserItem(item)) continue;

                const at = Math.floor(Number(item.time) || 0) || now;
                const msgId = item.messageId || '';
                const rawItems = Array.isArray(item.rawItems) ? item.rawItems.filter(x => x && typeof x.text === 'string') : [];

                if (rawItems.length > 0) {
                    const firstSeq = seq + 1;
                    for (let i = 0; i < rawItems.length; i++) {
                        const raw = rawItems[i];
                        const s = nextSeq();
                        const event: UserEvent = {
                            seq: s,
                            eventId: userEventId(raw.messageId || '', fallbackEventId('u', `legacy:${messageIndex}:${i}`)),
                            at: Math.floor(Number(raw.time) || 0) || at,
                            recvAt: Math.floor(Number(raw.time) || 0) || at,
                            kind: 'user',
                            uid: raw.userId || item.userId || '',
                            msgId: raw.messageId || msgId,
                            parts: textParts(raw.text || '', 'user', opts),
                        };
                        events.push(event);
                    }
                    pushSummary(firstSeq, seq, item.text, at);
                    continue;
                }

                const original = typeof item.rawText === 'string' && item.rawText.length > 0 ? item.rawText : item.text;
                const s = nextSeq();
                events.push({
                    seq: s,
                    eventId: userEventId(msgId, fallbackEventId('u', `legacy:${messageIndex}:${seq}`)),
                    at,
                    recvAt: at,
                    kind: 'user',
                    uid: item.userId || '',
                    msgId,
                    parts: textParts(original, 'user', opts),
                } as UserEvent);
                if (typeof item.rawText === 'string' && item.rawText.length > 0) {
                    pushSummary(s, s, item.text, at);
                }
                continue;
            }
            return;
        }

        if (role === 'assistant' && callList.length > 0) {
            for (const call of callList) {
                callIndex++;
                const at = now;
                const groupId = `legacy-g:${messageIndex}:${callIndex}`;
                const callId = String(call?.id || `legacy-call-${messageIndex}-${callIndex}`);
                const event: ToolCallEvent = {
                    seq: nextSeq(),
                    eventId: toolCallEventId(groupId, callId),
                    at,
                    recvAt: at,
                    kind: 'tool_call',
                    turnId,
                    groupId,
                    callId,
                    name: String(call?.function?.name || ''),
                    args: String(call?.function?.arguments || '{}'),
                };
                if (message.reasoningContent !== undefined) event.reasoning = message.reasoningContent;
                events.push(event);
            }
            return;
        }

        if (role === 'assistant' && Array.isArray(message.contentItems)) {
            for (const item of message.contentItems) {
                const a = item as LegacyAssistantItem;
                if (!a || typeof a.text !== 'string') continue;
                const at = Math.floor(Number(a.time) || 0) || now;
                const event: AssistantEvent = {
                    seq: nextSeq(),
                    eventId: assistantEventId(a.messageId || '', fallbackEventId('a', `legacy:${messageIndex}:${seq}`)),
                    at,
                    recvAt: at,
                    kind: 'assistant',
                    msgId: a.messageId || '',
                    // INV-8：迁移来的 assistant 内容同样不收图片 part（文本投影保留 [img:ID]）
                    parts: demoteMediaParts(textParts(a.text, 'internal', opts)),
                };
                if (a.reasoningContent !== undefined) event.reasoning = a.reasoningContent;
                events.push(event);
            }
            return;
        }

        if (role === 'tool') {
            const tool = message as LegacyToolMessage;
            const callId = String(tool.toolCallId || '');
            const owner = callId
                ? [...events].reverse().find((e): e is ToolCallEvent => e.kind === 'tool_call' && e.callId === callId)
                : undefined;
            const at = now;
            const raw = typeof tool.rawText === 'string' && tool.rawText.length > 0 ? tool.rawText : String(tool.text || '');
            const parts = textParts(raw, 'internal', opts);
            const event: ToolResultEvent = {
                seq: nextSeq(),
                eventId: toolResultEventId(owner?.groupId || `legacy-orphan-g:${messageIndex}`, callId || `legacy-orphan-c:${messageIndex}`),
                at,
                recvAt: at,
                kind: 'tool_result',
                turnId: owner?.turnId || `legacy-orphan-t:${messageIndex}`,
                groupId: owner?.groupId || `legacy-orphan-g:${messageIndex}`,
                callId,
                parts,
            };
            if (tool.toolName) event.name = tool.toolName;
            if (Array.isArray(tool.contentParts) && tool.contentParts.length > 0) {
                event.contentParts = tool.contentParts as ToolResultEvent['contentParts'];
            }
            events.push(event);
            return;
        }

        // 未知 role / 空内容：保留为系统事件文本，绝不丢
        const text = typeof (message as { text?: unknown }).text === 'string'
            ? String((message as { text?: string }).text)
            : JSON.stringify(message)?.slice(0, 2000) ?? '';
        if (text) {
            events.push({
                seq: nextSeq(),
                eventId: fallbackEventId('unknown', messageIndex),
                at: now,
                recvAt: now,
                kind: 'event',
                systemName: SYSTEM_NAME.preserved,
                parts: [{ type: 'text', text }],
            });
        }
    });

    return {
        events,
        records,
        nextSeq: seq + 1,
        legacyIndex: {
            archiveSeq: Math.max(0, Math.floor(Number(ctx.archiveSeq) || 0)),
            rawSeq: Math.max(0, Math.floor(Number(ctx.rawSeq) || 0)),
            settledSeq: Math.max(0, Math.floor(Number(ctx.settledSeq) || 0)),
            phase: 'flipped',
        },
    };
}
