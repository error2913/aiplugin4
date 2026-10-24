// Context v2 → 旧消费者只读投影（过渡件，不是事实源）。
//
// 用途：judge / prompt builder / pub snapshot / 子代理 fork seed / status / 旧工具 等
// 仍按 `Context.messages`（旧 MessageType[]）读取的消费者，在 P2-P3 迁移期间读这里。
// 规则：
// - 只读：返回深度冻结的数组/对象；任何 mutate 都应被视为 bug；
// - 有界：从最新单元往前按字符预算选择，最新单元必留；工具组整组保留；
// - 应用可见性/编辑（epoch/redact/supersede/edit），不注入摘要（投影是渲染窗口，不是请求体）；
// - 非文本 Part 用规范文本投影（[img:…]/[at:…]）表示，保持旧消费者可读；
// - 真实原文回查走 recall（e:<seq>），不在这里塞 rawText。
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
    /** 最多保留多少个可选单元（从新到旧）；缺省 40 */
    maxUnits?: number;
    /** 最多保留多少字符（按规范文本投影计）；缺省 20000 */
    maxChars?: number;
}

const DEFAULT_MAX_UNITS = 40;
const DEFAULT_MAX_CHARS = 20000;

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

function systemItem(event: ConversationEvent, index: ReturnType<typeof buildRecordIndex>): SystemUserMessageItem {
    const e = event as unknown as { systemName?: string; eventType?: string; raw?: unknown; at?: number };
    const item: SystemUserMessageItem = {
        text: partsText(applyEdit(event, index)),
        time: Number(e.at ?? 0),
        systemName: e.systemName || '事件',
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
                text: `（工具 ${missing.map(c => c.name || c.callId).join('、')} 调用未完成）`,
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
 * 生成有界只读投影：最新单元必留，从新到旧按 maxUnits/maxChars 选择。
 * 返回深度冻结数组；消费者只读。
 */
export function buildProjection(snapshot: ContextSnapshot, options: ProjectionOptions = {}): MessageType[] {
    const maxUnits = Math.max(1, Math.floor(options.maxUnits ?? DEFAULT_MAX_UNITS));
    const maxChars = Math.max(200, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));

    const index = buildRecordIndex(snapshot.records);
    const visible = applyVisibility(snapshot.events, index);
    const units = segmentUnits(visible);

    const selected: ConversationUnit[] = [];
    let chars = 0;
    for (let i = units.length - 1; i >= 0 && selected.length < maxUnits; i--) {
        const unit = units[i];
        const size = unitChars(unit, index);
        if (selected.length === 0) {
            selected.push(unit);
            chars += size;
            continue;
        }
        if (chars + size > maxChars) break;
        selected.push(unit);
        chars += size;
    }
    selected.reverse();

    const messages: MessageType[] = [];
    for (const unit of selected) messages.push(...unitMessages(unit, index));
    return deepFreeze(messages);
}
