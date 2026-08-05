// 消息构建：system prompt 组装与 body 解析
import Config from "../config/config";
import { buildSystemPromptContent } from "../prompt/builder";
import { Session } from "../session/session";
import { ToolInfo } from "../tool/types";
import { ToolCall } from "../tool/types";

export interface RequestMessage {
    role: string;
    content: string;
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

export async function handleMessages(ctx: seal.MsgContext, session: Session): Promise<RequestMessage[]> {
    const systemMessage = await buildSystemMessage(ctx, session);
    const samplesMessages = buildSamplesMessages(ctx);
    const contextMessages = buildContextMessages(systemMessage, session.context.messages as ContextMessage[]);

    const messages: ContextMessage[] = [systemMessage, ...samplesMessages, ...contextMessages];

    // 过滤没有对应 tool_call_id 的 tool_calls
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const toolCalls = message.toolCalls || message.tool_calls;
        if (!toolCalls || toolCalls.length === 0) continue;

        const toolCallIdSet = new Set<string>();
        for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role !== 'tool') break;
            toolCallIdSet.add(messages[j].toolCallId || messages[j].tool_call_id);
        }

        for (let j = 0; j < toolCalls.length; j++) {
            if (!toolCallIdSet.has(toolCalls[j].id)) {
                toolCalls.splice(j, 1);
                j--;
            }
        }

        if (toolCalls.length === 0) {
            messages.splice(i, 1);
            i--;
        }
    }

    return messages.map(message => ({
        role: message.role,
        content: buildContent(message),
        tool_calls: message.toolCalls || message.tool_calls,
        tool_call_id: message.toolCallId || message.tool_call_id
    }));
}

export function buildContent(message: ContextMessage): string {
    if (message.contentItems && message.contentItems.length > 0) {
        return message.contentItems.map(item => item.text || '').join('\f');
    }
    if (message.text) return message.text;
    return '';
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
