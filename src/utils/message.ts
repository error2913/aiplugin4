// 消息构建：system prompt/上下文消息组装与 body 解析
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import Config from "../config/config";
import { ToolInfo } from "../tool/types";
import Tool from "../tool/tool";
import { knowledgeService } from "../memory/knowledge";
import User from "../session/user";
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
    const { RECEIVE_IMAGE } = Config.received;
    const { MEMORY, SUMMARY, KNOWLEDGE } = Config.memory;
    const { STATUS, PROMPT_ENGINEERING } = Config.tool;

    // 本地可发送资源（图片/语音）来自“资源”配置
    const localImages = (Config.resource.LOCAL_IMAGES || []).map(img => ({ imageId: img.imageId }));
    const localAudios: any[] = Config.resource.LOCAL_AUDIOS || [];

    const { roleIndex, roleSetting } = getRoleSetting(ctx);

    // 取最后一条用户消息，作为记忆/知识库查询的上下文
    const userMessages = session.context.messages.filter(m => m.role === 'user');
    let text = '', ui: UserInfo = null, gi: GroupInfo = null;
    const lastUser = userMessages[userMessages.length - 1] as any;
    if (lastUser && Array.isArray(lastUser.contentItems) && lastUser.contentItems.length > 0) {
        const lastItem = lastUser.contentItems[lastUser.contentItems.length - 1];
        text = lastItem.text || '';
        if (lastItem.userId) {
            const u = User.get(lastItem.userId);
            ui = { isPrivate: true, id: lastItem.userId, name: u.userName || lastItem.userId };
        }
        gi = { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
    }

    const knowledgePrompt = KNOWLEDGE ? await knowledgeService.buildKnowledgeMemoryPrompt(roleIndex, text, ui, gi) : '';
    const memoryPrompt = MEMORY ? await session.memory.buildMemoryPrompt(ctx, session.context, text, ui, gi) : '';
    const summaryPrompt = SUMMARY ? session.memory.buildSummaryPrompt() : '';
    const toolsPrompt = STATUS && PROMPT_ENGINEERING ? Tool.getToolsInfoPrompt(session) : '';

    const content = Config.prompt.SYSTEM_MESSAGE_TEMPLATE({
        instruction: roleSetting,
        platform: ctx.endPoint.platform,
        sessionType: ctx.isPrivate ? 'private' : 'group',
        sessionName: ctx.isPrivate ? ctx.player.name : ctx.group.groupName,
        sessionId: ctx.isPrivate ? ctx.player.userId : ctx.group.groupId,
        RECEIVE_IMAGE,
        LOCAL_IMAGES: localImages,
        LOCAL_AUDIOS: localAudios,
        memoryPrompt,
        summaryPrompt,
        knowledgePrompt,
        toolPrompt: toolsPrompt
    });

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

    if (!bodyObject.hasOwnProperty('messages')) {
        bodyObject.messages = messages;
    }

    if (!bodyObject.hasOwnProperty('model')) {
        throw new Error('body 中没有 model');
    }

    if (STATUS && !PROMPT_ENGINEERING) {
        if (!bodyObject.hasOwnProperty('tools')) bodyObject.tools = tools;
        if (!bodyObject.hasOwnProperty('tool_choice')) bodyObject.tool_choice = tool_choice;
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

    if (!bodyObject.hasOwnProperty('input')) bodyObject.input = input;
    if (!bodyObject.hasOwnProperty('dimensions')) bodyObject.dimensions = dimensions;

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
