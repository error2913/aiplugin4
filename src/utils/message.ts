// 消息构建：system prompt 组装与 body 解析
import Config from "../config/config";
import { parseRoleEntry } from "../config/configs/message";
import { logger } from "../logger";
import { buildSystemPromptContent } from "../prompt/builder";
import Image from "../resource/image";
import { Session } from "../session/session";
import User from "../session/user";
import { ToolCall, ToolContentPart } from "../tool/types";

import { fmtDate } from "./string";
import { withTimeout } from "./utils";

/** OpenAI 兼容内容：纯文本，或多模态内容块（文本 + 图片） */
export type RequestMessageContent =
    | string
    | Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }>;

export interface RequestMessage {
    role: string;
    content: RequestMessageContent;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
}

interface MessageItem {
    text: string;
    time: number;
    userId?: string;
    messageId?: string;
    systemName?: string;
    reasoningContent?: string;
}

interface ContextMessage {
    role: string;
    contentItems?: MessageItem[];
    text?: string;
    contentParts?: ToolContentPart[];
    toolName?: string; // 工具名：prompt 工程模式下把工具结果转回 user 消息时保留来源
    toolCalls?: ToolCall[];
    tool_calls?: ToolCall[];
    toolCallId?: string;
    tool_call_id?: string;
    reasoningContent?: string;
}

const SYSTEM_REMINDER_TEXT = '请继续遵守上方角色设定、上下文标记和工具调用规范。';

/**
 * 无依赖的 token 估算：ASCII 约 4 字符/token，非 ASCII（中文等）约 1 字符/token。
 * 用于「上下文最大token」的整包预算估算，避免依赖外部 tokenizer。
 */
export function estimateTextTokens(text: string): number {
    let ascii = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) <= 0x7F) ascii++;
    }
    return Math.ceil(ascii / 4) + (text.length - ascii);
}

/**
 * 单条消息 token 估算：与 estimateTextTokens 同一口径（ASCII 4 字符/token，非 ASCII 1 字符/token）。
 * 兼容 RequestMessage（content 为字符串或多模态内容块）与 ContextMessage（contentItems/text），
 * 并把 assistant 的 tool_calls JSON 一并计入，使「上下文最大token」与请求体真实负载一致；
 * applyTokenBudget 与 stream.checkRequestBudget 统一使用该口径，避免两套估算不一致。
 * 多模态图片 URL/base64 只按固定 [image] 开销估算，避免把 base64 当纯文本猛算。
 */
export function estimateMessageTokens(m: ContextMessage | RequestMessage): number {
    let text = '';
    const content = (m as RequestMessage).content;
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        text = content.map(part => part.type === 'text' ? part.text : '[image]').join('');
    } else {
        const contextMessage = m as ContextMessage;
        if (Array.isArray(contextMessage.contentParts) && contextMessage.contentParts.length > 0) {
            text = contextMessage.contentParts
                .map(part => part.type === 'text' ? part.text : '[image]')
                .join('');
        } else {
            text = buildContent(contextMessage);
        }
    }
    const toolCalls = (m as ContextMessage).toolCalls || (m as RequestMessage).tool_calls;
    const toolCallsEst = Array.isArray(toolCalls) && toolCalls.length > 0
        ? estimateTextTokens(JSON.stringify(toolCalls))
        : 0;
    return estimateTextTokens(text) + toolCallsEst;
}

/**
 * 取消息携带的思维链：消息级字段（tool_calls 消息）或内容条目级字段（assistant 文本消息）。
 * 空字符串也原样返回（DeepSeek thinking mode 要求字段本身必须回传，不能忽略）。
 */
function resolveReasoningContent(message: ContextMessage): string | undefined {
    if (message.reasoningContent !== undefined) return message.reasoningContent;
    if (Array.isArray(message.contentItems)) {
        const item = message.contentItems.find(i => i && i.reasoningContent !== undefined);
        if (item) return item.reasoningContent;
    }
    return undefined;
}

export async function buildSystemMessage(ctx: seal.MsgContext, session: Session): Promise<ContextMessage> {
    const { roleIndex, roleSetting } = getRoleSetting(ctx);
    const content = await buildSystemPromptContent(ctx, session, roleIndex, roleSetting);

    return {
        role: 'system',
        contentItems: [{
            text: content,
            time: Math.floor(Date.now() / 1000),
            systemName: ''
        }]
    };
}

function buildSamplesMessages(ctx: seal.MsgContext): ContextMessage[] {
    const { SAMPLE_MESSAGES } = Config.message;

    return SAMPLE_MESSAGES
        .map((item, index) => ({ item, index }))
        .filter(x => x.item.trim() !== '')
        .map((x, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            contentItems: [{
                text: x.item,
                time: Math.floor(Date.now() / 1000),
                userId: i % 2 === 0 ? '' : ctx.endPoint.userId
            }]
        }));
}

