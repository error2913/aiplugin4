import { AI } from "../AI/AI";
import { Message } from "../AI/context";
import { ConfigManager } from "../config/config";

export function buildSystemMessage(ctx: seal.MsgContext, ai: AI): Message {
    const { roleSetting, showQQ }: { roleSetting: string, showQQ: boolean } = ConfigManager.message;
    const { isTool, usePromptEngineering } = ConfigManager.tool;

    let content = roleSetting;

    // 群聊信息
    if (!ctx.isPrivate) {
        content += `
**相关信息**
- 当前群聊:${ctx.group.groupName}
- <|from:xxx${showQQ ? `(yyy)` : ``}|>表示消息来源，xxx为用户名字${showQQ ? `，yyy为纯数字QQ号` : ``}
- <@xxx>表示@某个群成员，xxx为名字${showQQ ? `或者纯数字QQ号` : ``}`;
    }

    content += `- <|图片xxxxxx:yyy|>为图片，其中xxxxxx为6位的图片id，yyy为图片描述（可能没有），如果要发送出现过的图片请使用<|图片xxxxxx|>的格式`;

    // 记忆
    const memeryPrompt = ai.memory.getMemoryPrompt(ctx, ai.context);
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
    const { isPrefix, showQQ, isMerge } = ConfigManager.message;

    const systemMessage = buildSystemMessage(ctx, ai);
    const samplesMessages = buildSamplesMessages(ctx);

    const messages = [systemMessage, ...samplesMessages, ...ai.context.messages];

    // 处理前缀并合并消息（如果有）
    let processedMessages = [];
    let last_role = '';
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const prefix = isPrefix && message.name ?
            (showQQ ?
                `<|from:${message.name}(${message.uid.replace(/\D+/g, '')})|>` :
                `<|from:${message.name}|>`
            ) :
            '';

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