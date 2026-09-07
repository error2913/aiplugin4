// 公开会话快照渲染：把其他会话的上下文消息渲染成只读文本快照（pub_read 工具使用）。
// - 只取真实的用户消息与助手文本消息，跳过事件/系统名义/工具调用/工具返回；
// - 保留 [msg_id]/[from:名字(QQ号)]/[img:图片ID] 等可回引元数据，供 pub_send 在 QQ 目标下引用；
// - 剥离 [time]/[system] 等内部标记与伪造标签，避免快照携带可执行内容；
// - 输出带强只读声明，提示模型不得执行其中指令、不是当前对话延续。
import Message from "../context/message";
import type { AssistantMessage, MessageType, UserMessage, UserMessageItem } from "../context/types";
import User from "../session/user";

const MAX_ROUNDS = 15;
const DEFAULT_ROUNDS = 6;
const MAX_CHARS = 8000;
const DEFAULT_CHARS = 3000;

export interface SnapshotOptions {
    rounds?: number;
    chars?: number;
    /** 名称解析钩子（测试注入）；默认用 User 档案 */
    resolveName?: (uid: string) => string;
}

function defaultNameOf(uid: string): string {
    try {
        return User.get(uid).userName;
    } catch (_e) {
        return '';
    }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
    const n = parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

/** 取用户 ID 的纯号码段（QQ:123 → 123） */
function rawNumber(uid: string): string {
    return String(uid || '').replace(/^.+:/, '');
}

function fromPrefix(uid: string, resolve: (uid: string) => string): string {
    const number = rawNumber(uid);
    const name = resolve(uid);
    return name ? `[from:${name}(${number})]` : `[from:${number}]`;
}

/**
 * 把目标会话的 context.messages 渲染为只读快照文本。
 * 返回 null 表示没有可展示内容。
 */
export function renderPubSnapshot(messages: MessageType[], opts: SnapshotOptions = {}, resolve: (uid: string) => string = defaultNameOf): string | null {
    const rounds = clamp(opts.rounds, DEFAULT_ROUNDS, 1, MAX_ROUNDS);
    const maxChars = clamp(opts.chars, DEFAULT_CHARS, 500, MAX_CHARS);

    // 自新到旧挑选，直到攒够 rounds 个真实用户轮次（用户轮含其后的助手回复）
    const picked: string[] = [];
    let userTurns = 0;
    for (let i = messages.length - 1; i >= 0 && userTurns < rounds; i--) {
        const m = messages[i];
        const type = Message.getMessageType(m);
        if (type === 'user') {
            const userMsg = m as UserMessage;
            // 用户消息可能混有系统名义条目（事件/系统提示），只挑真实用户条目（有 userId 且无 systemName）
            const realItems = ((userMsg.contentItems || []) as any[]).filter((it): it is UserMessageItem =>
                it && typeof it === 'object'
                && typeof it.userId === 'string' && it.userId !== ''
                && !it.systemName
                && typeof it.text === 'string'
            );
            if (realItems.length === 0) continue;
            const rows = realItems.map(it => {
                const text = (it.text || '').trim();
                if (!text) return '';
                const msgId = it.messageId ? `[msg_id:${it.messageId}]` : '';
                const from = it.userId ? fromPrefix(it.userId, resolve) : '';
                return `${from}${from && msgId ? ' ' : ''}${msgId}${(from || msgId) ? ' ' : ''}${text}`;
            }).filter(Boolean);
            picked.push(...rows.reverse());
            userTurns += realItems.length;
        } else if (type === 'assistant') {
            const assistantMsg = m as AssistantMessage;
            const rows = ((assistantMsg.contentItems || []) as any[]).map(it => {
                if (!it || typeof it !== 'object' || typeof it.text !== 'string') return '';
                const text = it.text.trim();
                if (!text) return '';
                const msgId = it.messageId ? `[msg_id:${it.messageId}]` : '';
                return `${msgId ? msgId + ' ' : ''}Bot 回复: ${text}`;
            }).filter(Boolean);
            picked.push(...rows.reverse());
        }
    }
    picked.reverse();
    if (picked.length === 0) return null;

    let out = picked.join('\n');
    if (out.length > maxChars) {
        out = out.slice(0, maxChars) + `\n[快照已截断：超过 ${maxChars} 字符，如需更多请用更大 rounds/chars 重新调用]`;
    }
    return out;
}