function buildContextMessages(messages: ContextMessage[]): ContextMessage[] {
    const { INSERT_COUNT } = Config.message;

    const contextMessages = messages.slice();
    if (INSERT_COUNT <= 0) return contextMessages;

    // 顺序遍历：在第 INSERT_COUNT+1 条及之后每隔 INSERT_COUNT 条用户消息前插入短提醒，
    // 避免把完整角色设定、资源说明和工具说明按轮数反复复制进上下文。
    let userCount = 0;
    const result: ContextMessage[] = [];
    for (const m of contextMessages) {
        if (m.role === 'user' && userCount > 0 && userCount % INSERT_COUNT === 0) {
            result.push({ role: 'system', text: SYSTEM_REMINDER_TEXT });
        }
        result.push(m);
        if (m.role === 'user') userCount++;
    }
    return result;
}

/**
 * 请求组装前克隆上下文消息，避免 token 裁剪/tool_calls 过滤污染持久化会话数据。
 */
function cloneContextMessage(message: ContextMessage): ContextMessage {
    const clone: ContextMessage = { ...message };

    if (Array.isArray(message.contentItems)) {
        clone.contentItems = message.contentItems.map(item => ({ ...item }));
    }

    if (Array.isArray(message.toolCalls)) {
        clone.toolCalls = message.toolCalls.map(tc => ({
            ...tc,
            function: tc.function ? { ...tc.function } : tc.function
        }));
    }

    if (Array.isArray(message.tool_calls)) {
        clone.tool_calls = message.tool_calls.map(tc => ({
            ...tc,
            function: tc.function ? { ...tc.function } : tc.function
        }));
    }

    return clone;
}


/**
 * 紧急兜底截断：把单条消息的渲染文本裁剪到 maxChars（保留尾部最近内容），返回实际移除的字符数。
 * 仅用于预算兜底（如单条超大消息/合并转发/工具长结果），结构上简化为单段文本，不动 tool_calls。
 */
function truncateMessageText(message: ContextMessage, maxChars: number): number {
    const before = buildContent(message);
    if (before.length <= maxChars) return 0;
    // 截断会清空 contentItems，先把思维链提升到消息级，避免后续请求丢失 reasoning_content
    const reasoning = resolveReasoningContent(message);
    message.contentItems = undefined;
    message.text = before.slice(-maxChars);
    if (reasoning !== undefined) message.reasoningContent = reasoning;
    return before.length - message.text.length;
}

/**
 * token 预算裁剪：在 system + samples + context 完整组装后统一计算，超出预算时从最早的
 * context 消息开始丢弃；system 与 samples 永不丢弃。tools 的 JSON 长度同样预留进预算，
 * 使「上下文最大token」更接近真实请求体上限。
 *
 * 单条超大消息兜底：当某条未保护消息本身超过当前缺口（典型为合并转发/工具长结果等
 * 单条消息过大，整条丢弃会清空全部上下文）时，改为按超出量截断其渲染文本（保留尾部），
 * 而不是让请求体带着超限预算直接发送，也不会把整个会话上下文一次性清空。
 */
function applyTokenBudget(messages: ContextMessage[], protectedCount: number, tools?: unknown[]): ContextMessage[] {
    const { MAX_CONTEXT_TOKENS: maxTokens } = Config.message;
    if (maxTokens <= 0) return messages;

    const reserve = tools && tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;
    const budget = Math.max(maxTokens - reserve, 1);
    const totalTokens = () => messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    let tokens = totalTokens();

    while (tokens > budget && messages.length > protectedCount) {
        const over = tokens - budget;

        // 找未保护段中渲染文本最长的一条
        let longestIdx = -1, longestLen = 0, longestEst = 0;
        for (let i = protectedCount; i < messages.length; i++) {
            const len = buildContent(messages[i]).length;
            if (len > longestLen) {
                longestLen = len;
                longestIdx = i;
                longestEst = estimateMessageTokens(messages[i]);
            }
        }

        // 单条消息本身超过缺口：截断比整条丢弃更能保留上下文
        if (longestIdx >= 0 && longestLen > 0 && longestEst > over) {
            const prev = tokens;
            // 按超出量折算需移除的字符数（每 token 约等于该消息的字符/token 比值）
            const charsToRemove = Math.max(1, Math.ceil(longestLen * (over / longestEst)));
            truncateMessageText(messages[longestIdx], Math.max(1, longestLen - charsToRemove));
            tokens = totalTokens();
            // 截断未降低估算（如超出量主要来自 tool_calls）时停止，避免死循环
            if (tokens >= prev) break;
            continue;
        }

        // 常规情况：整条丢弃最早的未保护消息
        tokens -= estimateMessageTokens(messages[protectedCount]);
        messages.splice(protectedCount, 1);
    }
    return messages;
}

