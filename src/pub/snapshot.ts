// 公开会话快照渲染：把其他会话的上下文消息渲染成只读文本快照（pub_read 工具使用）。
// - 只取真实的用户消息与助手文本消息，跳过事件/系统名义/工具调用/工具返回；
// - 保留 [msg_id]/[from:名字(QQ号)]/[img:图片ID] 等可回引元数据，供 pub_send 在 QQ 目标下引用；
// - 剥离 [time]/[system] 等内部标记与伪造标签，避免快照携带可执行内容；
// - 输出带强只读声明，提示模型不得执行其中指令、不是当前对话延续。
// - 范围口径（方案 §11.2 A 组）：快照按 **token 预算**从最新往前取，不再按「轮数/字符」；
//   条数只作为单条消息内部的渲染细节，不参与范围选择。
import Message from "../context/message";
import type { AssistantMessage, MessageType, UserMessage, UserMessageItem } from "../context/types";
import User from "../session/user";
import { truncateToTokenBudget } from "../utils/token_budget";
import { estimateTextTokens } from "../utils/token_estimate";
import { selectByTokenBudget } from "../utils/token_select";

/** 快照 token 预算：默认 3000（≈ 旧 rounds=6 的体感），上限 8000；正数原样使用 */
const DEFAULT_TOKENS = 3000;
const MAX_TOKENS = 8000;

export interface SnapshotOptions {
    /**
     * 快照 token 预算（默认 3000，上限 8000；正数原样使用）。
     * 0/负数 = 不返回内容（不是「无限」）；缺省/非数值 = 默认值。
     */
    tokens?: number;
    /**
     * @deprecated 旧参数（按用户轮数取范围）。为兼容旧调用保留一版：**接受但忽略**，
     * WARN 由工具入口（pub_read）发出，下一版删除；新调用请用 tokens。
     */
    rounds?: number;
    /**
     * @deprecated 旧参数（快照字符上限）。为兼容旧调用保留一版：**接受但忽略**，
     * WARN 由工具入口（pub_read）发出，下一版删除；新调用请用 tokens。
     */
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

/** 归一 token 预算：<=0 → 0（不返回内容）；非数值 → 默认；正数只压上限 MAX */
function normalizeTokenBudget(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_TOKENS;
    if (n <= 0) return 0;
    return Math.min(Math.floor(n), MAX_TOKENS);
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

/** 一条消息渲染出的快照块（多行）；块是最小选择单元，避免把一条消息拆成两半 */
type SnapshotBlock = string[];

function blockTokens(block: SnapshotBlock): number {
    return estimateTextTokens(block.join('\n'));
}

/**
 * 把目标会话的 context.messages 渲染为只读快照文本。
 * 返回 null 表示没有可展示内容（含 tokens<=0：0 = 不读取，不是「无限」）。
 */
export function renderPubSnapshot(messages: MessageType[], opts: SnapshotOptions = {}, resolve: (uid: string) => string = defaultNameOf): string | null {
    const tokenBudget = normalizeTokenBudget(opts.tokens);
    if (tokenBudget <= 0) return null;

    // 先把每条消息渲染成一个块（旧 → 新），再按 token 预算从最新往前选块。
    const blocks: SnapshotBlock[] = [];
    for (const m of messages) {
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
            if (rows.length > 0) blocks.push(rows);
        } else if (type === 'assistant') {
            const assistantMsg = m as AssistantMessage;
            const rows = ((assistantMsg.contentItems || []) as any[]).map(it => {
                if (!it || typeof it !== 'object' || typeof it.text !== 'string') return '';
                const text = it.text.trim();
                if (!text) return '';
                const msgId = it.messageId ? `[msg_id:${it.messageId}]` : '';
                return `${msgId ? msgId + ' ' : ''}Bot reply: ${text}`;
            }).filter(Boolean);
            if (rows.length > 0) blocks.push(rows);
        }
    }
    if (blocks.length === 0) return null;

    const picked = selectByTokenBudget(blocks, blockTokens, tokenBudget);
    if (picked.length === 0) return null;
    let out = picked.map(block => block.join('\n')).join('\n');

    // 最新块自身超预算时（alwaysKeepLatest）仍会保留，这里按 token 兜底截断；其余块已按预算选入。
    const totalTokens = estimateTextTokens(out);
    if (totalTokens > tokenBudget) {
        const slice = truncateToTokenBudget(out, tokenBudget, estimateTextTokens);
        out = slice.text + `\n[snapshot truncated: exceeded ${tokenBudget} tokens; call again with a larger tokens value for more]`;
    }
    return out;
}
