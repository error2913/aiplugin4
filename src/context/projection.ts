// Context v2 → 旧消费者只读投影（过渡件，不是事实源）。
//
// 用途：judge / prompt builder / pub snapshot / 子代理 fork seed / status / 旧工具 等
// 仍按 `Context.messages`（旧 MessageType[]）读取的消费者，在 P2-P3 迁移期间读这里。
// 规则：
// - 只读：返回深度冻结的数组/对象；任何 mutate 都应被视为 bug；
// - 有界：从最新单元往前按 **token 预算**选择，最新单元必留；工具组整组保留；
//   `maxChars` 仅为旧调用保留的兼容/安全上限（方案 §11.2 B1：字符不再是主口径）；
// - 应用可见性/编辑（epoch/redact/supersede/edit），不注入摘要（投影是渲染窗口，不是请求体）；
// - 非文本 Part 用规范文本投影（[img:…]/[at:…]）表示，保持旧消费者可读；
// - 真实原文回查走 recall（e:<seq>），不在这里塞 rawText。
import { SYSTEM_NAME } from "../utils/protocol";
import { estimateTextTokens } from "../utils/token_estimate";

import { renderText } from "./content/render";
import type { ConversationEvent, Part } from "./events";
import type { ContextSnapshot } from "./store";
import type {
    AssistantMessage,
    AssistantMessageItem,
    MessageType,
    SystemUserMessageItem,
    ToolCallbackMessage,
    ToolCallsMessage,
    UserMessage,
    UserMessageItem,
} from "./types";
import { applyEdit, applyVisibility, buildRecordIndex } from "./view/records";
import { ConversationUnit, segmentUnits } from "./view/units";

export interface ProjectionOptions {
    /**
     * 主口径：token 预算（从最新单元往前累加，装不下就停）。
     * 缺省 6000；<=0 = 只保留最新单元（不是「无限」）。
     */
    maxTokens?: number;
    /**
     * 单元数安全上限（从新到旧）；缺省 200。
     * 注意：这是「安全上限」不是范围口径，范围由 maxTokens 决定。
     */
    maxUnits?: number;
    /**
     * @deprecated 字符上限（按规范文本投影计），仅为旧调用兼容保留：
     * 传入时与 maxTokens 同时生效（先到先停）；不传 = 不设字符上限。
     */
    maxChars?: number;
    /** 是否深度冻结（默认 true；旧消费者过渡期可传 false 保持可变） */
    freeze?: boolean;
}

/** 投影 token 主口径默认值（方案 §11.2 B1） */
export const DEFAULT_PROJECTION_MAX_TOKENS = 6000;
/** 单元数安全上限默认值（不是范围口径，只防碎片/空单元无界增长） */
export const DEFAULT_PROJECTION_MAX_UNITS = 200;

function partsText(parts: readonly Part[]): string {
    return renderText(parts as Part[]);
}

function unitChars(unit: ConversationUnit, index: ReturnType<typeof buildRecordIndex>): number {
    let total = 0;
    for (const event of unit.events) {
        total += partsText(applyEdit(event, index)).length;
        if (event.kind === 'tool_call') total += String((event as { args?: string }).args ?? '').length;
    }
    return total;
}

/** 单元 token 估算（与 unitChars 同口径，按 estimateTextTokens 计） */
function unitTokens(unit: ConversationUnit, index: ReturnType<typeof buildRecordIndex>): number {
    let total = 0;
    for (const event of unit.events) {
        total += estimateTextTokens(partsText(applyEdit(event, index)));
        if (event.kind === 'tool_call') total += estimateTextTokens(String((event as { args?: string }).args ?? ''));
    }
    return total;
}

function systemItem(event: ConversationEvent, index: ReturnType<typeof buildRecordIndex>): SystemUserMessageItem {
    const e = event as unknown as { systemName?: string; eventType?: string; raw?: unknown; at?: number };
    const item: SystemUserMessageItem = {
        text: partsText(applyEdit(event, index)),
        time: Number(e.at ?? 0),
        systemName: e.systemName || SYSTEM_NAME.event,
    };
    if (e.eventType !== undefined) item.eventType = e.eventType;
    if (e.raw !== undefined) item.raw = e.raw;
    return item;
}

function userMessageFromUnit(unit: ConversationUnit, index: ReturnType<typeof buildRecordIndex>): MessageType | null {
    const items: Array<UserMessageItem | SystemUserMessageItem> = [];
    for (const event of unit.events) {
        if (event.kind === 'event') {
            items.push(systemItem(event, index));
            continue;
        }
        if (event.kind !== 'user') continue;
        const u = event as unknown as { uid?: string; msgId?: string; at?: number };
        items.push({
            text: partsText(applyEdit(event, index)),
            time: Number(u.at ?? 0),
            userId: String(u.uid ?? ''),
            messageId: String(u.msgId ?? ''),
        });
    }
    if (items.length === 0) return null;
    return { role: 'user', contentItems: items } as UserMessage;
}

function assistantMessagesFromEvent(event: ConversationEvent, index: ReturnType<typeof buildRecordIndex>): MessageType[] {
    const text = partsText(applyEdit(event, index));
    if (!text) return [];
    const item: AssistantMessageItem = {
        text,
        time: Number((event as { at?: number }).at ?? 0),
        messageId: String((event as { msgId?: string }).msgId ?? ''),
    };
    const message: AssistantMessage = { role: 'assistant', contentItems: [item] };
    const reasoning = (event as { reasoning?: string }).reasoning;
    if (reasoning !== undefined) item.reasoningContent = reasoning;
    return [message];
}