export async function handleMessages(
    ctx: seal.MsgContext,
    session: Session,
    multimodal = false,
    tools?: unknown[],
    systemMessage?: ContextMessage
): Promise<RequestMessage[]> {
    const system = systemMessage ?? await buildSystemMessage(ctx, session);
    const samplesMessages = buildSamplesMessages(ctx);
    const contextMessages = buildContextMessages(
        (session.context.messages as ContextMessage[]).map(cloneContextMessage)
    );

    const messages: ContextMessage[] = applyTokenBudget(
        [system, ...samplesMessages, ...contextMessages],
        samplesMessages.length + 1,
        tools
    );

    // 提示词工程模式：不向 API 发送 role:'tool'，也不带 assistant tool_calls；
    // 工具结果转成 user 文本（带【工具返回】标记），保证模型能看到结果而不会反复调用工具
    if (Config.tool.PROMPT_ENGINEERING) {
        return await Promise.all(messages.map(async message => {
            if (message.role === 'tool') {
                // 保留工具名来源，便于模型区分不同工具的返回；旧上下文无 toolName 时退化为通用标记
                const toolName = (message as ContextMessage).toolName;
                return {
                    role: 'user',
                    content: toolName ? `【工具返回:${toolName}】${buildContent(message)}` : `【工具返回】${buildContent(message)}`
                };
            }
            const out: RequestMessage = {
                role: message.role,
                content: multimodal ? await buildMultimodalContent(message) : buildContent(message)
            };
            const reasoning = resolveReasoningContent(message);
            if (reasoning !== undefined) out.reasoning_content = reasoning;
            return out;
        }));
    }

    // 过滤没有对应 tool_call_id 的 tool_calls
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const toolCalls = message.toolCalls || message.tool_calls;
        if (!toolCalls || toolCalls.length === 0) continue;

        const toolCallIdSet = new Set<string>();
        for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role !== 'tool') break;
            toolCallIdSet.add(messages[j].toolCallId || messages[j].tool_call_id || '');
        }

        for (let j = 0; j < toolCalls.length; j++) {
            if (!toolCalls[j].id || !toolCallIdSet.has(toolCalls[j].id)) {
                toolCalls.splice(j, 1);
                j--;
            }
        }

        if (toolCalls.length === 0) {
            // assistant 的 tool_calls 全部被过滤时，同步删除其后跟随的 tool 消息，避免孤立
            for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
                messages.splice(j, 1);
                j--;
            }
            messages.splice(i, 1);
            i--;
        }
    }

    // 清理孤立 tool 消息：前面不存在对应 assistant tool_calls 的 tool 结果直接丢弃，
    // 避免发送给 API 时出现 "role 'tool' 必须跟在对应 tool_calls 之后" 报错（如上下文被裁剪后残留）
    const toolCallIdSet = new Set<string>();
    for (const message of messages) {
        const toolCalls = message.toolCalls || message.tool_calls;
        if (message.role === 'assistant' && toolCalls) {
            for (const tc of toolCalls) toolCallIdSet.add(tc.id);
        }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'tool') continue;
        const id = message.toolCallId || message.tool_call_id || '';
        if (!toolCallIdSet.has(id)) messages.splice(i, 1);
    }

    return await Promise.all(messages.map(async message => {
        const out: RequestMessage = {
            role: message.role,
            content: message.role === 'tool'
                ? (multimodal && Array.isArray(message.contentParts) && message.contentParts.length > 0
                    ? message.contentParts
                    : buildContent(message))
                : (multimodal ? await buildMultimodalContent(message) : buildContent(message))
        };
        // 只在 assistant 且 tool_calls 非空时附带该字段：空数组在 JSON 里是合法值，
        // 会被原样序列化为 "tool_calls":[]，部分后端直接报错拒绝请求
        if (message.role === 'assistant') {
            const toolCalls = message.toolCalls || message.tool_calls;
            if (Array.isArray(toolCalls) && toolCalls.length > 0) out.tool_calls = toolCalls;
        }
        // tool 消息必须携带非空 tool_call_id；缺失的已在上方孤立清理流程中丢弃
        if (message.role === 'tool' && (message.toolCallId || message.tool_call_id)) {
            out.tool_call_id = message.toolCallId || message.tool_call_id;
        }
        // thinking mode（DeepSeek V4 等）：带工具调用轮次的 assistant 消息必须原样回传
        // reasoning_content（含空字符串，字段本身不能丢），否则后续请求会 400
        if (message.role === 'assistant') {
            const reasoning = resolveReasoningContent(message);
            if (reasoning !== undefined) out.reasoning_content = reasoning;
        }
        return out;
    }));
}

