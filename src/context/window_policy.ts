// 上下文窗口策略（纯函数）：轮次切分、保留边界、token 估算分块、中段截断。
// 从 context.ts 拆出——这些是「窗口怎么裁」的纯逻辑，不碰 Context 实例状态，便于单测复用。
// context.ts 保留同名 re-export（既有 import 零改动）。
import { estimateMessageTokens } from "../utils/message";

import { MessageType, UserMessage, UserMessageItem } from "./types";

/**
 * 中段截断：保留头 2/3 + 尾 1/3（保留尾部是为了不切断 [img:…] / [record:…] 这类结尾标签）。
 * max ≤ 0 或未超长时原样返回。冷态入库用它做零 LLM 的纯代码截断。
 */
export function truncateMiddle(text: string, max: number): string {
    if (max <= 0 || text.length <= max) return text;
    const head = Math.floor(max * 2 / 3);
    const tail = max - head;
    return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`;
}

/** 真实用户轮：role=user 且包含真实用户消息项；system-only user 不算轮 */
export function isRealUserMessage(m: MessageType): boolean {
    if (m.role !== 'user') return false;
    if (!Array.isArray((m as UserMessage).contentItems)) return false;
    return (m as UserMessage).contentItems.some(
        item => typeof (item as UserMessageItem).userId === 'string'
    );
}

/** 将消息列表切成“真实 user 轮”段；assistant/tool 不新开轮，system-only 不新开轮 */
export function buildRoundSegments(messages: MessageType[]): Array<{ start: number; end: number }> {
    const segments: Array<{ start: number; end: number }> = [];
    let currentStart: number | null = null;
    let inUserTurn = false;

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.role === 'assistant' || m.role === 'tool') {
            inUserTurn = false;
            continue;
        }

        const realUser = isRealUserMessage(m);

        if (realUser && !inUserTurn) {
            if (currentStart !== null) segments.push({ start: currentStart, end: i });
            currentStart = i;
            inUserTurn = true;
        }
    }

    if (currentStart !== null) segments.push({ start: currentStart, end: messages.length });
    return segments;
}

/** 返回“保留最近 keepRounds 个真实 user 轮”的起始消息下标；不足时返回 0 */
export function getKeepStart(messages: MessageType[], keepRounds: number): number {
    if (keepRounds <= 0) return messages.length;
    const segments = buildRoundSegments(messages);
    if (segments.length <= keepRounds) return 0;
    return segments[segments.length - keepRounds].start;
}

/** 估算 Context 内持久化消息 token 数 */
export function estimateContextMessagesTokens(messages: MessageType[]): number {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m as any), 0);
}

/** 将待归档消息按 token 预算切成连续块，保证每条消息都进入且只进入一个块 */
export function splitMessagesByToken(messages: MessageType[], maxTokens: number): MessageType[][] {
    const chunks: MessageType[][] = [];
    let current: MessageType[] = [];
    let currentTokens = 0;

    for (const m of messages) {
        const t = estimateMessageTokens(m as any);
        if (current.length > 0 && currentTokens + t > maxTokens) {
            chunks.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(m);
        currentTokens += t;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** 丢弃最早的一个真实 user 轮（含其 assistant/tool 消息）；无轮时丢弃最早一条消息 */
export function dropOldestRound(messages: MessageType[]): boolean {
    const segments = buildRoundSegments(messages);
    if (segments.length === 0) {
        if (messages.length === 0) return false;
        messages.splice(0, 1);
        return true;
    }
    const oldest = segments[0];
    messages.splice(oldest.start, oldest.end - oldest.start);
    return true;
}
