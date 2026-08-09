// 消息构建：system prompt 组装与 body 解析
import Config from "../config/config";
import { logger } from "../logger";
import { buildSystemPromptContent } from "../prompt/builder";
import Image from "../resource/image";
import { Session } from "../session/session";
import { ToolInfo } from "../tool/types";
import { ToolCall } from "../tool/types";

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
}

interface MessageItem {
    text: string;
    time: number;
    userId?: string;
    messageId?: string;
    systemName?: string;
}

interface ContextMessage {
    role: string;
    contentItems?: MessageItem[];
    text?: string;
    toolCalls?: ToolCall[];
    tool_calls?: ToolCall[];
    toolCallId?: string;
    tool_call_id?: string;
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
        .map((item, index) => {
            if (item === '') return null;
            return {
                role: index % 2 === 0 ? 'user' : 'assistant',
                contentItems: [{
                    text: item,
                    time: Math.floor(Date.now() / 1000),
                    userId: index % 2 === 0 ? '' : ctx.endPoint.userId
                }]
            };
        })
        .filter(item => item !== null);
}

function buildContextMessages(systemMessage: ContextMessage, messages: ContextMessage[]): ContextMessage[] {
    const { INSERT_COUNT } = Config.message;

    const contextMessages = messages.slice();

    // token 预算裁剪（0 = 不限制）：超出后从最早的消息开始丢弃，保持窗口有界
    const { MAX_CONTEXT_TOKENS: maxTokens } = Config.message;
    if (maxTokens > 0) {
        const estimateTokens = (m: ContextMessage) => Math.ceil(buildContent(m).length / 2);
        let tokens = contextMessages.reduce((acc, m) => acc + estimateTokens(m), 0);
        while (tokens > maxTokens && contextMessages.length > 1) {
            tokens -= estimateTokens(contextMessages[0]);
            contextMessages.shift();
        }
    }

    if (INSERT_COUNT <= 0) return contextMessages;

    const userPositions = contextMessages
        .map((item, index) => (item.role === 'user' ? index : -1))
        .filter(index => index !== -1);

    if (userPositions.length <= INSERT_COUNT) return contextMessages;

    for (let i = userPositions.length - 1; i >= 0; i--) {
        if (i + 1 <= INSERT_COUNT) break;
        const index = userPositions[i];
        if ((userPositions.length - i) % INSERT_COUNT === 0) {
            contextMessages.splice(index, 0, systemMessage);
        }
    }

    return contextMessages;
}

