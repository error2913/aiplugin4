import { AI } from "../AI/AI";
import { Message } from "../AI/context";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { ToolInfo } from "../tool/tool";

export function buildSystemMessage(ctx: seal.MsgContext, ai: AI): Message {
    const { roleSettingTemplate, isPrefix, showNumber, showMsgId } = ConfigManager.message;
    const { isTool, usePromptEngineering, isMemory } = ConfigManager.tool;
    const { localImagePaths, receiveImage, condition } = ConfigManager.image;
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

    let [roleSettingIndex, _] = seal.vars.intGet(ctx, "$g人工智能插件专用角色设定序号");
    if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
        roleSettingIndex = 0;
    }

    let content = roleSettingTemplate[roleSettingIndex];

    content += `\n\n**聊天相关信息**`;
    content += `\n- 当前平台:${ctx.endPoint.platform}`;
    content += ctx.isPrivate ?
        `\n- 当前私聊:<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/^.+:/, '')})` : ``}` :
        `\n- 当前群聊:<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/^.+:/, '')})` : ``}\n- <|@xxx|>表示@某个群成员\n- <|poke:xxx|>表示戳一戳某个群成员`;
    content += isPrefix ? `\n- <|from:xxx|>表示消息来源，不要在生成的回复中使用` : ``;
    content += showMsgId ? `\n- <|msg_id:xxx|>表示消息ID，仅用于调用函数时使用，不要在生成的回复中提及或使用\n- <|quote:xxx|>表示引用消息，xxx为对应的消息ID` : ``;
    content += `\n- \\f用于分割多条消息`

    if (receiveImage) {
        content += condition === '0' ?
            `\n- <|img:xxxxxx|>为图片，其中xxxxxx为6位的图片id，如果要发送出现过的图片请使用<|img:xxxxxx|>的格式` :
            `\n- <|img:xxxxxx:yyy|>为图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用<|img:xxxxxx|>的格式`;
    }

    if (Object.keys(localImages).length !== 0) {
        content += `\n- 可使用<|img:图片名称|>发送表情包，表情名称有:${Object.keys(localImages).join("、")}`;
    }

    // 记忆
    if (isMemory) {
        const memeryPrompt = ai.memory.buildMemoryPrompt(ctx, ai.context);
        content += memeryPrompt ?
            `\n\n**记忆**
如果记忆与上述设定冲突，请遵守角色设定。记忆如下:
${memeryPrompt}` :
            ``;
    }

    // 调用函数
    if (isTool && usePromptEngineering) {
        const tools = ai.tool.getToolsInfo(ctx.isPrivate ? 'private' : 'group');
        if (tools && tools.length > 0) {
            const toolsPrompt = tools.map((item, index) => {
                return `${index + 1}. 名称:${item.function.name}
    - 描述:${item.function.description}
    - 参数信息:${JSON.stringify(item.function.parameters.properties, null, 2)}
    - 必需参数:${item.function.parameters.required.join('\n')}`;
            }).join('\n');

            content += `\n**调用函数**
当需要调用函数功能时，请严格使用以下格式：

<function_call>
{
    "name": "函数名",
    "arguments": {
        "参数1": "值1",
        "参数2": "值2"
    }
}
</function_call>

要用成对的标签包裹，标签外不要附带其他文本，且每次只能调用一次函数

可用函数列表:
${toolsPrompt}`;
        }
    }

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
                tool_calls: message?.tool_calls ? message.tool_calls : undefined,
                tool_call_id: message?.tool_call_id ? message.tool_call_id : undefined
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