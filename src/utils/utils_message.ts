import { AI } from "../AI/AI";
import { Message } from "../AI/context";
import { ConfigManager } from "../config/config";

export function buildSystemMessage(ctx: seal.MsgContext, ai: AI): Message {
    const { roleSetting, showNumber }: { roleSetting: string, showNumber: boolean } = ConfigManager.message;
    const { isTool, usePromptEngineering } = ConfigManager.tool;

    let content = roleSetting;

    // 群聊信息
    if (!ctx.isPrivate) {
        content += `
**相关信息**
- 当前群聊:<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/\D+/g, '')})` : ``}
- <@xxx>表示@某个群成员，xxx为名字${showNumber ? `或者纯数字QQ号` : ``}`;
    } else {
        content += `
**相关信息**
- 当前私聊:<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/\D+/g, '')})` : ``}`;
    }

    content += `- <|from:xxx${showNumber ? `(yyy)` : ``}|>表示消息来源，xxx为用户名字${showNumber ? `，yyy为纯数字QQ号` : ``}
- <|图片xxxxxx:yyy|>为图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用<|图片xxxxxx|>的格式`;

    // 记忆
    const memeryPrompt = ai.memory.buildMemoryPrompt(ctx, ai.context);
    if (memeryPrompt) {
        content += `
**记忆**
如果记忆与上述设定冲突，请遵守角色设定。记忆如下:
${memeryPrompt}`;
    }

    // 调用函数
    if (isTool && usePromptEngineering) {
        const tools = ai.tool.getToolsInfo();
        const toolsPrompt = tools.map((item, index) => {
            return `${index + 1}. 名称:${item.function.name}
- 描述:${item.function.description}
- 参数信息:${JSON.stringify(item.function.parameters.properties, null, 2)}
- 必需参数:${item.function.parameters.required.join('\n')}`;
        });

        content += `
**调用函数**
当需要调用函数功能时，请严格使用以下格式：
\`\`\`
<function_call>
{
    "name": "函数名",
    "arguments": {
        "参数1": "值1",
        "参数2": "值2"
    }
}
</function_call>
\`\`\`
不要附带其他文本，且只能调用一次函数

可用函数列表: ${toolsPrompt}`;
    }

    const systemMessage: Message = {
        role: "system",
        content: content,
        uid: '',
        name: '',
        timestamp: 0,
        images: []
    };

    return systemMessage;
}

export function buildSamplesMessages(ctx: seal.MsgContext) {
    const { samples }: { samples: string[] } = ConfigManager.message;

    const samplesMessages: Message[] = samples
        .map((item, index) => {
            if (item == "") {
                return null;
            } else if (index % 2 === 0) {
                return {
                    role: "user",
                    content: item,
                    uid: '',
                    name: "用户",
                    timestamp: 0,
                    images: []
                };
            } else {
                return {
                    role: "assistant",
                    content: item,
                    uid: ctx.endPoint.userId,
                    name: seal.formatTmpl(ctx, "核心:骰子名字"),
                    timestamp: 0,
                    images: []
                };
            }
        })
        .filter((item) => item !== null);

    return samplesMessages;
}

export function handleMessages(ctx: seal.MsgContext, ai: AI) {
    const { isPrefix, showNumber, isMerge } = ConfigManager.message;

    const systemMessage = buildSystemMessage(ctx, ai);
    const samplesMessages = buildSamplesMessages(ctx);

    const messages = [systemMessage, ...samplesMessages, ...ai.context.messages];

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
        const prefix = isPrefix && message.name ? (
            message.name.startsWith('_') ?
                `<|${message.name}|>` :
                `<|from:${message.name}${showNumber ? `(${message.uid.replace(/\D+/g, '')})` : ``}|>`
        ) : '';

        if (isMerge && message.role === last_role && message.role !== 'tool') {
            processedMessages[processedMessages.length - 1].content += '\n' + prefix + message.content;
        } else {
            processedMessages.push({
                role: message.role,
                content: prefix + message.content,
                tool_calls: message?.tool_calls ? message.tool_calls : undefined,
                tool_call_id: message?.tool_call_id ? message.tool_call_id : undefined
            });
            last_role = message.role;
        }
    }

    return processedMessages;
}