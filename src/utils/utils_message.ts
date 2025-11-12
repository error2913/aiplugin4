import { AI, GroupInfo, UserInfo } from "../AI/AI";
import { Message } from "../AI/context";
import { ConfigManager } from "../config/configManager";
import { ToolInfo } from "../tool/tool";
import { fmtDate } from "./utils_string";
import { knowledgeMM } from "../AI/memory";

export async function buildSystemMessage(ctx: seal.MsgContext, ai: AI): Promise<Message> {
    const { systemMessageTemplate, isPrefix, showNumber, showMsgId, showTime } = ConfigManager.message;
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const { localImagePathMap, receiveImage, condition } = ConfigManager.image;
    const { isMemory, isShortMemory } = ConfigManager.memory;

    // 可发送的图片提示
    const sandableImagesPrompt: string = Object.keys(localImagePathMap)
        .concat(ai.imageManager.savedImages.map(img => `${img.id}\n应用场景: ${img.scenes.join('、')}`))
        .map((prompt, index) => `${index + 1}. ${prompt}`)
        .join('\n');


    // 角色设定
    const { roleIndex, roleSetting } = getRoleSetting(ctx);

    // 获取lastMsg
    const userMessages = ai.context.messages.filter(msg => msg.role === 'user' && !msg.name.startsWith('_'));
    let text = '', ui: UserInfo = null, gi: GroupInfo = null;
    if (userMessages.length > 0) {
        const lastMessage = userMessages[userMessages.length - 1];
        text = lastMessage.msgArray.map(mi => mi.content).join('');
        ui = {
            isPrivate: true,
            id: lastMessage.uid,
            name: lastMessage.name
        }
        gi = {
            isPrivate: false,
            id: ctx.group.groupId,
            name: ctx.group.groupName
        }
    }

    // 知识库
    const knowledgePrompt = await knowledgeMM.buildKnowledgeMemoryPrompt(roleIndex, text, ui, gi);
    // 记忆
    const memoryPrompt = isMemory ? await ai.memory.buildMemoryPrompt(ctx, ai.context, text, ui, gi) : '';
    // 短期记忆
    const shortMemoryPrompt = isShortMemory && ai.memory.useShortMemory ? ai.memory.shortMemoryList.map((item, index) => `${index + 1}. ${item}`).join('\n') : '';
    // 调用函数
    const toolsPrompt = isTool && usePromptEngineering ? ai.tool.getToolsPrompt(ctx) : '';

    const content = systemMessageTemplate({
        "角色设定": roleSetting,
        "平台": ctx.endPoint.platform,
        "私聊": ctx.isPrivate,
        "展示号码": showNumber,
        "用户名称": ctx.player.name,
        "用户号码": ctx.player.userId.replace(/^.+:/, ''),
        "群聊名称": ctx.group.groupName,
        "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
        "添加前缀": isPrefix,
        "展示消息ID": showMsgId,
        "展示时间": showTime,
        "接收图片": receiveImage,
        "图片条件不为零": condition !== '0',
        "可发送图片不为空": sandableImagesPrompt,
        "可发送图片列表": sandableImagesPrompt,
        "知识库": knowledgePrompt,
        "开启长期记忆": isMemory && memoryPrompt,
        "记忆信息": memoryPrompt,
        "开启短期记忆": isShortMemory && ai.memory.useShortMemory && shortMemoryPrompt,
        "短期记忆信息": shortMemoryPrompt,
        "开启工具函数提示词": isTool && usePromptEngineering,
        "函数列表": toolsPrompt
    });

    const systemMessage: Message = {
        role: "system",
        uid: '',
        name: '',
        images: [],
        msgArray: [{
            msgId: '',
            time: Math.floor(Date.now() / 1000),
            content: content
        }]
    };

    return systemMessage;
}

function buildSamplesMessages(ctx: seal.MsgContext): Message[] {
    const { samples } = ConfigManager.message;

    const samplesMessages: Message[] = samples
        .map((item, index) => {
            if (item == "") {
                return null;
            } else if (index % 2 === 0) {
                return {
                    role: "user",
                    uid: '',
                    name: "用户",
                    images: [],
                    msgArray: [{
                        msgId: '',
                        time: Math.floor(Date.now() / 1000),
                        content: item
                    }]
                };
            } else {
                return {
                    role: "assistant",
                    uid: ctx.endPoint.userId,
                    name: seal.formatTmpl(ctx, "核心:骰子名字"),
                    images: [],
                    msgArray: [{
                        msgId: '',
                        time: Math.floor(Date.now() / 1000),
                        content: item
                    }]
                };
            }
        })
        .filter((item) => item !== null);

    return samplesMessages;
}

function buildContextMessages(systemMessage: Message, messages: Message[]): Message[] {
    const { insertCount } = ConfigManager.message;

    const contextMessages = messages.slice();

    if (insertCount <= 0) {
        return contextMessages;
    }

    const userPositions = contextMessages
        .map((item, index) => (item.role === 'user' ? index : -1))
        .filter(index => index !== -1);

    if (userPositions.length <= insertCount) {
        return contextMessages;
    }

    for (let i = userPositions.length - 1; i >= 0; i--) {
        if (i + 1 <= insertCount) {
            break;
        }

        const index = userPositions[i];
        if ((userPositions.length - i) % insertCount === 0) {
            contextMessages.splice(index, 0, systemMessage); //从后往前数的个数是insertCount的倍数时，插入到消息前面
        }
    }

    return contextMessages;
}