export async function handleMessages(ctx: seal.MsgContext, session: Session, multimodal = false): Promise<RequestMessage[]> {
    const systemMessage = await buildSystemMessage(ctx, session);
    const samplesMessages = buildSamplesMessages(ctx);
    const contextMessages = buildContextMessages(systemMessage, session.context.messages as ContextMessage[]);

    const messages: ContextMessage[] = [systemMessage, ...samplesMessages, ...contextMessages];

    // 提示词工程模式：不向 API 发送 role:'tool'，也不带 assistant tool_calls；
    // 工具结果转成 user 文本（带【工具返回】标记），保证模型能看到结果而不会反复调用工具
    if (Config.tool.PROMPT_ENGINEERING) {
        return await Promise.all(messages.map(async message => {
            if (message.role === 'tool') {
                return { role: 'user', content: `【工具返回】${buildContent(message)}` };
            }
            return {
                role: message.role,
                content: multimodal ? await buildMultimodalContent(message) : buildContent(message)
            };
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
            if (!toolCallIdSet.has(toolCalls[j].id)) {
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

    return await Promise.all(messages.map(async message => ({
        role: message.role,
        content: multimodal ? await buildMultimodalContent(message) : buildContent(message),
        tool_calls: message.toolCalls || message.tool_calls,
        tool_call_id: message.toolCallId || message.tool_call_id
    })));
}

export function buildContent(message: ContextMessage): string {
    if (message.contentItems && message.contentItems.length > 0) {
        return message.contentItems.map(item => item.text || '').join('\f');
    }
    if (message.text) return message.text;
    return '';
}

/** 解析 <|img:...|> 标签里的图片 id（兼容 user_avatar/group_avatar 前缀与「id:描述」形式） */
function resolveImageById(id: string): Image | null {
    if (/^user_avatar[:?]/.test(id)) return Image.getUserAvatar(id.replace(/^user_avatar[:?]/, ''));
    if (/^group_avatar[:?]/.test(id)) return Image.getGroupAvatar(id.replace(/^group_avatar[:?]/, ''));
    const img = Image.get(id);
    if (img) return img;
    // 兼容 <|img:imageId:描述|>：描述部分可能带冒号，取首个冒号前作为图片 id
    return Image.get(id.split(':')[0]);
}

/**
 * 多模态消息内容：把用户消息里的 <|img:...|> 图片标签转成 image_url 内容块直接传给模型，
 * 而不是让模型只看到文本标签；无法解析的图片（如本地路径无可用 URL）保留原标签。
 */
export async function buildMultimodalContent(message: ContextMessage): Promise<RequestMessageContent> {
    if (message.role !== 'user') return buildContent(message);
    const text = buildContent(message);
    if (!text.includes('img')) return text;

    const parts: Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }> = [];
    const segs = text.split(/([<＜][\|│｜][^:：]+[:：]?\s?.+?(?:[\|│｜][>＞]|[\|│｜>＞]))/).filter(Boolean);
    for (const seg of segs) {
        const match = seg.match(/^[<＜][\|│｜]img[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])$/i);
        if (!match) {
            parts.push({ type: 'text', text: seg });
            continue;
        }
        const image = resolveImageById(match[1].trim());
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

export function parseBody(template: string[], messages: any[], tools: ToolInfo[], tool_choice: string) {
    const { STATUS, PROMPT_ENGINEERING } = Config.tool;
    const bodyObject: any = {};

    for (let i = 0; i < template.length; i++) {
        const s = template[i];
        if (s.trim() === '') continue;
        try {
            const obj = JSON.parse(`{${s}}`);
            const key = Object.keys(obj)[0];
            bodyObject[key] = obj[key];
        } catch (err) {
            throw new Error(`parse body "${s}" error: ${err}`);
        }
    }

    if (!Object.prototype.hasOwnProperty.call(bodyObject, 'messages')) {
        bodyObject.messages = messages;
    }

    if (!Object.prototype.hasOwnProperty.call(bodyObject, 'model')) {
        throw new Error('body 中没有 model');
    }

    if (STATUS && !PROMPT_ENGINEERING) {
        if (!Object.prototype.hasOwnProperty.call(bodyObject, 'tools')) bodyObject.tools = tools;
        if (!Object.prototype.hasOwnProperty.call(bodyObject, 'tool_choice')) bodyObject.tool_choice = tool_choice;
    } else {
        delete bodyObject?.tools;
        delete bodyObject?.tool_choice;
    }

    return bodyObject;
}

export function parseEmbeddingBody(template: string[], input: string, dimensions: number) {
    const bodyObject: any = {};

    for (let i = 0; i < template.length; i++) {
        const s = template[i];
        if (s.trim() === '') continue;
        try {
            const obj = JSON.parse(`{${s}}`);
            const key = Object.keys(obj)[0];
            bodyObject[key] = obj[key];
        } catch (err) {
            throw new Error(`parse body "${s}" error: ${err}`);
        }
    }

    if (!Object.prototype.hasOwnProperty.call(bodyObject, 'input')) bodyObject.input = input;
    if (!Object.prototype.hasOwnProperty.call(bodyObject, 'dimensions')) bodyObject.dimensions = dimensions;

    return bodyObject;
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
    return { roleName, roleIndex, roleSetting: INSTRUCTIONS[roleIndex] }
}