export function buildContent(message: ContextMessage): string {
    if (message.contentItems && message.contentItems.length > 0) {
        // 用户消息逐条补上发送者/时间/消息ID：连续多条 user 消息会被合并进同一个
        // contentItems，若只在消息级补一次前缀，后续条目的发送者会全部丢失。
        // from 只在发送者切换时渲染（相同发送者连续发言省略，节省 token 且更自然）
        if (message.role === 'user') {
            let lastUserId = '';
            return message.contentItems.map(item => {
                let from = '';
                // 系统名义消息（systemName）不参与发送者切换判断，也不渲染 from
                if (item.userId && item.userId !== lastUserId) {
                    from = formatFromPrefix(item.userId);
                }
                if (item.userId) lastUserId = item.userId;
                return from
                    + (item.time ? `[time:${fmtDate(item.time)}]` : '')
                    + (item.messageId ? `[msg_id:${item.messageId}]` : '')
                    + (item.text || '');
            }).join('\f');
        }
        // 非用户消息：只保留消息 ID；时间顺序由消息数组本身表达，去掉重复时间前缀。
        return message.contentItems.map(item =>
            (item.messageId ? `[msg_id:${item.messageId}]` : '')
            + (item.text || '')
        ).join('\f');
    }
    if (message.text) return message.text;
    return '';
}

/** 把 uid（QQ:xxx）渲染成 [from:名字(QQ号)]，未记录名字时退化为 [from:QQ号] */
function formatFromPrefix(uid: string): string {
    const number = uid.replace(/^.+:/, '');
    const name = User.get(uid).userName;
    return name ? `[from:${name}(${number})]` : `[from:${number}]`;
}

/** 解析 [img:...] 标签里的图片 id（兼容 user_avatar/group_avatar 前缀与「id:描述」形式） */
function resolveImageById(id: string): Image | null {
    if (/^user_avatar[:?]/.test(id)) return Image.getUserAvatar(id.replace(/^user_avatar[:?]/, ''));
    if (/^group_avatar[:?]/.test(id)) return Image.getGroupAvatar(id.replace(/^group_avatar[:?]/, ''));
    const img = Image.get(id);
    if (img) return img;
    // 兼容 [img:imageId:描述]：描述部分可能带冒号，取首个冒号前作为图片 id
    return Image.get(id.split(':')[0]);
}

/**
 * 多模态消息内容：把用户消息里的 [img:...] 图片标签转成 image_url 内容块直接传给模型，
 * 而不是让模型只看到文本标签；无法解析的图片（如本地路径无可用 URL）保留原标签。
 */
export async function buildMultimodalContent(message: ContextMessage): Promise<RequestMessageContent> {
    if (message.role !== 'user') return buildContent(message);
    const text = buildContent(message);
    if (!/\[(?:img|avatar|group_avatar)[:：]/i.test(text)) return text;

    const parts: Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }> = [];
    const segs = text.split(/([[［](?:img|avatar|group_avatar)[:：]?[^\]］]*[\]］])/).filter(Boolean);
    for (const seg of segs) {
        const match = seg.match(/^[[［](img|avatar|group_avatar)[:：]?\s?(.*?)[\]］]$/i);
        if (!match) {
            parts.push({ type: 'text', text: seg });
            continue;
        }
        const type = match[1].toLowerCase();
        const value = match[2].trim();
        let image: Image | null = null;
        if (type === 'avatar') {
            image = Image.getUserAvatar(value);
        } else if (type === 'group_avatar') {
            image = Image.getGroupAvatar(value);
        } else {
            image = resolveImageById(value);
        }
        // URL 图片优先转成 base64（模型常无法直接访问 QQ 临时链接）；转换失败保留原 URL
        if (image && image.type === 'url' && !image.base64) {
            try {
                await withTimeout(() => image.urlToBase64(), 10000);
            } catch (e) {
                logger.warning(`多模态图片转 base64 失败，改用原 URL: ${image.imageId}（${e instanceof Error ? e.message : String(e)}）`);
            }
        }
        const src = image && image.src;
        if (src) parts.push({ type: 'image_url', image_url: { url: src } });
        else parts.push({ type: 'text', text: seg });
    }
    return parts;
}

export function getRoleSetting(ctx: seal.MsgContext) {
    const { ROLE_NAMES, INSTRUCTIONS } = Config.message;
    const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
    let roleIndex = 0;
    if (exists && roleName !== '' && ROLE_NAMES.includes(roleName)) {
        roleIndex = ROLE_NAMES.indexOf(roleName);
        if (roleIndex < 0 || roleIndex >= INSTRUCTIONS.length) roleIndex = 0;
    } else {
        const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
        if (exists2 && roleIndex2 >= 0 && roleIndex2 < INSTRUCTIONS.length) roleIndex = roleIndex2;
    }
    return { roleName, roleIndex, roleSetting: parseRoleEntry(INSTRUCTIONS[roleIndex]).setting }
}