export async function handleMessages(ctx: seal.MsgContext, ai: AI) {
    const { isMerge } = ConfigManager.message;

    const systemMessage = await buildSystemMessage(ctx, ai);
    const samplesMessages = buildSamplesMessages(ctx);
    const contextMessages = buildContextMessages(systemMessage, ai.context.messages);

    const messages = [systemMessage, ...samplesMessages, ...contextMessages];

    // 处理 tool_calls 并过滤无效项
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (!message?.tool_calls) {
            continue;
        }

        // 获取tool_calls消息后面的所有tool_call_id
        const tool_call_id_set = new Set<string>();
        for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role !== 'tool') {
                break;
            }
            tool_call_id_set.add(messages[j].tool_call_id);
        }

        // 过滤无对应 tool_call_id 的 tool_calls
        for (let j = 0; j < message.tool_calls.length; j++) {
            const tool_call = message.tool_calls[j];
            if (!tool_call_id_set.has(tool_call.id)) {
                message.tool_calls.splice(j, 1);
                j--; // 调整索引
            }
        }

        // 如果 tool_calls 为空则移除消息
        if (message.tool_calls.length === 0) {
            messages.splice(i, 1);
            i--; // 调整索引
        }
    }

    // 处理前缀并合并消息（如果有）
    let processedMessages = [];
    let last_role = '';
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];

        if (isMerge && message.role === last_role && message.role !== 'tool') {
            processedMessages[processedMessages.length - 1].content += '\f' + buildContent(message);
        } else {
            processedMessages.push({
                role: message.role,
                content: buildContent(message),
                tool_calls: message?.tool_calls,
                tool_call_id: message?.tool_call_id
            });
            last_role = message.role;
        }
    }

    return processedMessages;
}

export function parseBody(template: string[], messages: any[], tools: ToolInfo[], tool_choice: string) {
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const bodyObject: any = {};

    for (let i = 0; i < template.length; i++) {
        const s = template[i];
        if (s.trim() === '') {
            continue;
        }

        try {
            const obj = JSON.parse(`{${s}}`);
            const key = Object.keys(obj)[0];
            bodyObject[key] = obj[key];
        } catch (err) {
            throw new Error(`解析body的【${s}】时出现错误:${err}`);
        }
    }

    if (!bodyObject.hasOwnProperty('messages')) {
        bodyObject.messages = messages;
    }

    if (!bodyObject.hasOwnProperty('model')) {
        throw new Error(`body中没有model`);
    }

    if (isTool && !usePromptEngineering) {
        if (!bodyObject.hasOwnProperty('tools')) {
            bodyObject.tools = tools;
        }

        if (!bodyObject.hasOwnProperty('tool_choice')) {
            bodyObject.tool_choice = tool_choice;
        }
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
        if (s.trim() === '') {
            continue;
        }

        try {
            const obj = JSON.parse(`{${s}}`);
            const key = Object.keys(obj)[0];
            bodyObject[key] = obj[key];
        } catch (err) {
            throw new Error(`解析body的【${s}】时出现错误:${err}`);
        }
    }

    if (!bodyObject.hasOwnProperty('input')) {
        bodyObject.input = input;
    }
    if (!bodyObject.hasOwnProperty('dimensions')) {
        bodyObject.dimensions = dimensions;
    }

    return bodyObject;
}

export function buildContent(message: Message): string {
    const { isPrefix, showNumber, showMsgId, showTime } = ConfigManager.message;
    const prefix = (isPrefix && message.name) ? (
        message.name.startsWith('_') ?
            `<|${message.name}|>` :
            `<|from:${message.name}${showNumber ? `(${message.uid.replace(/^.+:/, '')})` : ``}|>`
    ) : '';
    const content = message.msgArray.map(m =>
        ((showMsgId && m.msgId) ? `<|msg_id:${m.msgId}|>` : '') +
        (showTime ? `<|time:${fmtDate(m.time)}|>` : '') +
        m.content
    ).join('\f');
    return prefix + content;
}

export function getRoleSetting(ctx: seal.MsgContext) {
    const { roleSettingNames, roleSettingTemplate } = ConfigManager.message;
    // 角色设定
    const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
    let roleIndex = 0;
    if (exists && roleName !== '' && roleSettingNames.includes(roleName)) {
        roleIndex = roleSettingNames.indexOf(roleName);
        if (roleIndex < 0 || roleIndex >= roleSettingTemplate.length) roleIndex = 0;
    } else {
        const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
        if (exists2 && roleIndex2 >= 0 && roleIndex2 < roleSettingTemplate.length) roleIndex = roleIndex2;
    }
    return { roleName, roleIndex, roleSetting: roleSettingTemplate[roleIndex] }
}