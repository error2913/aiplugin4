import { Context, Message } from "../AI/context";
import { ImageManager } from "../AI/image";
import { ToolInfo } from "../tools/tool";
import { ConfigManager } from "../config/config";
import { AI } from "../AI/AI";

export function log(...data: any[]) {
    const { isLog } = ConfigManager.log;

    if (isLog) {
        console.log(...data);
    }
}

export function getCQTypes(s: string): string[] {
    const match = s.match(/\[CQ:([^,]*?),.*?\]/g);
    if (match) {
        return match.map(item => item.match(/\[CQ:([^,]*?),/)[1]);
    } else {
        return [];
    }
}

export function getMsg(messageType: "group" | "private", senderId: string, groupId: string = ''): seal.Message {
    let msg = seal.newMessage();

    if (messageType == 'group') {
        msg.groupId = groupId;
        msg.guildId = '';
    }

    msg.messageType = messageType;
    msg.sender.userId = senderId;
    return msg;
}

export function getCtx(epId: string, msg: seal.Message): seal.MsgContext | undefined {
    const eps = seal.getEndPoints();

    for (let i = 0; i < eps.length; i++) {
        if (eps[i].userId === epId) {
            return seal.createTempCtx(eps[i], msg);
        }
    }

    return undefined;
}

export function getNameById(epId: string, gid: string, uid: string, diceName: string) {
    if (epId === uid) {
        return diceName;
    }

    const msg = getMsg(gid === '' ? 'private' : 'group', uid, gid);
    const ctx = getCtx(epId, msg);

    return ctx.player.name || '未知用户';
}

export function parseBody(template: string[], messages: any[], tools: ToolInfo[], tool_choice: string) {
    try {
        const bodyObject = JSON.parse(`{${template.join(',')}}`);

        if (bodyObject.messages === null) {
            bodyObject.messages = messages;
        }

        if (bodyObject.stream !== false) {
            console.error(`不支持流式传输，请将stream设置为false`);
            bodyObject.stream = false;
        }

        if (bodyObject.tools === null) {
            bodyObject.tools = tools;
        }

        if (bodyObject.tool_choice === null) {
            bodyObject.tool_choice = tool_choice;
        }

        return bodyObject;
    } catch (err) {
        throw new Error(`解析body时出现错误:${err}`);
    }
}

export function handleMessages(ctx: seal.MsgContext, ai: AI) {
    const { roleSetting, samples, isPrefix, isMerge } = ConfigManager.message;

    let content = roleSetting;

    // 群聊信息
    if (!ctx.isPrivate) {
        content += `
**相关信息**
- 当前群聊:${ctx.group.groupName}
- <@xxx>表示@群成员xxx`;
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

    const systemMessage: Message = {
        role: "system",
        content: content,
        uid: '',
        name: '',
        timestamp: 0,
        images: []
    };

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

    const messages = [systemMessage, ...samplesMessages, ...ai.context.messages];

    // 处理前缀并合并消息（如果有）
    let processedMessages = [];
    let last_role = '';
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const prefix = isPrefix && message.name ? `<|from:${message.name}|>` : '';

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

export function levenshteinDistance(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    const dp = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) {
        dp[i][0] = i;
    }
    for (let j = 0; j <= len2; j++) {
        dp[0][j] = j;
    }
    for (let i = 1; i <= len1; i++) {
        for (let j = 1; j <= len2; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1, // 删除
                    dp[i][j - 1] + 1, // 插入
                    dp[i - 1][j - 1] + 1 // 替换
                );
            }
        }
    }
    return dp[len1][len2];
}

export function calculateSimilarity(s1: string, s2: string): number {
    if (s1.length === 0 || s2.length === 0) {
        return 0;
    }

    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - distance / maxLength;
}

export async function handleReply(ctx: seal.MsgContext, msg: seal.Message, s: string, context: Context): Promise<{ s: string, isRepeat: boolean, reply: string }> {
    const { maxChar, replymsg, stopRepeat, similarityLimit, filterContextTemplate, filterReplyTemplate } = ConfigManager.reply;

    // 分离AI臆想出来的多轮对话
    const segments = s
        .split(/<[\|｜]from.*?[\|｜]?>/)
        .filter(item => item.trim() !== '');
    if (segments.length === 0) {
        return { s: '', reply: '', isRepeat: false };
    }

    s = segments[0]
        .replace(/<br>/g, '\n') // 我又不是浏览器，为什么要帮你替换这个
        .slice(0, maxChar)
        .trim();

    let reply = s; // 回复消息和上下文在此分开处理

    // 应用过滤上下文正则表达式
    filterContextTemplate.forEach(item => {
        try {
            const regex = new RegExp(item, 'g');
            s = s.replace(regex, '');
        } catch (error) {
            console.error('Error in RegExp:', error);
        }
    })

    // 检查复读
    let isRepeat = false;
    if (stopRepeat) {
        const messages = context.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            // 寻找最后一条文本消息
            if (message.role === 'assistant' && !message?.tool_calls) {
                const content = message.content;
                const similarity = calculateSimilarity(content.trim(), s.trim());
                log(`复读相似度：${similarity}`);

                if (similarity > similarityLimit) {
                    isRepeat = true;

                    // 找到最近的一块assistant消息全部删除，防止触发tool相关的bug
                    let start = i;
                    let count = 1;
                    for (let j = i - 1; j >= 0; j--) {
                        const message = messages[j];
                        if (message.role === 'tool' || (message.role === 'assistant' && message?.tool_calls)) {
                            start = j;
                            count++;
                        } else {
                            break;
                        }
                    }

                    messages.splice(start, count);
                }

                break;
            }
        }
    }

    // 检查艾特，并替换为CQ码
    reply = reply.replace(/<@(.+?)>/g, (_, p1) => {
        const uid = context.findUid(p1);
        if (uid !== null) {
            return `[CQ:at,qq=${uid.replace(/\D+/g, "")}] `;
        } else {
            return ` @${p1} `;
        }
    })

    // 检查是否有图片，并替换为CQ码，因为replace不支持异步函数，所以用for循环
    const match = s.match(/<[\|｜]图片.+?[\|｜]?>/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const id = match[i].match(/<[\|｜]图片(.+?)[\|｜]?>/)[1];
            const image = context.findImage(id);

            if (image) {
                const file = image.file;

                if (!image.isUrl || (image.isUrl && await ImageManager.checkImageUrl(file))) {
                    reply = s.replace(match[i], `[CQ:image,file=${file}]`);
                    continue;
                }
            }

            reply = s.replace(match[i], ``);
        }
    }

    // 应用过滤回复正则表达式
    filterReplyTemplate.forEach(item => {
        try {
            const regex = new RegExp(item, 'g');
            reply = reply.replace(regex, '');
        } catch (error) {
            console.error('Error in RegExp:', error);
        }
    })

    const prefix = replymsg ? `[CQ:reply,id=${msg.rawId}][CQ:at,qq=${ctx.player.userId.replace(/\D+/g, "")}] ` : ``;
    reply = prefix + reply.trim();

    return { s, isRepeat, reply };
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}