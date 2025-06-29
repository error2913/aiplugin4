import Handlebars from "handlebars";
import { AI } from "../AI/AI";
import { Message } from "../AI/context";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { ToolInfo } from "../tool/tool";

export function buildSystemMessage(ctx: seal.MsgContext, ai: AI): Message {
    const { roleSettingTemplate, systemMessageTemplate, isPrefix, showNumber, showMsgId } = ConfigManager.message;
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const { localImagePaths, receiveImage, condition } = ConfigManager.image;
    const { isMemory, isShortMemory } = ConfigManager.memory;
    const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
        if (path.trim() === '') {
            return acc;
        }
        try {
            const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
            if (!name) {
                throw new Error(`本地图片路径格式错误:${path}`);
            }

            acc[name] = path;
        } catch (e) {
            logger.error(e);
        }
        return acc;
    }, {});

    const savedImages = ai.image.imageList.filter(img => !img.isUrl);
    const savedImageNames = savedImages.map(img => {
        try {
            const meta = JSON.parse(img.content);
            return meta.scene ? `${meta.name}（${meta.scene}）` : meta.name;
        } catch {
            return '';
        }
    }).filter(Boolean).join("、");    

    let [roleSettingIndex, _] = seal.vars.intGet(ctx, "$gSYSPROMPT");
    if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
        roleSettingIndex = 0;
    }

    // 记忆
    let memoryPrompt = '';
    if (isMemory) {
        memoryPrompt = ai.memory.buildMemoryPrompt(ctx, ai.context);
    }

    // 短期记忆
    let shortMemoryPrompt = '';
    if (isShortMemory) {
        shortMemoryPrompt = ai.memory.shortMemory.map((item, index) => `${index + 1}. ${item}`).join('\n');
    }

    // 调用函数
    let toolsPrompt = '';
    if (isTool && usePromptEngineering) {
        toolsPrompt = ai.tool.getToolsPrompt(ctx);
    }

    const data = {
        "角色设定": roleSettingTemplate[roleSettingIndex],
        "平台": ctx.endPoint.platform,
        "私聊": ctx.isPrivate,
        "展示号码": showNumber,
        "用户名称": ctx.player.name,
        "用户号码": ctx.player.userId.replace(/^.+:/, ''),
        "群聊名称": ctx.group.groupName,
        "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
        "添加前缀": isPrefix,
        "展示消息ID": showMsgId,
        "接收图片": receiveImage,
        "图片条件不为零": condition !== '0',
        "本地图片不为空": Object.keys(localImages).length !== 0,
        "本地图片名称": Object.keys(localImages).join("、"),
        "保存图片不为空": savedImages.length > 0,
        "保存图片名称": savedImageNames,
        "开启长期记忆": isMemory && memoryPrompt,
        "记忆信息": memoryPrompt,
        "开启短期记忆": isShortMemory && shortMemoryPrompt,
        "短期记忆信息": shortMemoryPrompt,
        "开启工具函数提示词": isTool && usePromptEngineering,
        "函数列表": toolsPrompt
    }

    const template = Handlebars.compile(systemMessageTemplate[0]);
    const content = template(data);

    const systemMessage: Message = {
        role: "system",
        uid: '',
        name: '',
        contentArray: [content],
        msgIdArray: [''],
        images: []
    };

    return systemMessage;
}

function buildSamplesMessages(ctx: seal.MsgContext): Message[] {
    const { samples }: { samples: string[] } = ConfigManager.message;

    const samplesMessages: Message[] = samples
        .map((item, index) => {
            if (item == "") {
                return null;
            } else if (index % 2 === 0) {
                return {
                    role: "user",
                    uid: '',
                    name: "用户",
                    contentArray: [item],
                    msgIdArray: [''],
                    images: []
                };
            } else {
                return {
                    role: "assistant",
                    uid: ctx.endPoint.userId,
                    name: seal.formatTmpl(ctx, "核心:骰子名字"),
                    contentArray: [item],
                    msgIdArray: [''],
                    images: []
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

export function handleMessages(ctx: seal.MsgContext, ai: AI) {
    const { isPrefix, showNumber, showMsgId, isMerge } = ConfigManager.message;

    const systemMessage = buildSystemMessage(ctx, ai);
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
        const prefix = (isPrefix && message.name) ? (
            message.name.startsWith('_') ?
                `<|${message.name}|>` :
                `<|from:${message.name}${showNumber ? `(${message.uid.replace(/^.+:/, '')})` : ``}|>`
        ) : '';

        const content = message.msgIdArray.map((msgId, index) => (showMsgId && msgId ? `<|msg_id:${msgId}|>` : '') + message.contentArray[index]).join('\f');

        if (isMerge && message.role === last_role && message.role !== 'tool') {
            processedMessages[processedMessages.length - 1].content += '\f' + prefix + content;
        } else {
            processedMessages.push({
                role: message.role,
                content: prefix + content,
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