function toolGroupMessages(unit: ConversationUnit, index: ReturnType<typeof buildRecordIndex>): MessageType[] {
    const calls = unit.events.filter(e => e.kind === 'tool_call') as Array<Extract<ConversationEvent, { kind: 'tool_call' }>>;
    const results = unit.events.filter(e => e.kind === 'tool_result') as Array<Extract<ConversationEvent, { kind: 'tool_result' }>>;
    const resultByCall = new Map<string, typeof results>();
    for (const result of results) {
        const key = String(result.callId || '');
        const list = resultByCall.get(key);
        if (list) list.push(result);
        else resultByCall.set(key, [result]);
    }

    const out: MessageType[] = [];
    const completeCalls = calls.filter(call => resultByCall.has(String(call.callId || '')));
    const missing = calls.filter(call => !resultByCall.has(String(call.callId || '')));

    if (missing.length > 0) {
        out.push({
            role: 'assistant',
            contentItems: [{
                text: `Tool calls unfinished: ${missing.map(c => c.name || c.callId).join(', ')}`,
                time: Number(missing[0].at ?? 0),
                messageId: '',
            }],
        });
    }
    if (completeCalls.length > 0) {
        const toolCalls = completeCalls.map((call, i) => ({
            index: i,
            id: String(call.callId || ''),
            type: 'function' as const,
            function: { name: String(call.name || ''), arguments: String(call.args || '{}') },
        }));
        const message: ToolCallsMessage = { role: 'assistant', toolCalls };
        const reasoning = completeCalls.find(c => c.reasoning !== undefined)?.reasoning;
        if (reasoning !== undefined) message.reasoningContent = reasoning;
        out.push(message);
        for (const call of completeCalls) {
            for (const result of resultByCall.get(String(call.callId || '')) || []) {
                out.push({
                    role: 'tool',
                    text: partsText(applyEdit(result, index)),
                    toolCallId: String(result.callId || ''),
                    ...(result.name ? { toolName: result.name } : {}),
                } as ToolCallbackMessage);
            }
        }
    }
    return out;
}

function orphanResultMessages(unit: ConversationUnit, index: ReturnType<typeof buildRecordIndex>): MessageType[] {
    return unit.events.map(event => ({
        role: 'tool',
        text: partsText(applyEdit(event, index)),
        toolCallId: String((event as { callId?: string }).callId ?? ''),
        ...((event as { name?: string }).name ? { toolName: (event as { name?: string }).name } : {}),
    } as ToolCallbackMessage));
}

function unitMessages(unit: ConversationUnit, index: ReturnType<typeof buildRecordIndex>): MessageType[] {
    if (unit.kind === 'tool_group') return toolGroupMessages(unit, index);
    if (unit.kind === 'orphan_result') return orphanResultMessages(unit, index);
    if (unit.kind === 'user' || unit.kind === 'event') {
        const message = userMessageFromUnit(unit, index);
        return message ? [message] : [];
    }
    const out: MessageType[] = [];
    for (const event of unit.events) {
        if (event.kind === 'assistant') out.push(...assistantMessagesFromEvent(event, index));
    }
    return out;
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value as object)) {
            deepFreeze((value as Record<string, unknown>)[key]);
        }
    }
    return value;
}

/**
 * 生成有界只读投影：最新单元必留，从新到旧按 maxTokens 选择（maxUnits 为安全上限，
 * maxChars 为旧调用兼容上限，同时生效）。
 * 0 语义：maxTokens <= 0 = 只保留最新单元（不是「无限」）；maxChars <= 0 同理。
 * 返回深度冻结数组；消费者只读。
 */
export function buildProjection(snapshot: ContextSnapshot, options: ProjectionOptions = {}): MessageType[] {
    const rawTokens = options.maxTokens === undefined ? DEFAULT_PROJECTION_MAX_TOKENS : Number(options.maxTokens);
    const maxTokens = Number.isFinite(rawTokens) ? Math.max(0, Math.floor(rawTokens)) : DEFAULT_PROJECTION_MAX_TOKENS;
    const maxUnits = Math.max(1, Math.floor(options.maxUnits ?? DEFAULT_PROJECTION_MAX_UNITS));
    const rawChars = options.maxChars === undefined ? Number.POSITIVE_INFINITY : Number(options.maxChars);
    const maxChars = Number.isFinite(rawChars) ? Math.max(0, Math.floor(rawChars)) : Number.POSITIVE_INFINITY;

    const index = buildRecordIndex(snapshot.records);
    const visible = applyVisibility(snapshot.events, index);
    const units = segmentUnits(visible);

    const selected: ConversationUnit[] = [];
    let tokens = 0;
    let chars = 0;
    for (let i = units.length - 1; i >= 0 && selected.length < maxUnits; i--) {
        const unit = units[i];
        const sizeTokens = unitTokens(unit, index);
        const sizeChars = unitChars(unit, index);
        if (selected.length === 0) {
            // 最新单元必留（即使自身超预算，也至少让消费者看到最新内容）
            selected.push(unit);
            tokens += sizeTokens;
            chars += sizeChars;
            continue;
        }
        if (tokens + sizeTokens > maxTokens) break;
        if (chars + sizeChars > maxChars) break;
        selected.push(unit);
        tokens += sizeTokens;
        chars += sizeChars;
    }
    selected.reverse();

    const messages: MessageType[] = [];
    for (const unit of selected) messages.push(...unitMessages(unit, index));
    return options.freeze === false ? messages : deepFreeze(messages);
}
