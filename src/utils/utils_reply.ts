import { Context } from "../AI/context";
import { Image, ImageManager } from "../AI/image";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { calculateSimilarity } from "./utils_string";

export async function handleReply(ctx: seal.MsgContext, msg: seal.Message, s: string, context: Context): Promise<{ s: string, reply: string, images: Image[] }> {
    const { maxChar, replymsg, filterContextTemplate, filterReplyTemplate } = ConfigManager.reply;

    // 分离AI臆想出来的多轮对话
    const segments = s
        .split(/(<[\|｜]from:?.*?[\|｜]?>)/)
        .filter(item => item.trim() !== '');
    if (segments.length === 0) {
        return { s: '', reply: '', images: [] };
    }

    s = '';
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const match = segment.match(/<[\|｜]from:?(.*?)[\|｜]?>/);
        if (match) {
            const uid = await context.findUserId(ctx, match[1]);
            if (uid === ctx.endPoint.userId && i < segments.length - 1) {
                s += segments[i + 1]; // 如果臆想对象是自己，那么将下一条消息添加到s中
            }
        } else if (i === 0) {
            s = segment;
        }
    }

    if (!s.trim()) {
        s = segments.find(segment => !/<[\|｜]from:?.*?[\|｜]?>/.test(segment));
        if (!s || !s.trim()) {
            return { s: '', reply: '', images: [] };
        }
    }

    let reply = s; // 回复消息和上下文在此分开处理

    // 处理上下文
    filterContextTemplate.forEach((item: string) => { // 应用过滤上下文正则表达式
        if (!item) {
            return;
        }
        try {
            const regex = new RegExp(item, 'g');
            s = s.replace(regex, '');
        } catch (error) {
            console.error('Error in RegExp:', error);
        }
    })

    s = s.slice(0, maxChar)
        .trim();

    // 处理回复消息
    reply = await replaceMentions(ctx, context, reply);
    const { result, images } = await replaceImages(context, reply);
    reply = result;

    filterReplyTemplate.forEach((item: string) => { // 应用过滤回复正则表达式
        if (!item) {
            return;
        }
        try {
            const regex = new RegExp(item, 'g');
            reply = reply.replace(regex, '');
        } catch (error) {
            console.error('Error in RegExp:', error);
        }
    })

    const prefix = replymsg && msg.rawId ? `[CQ:reply,id=${msg.rawId}]` : ``;

    // 截断回复消息
    const segments2 = reply.split(/(\[CQ:.+?\])/);
    let nonCQLength = 0;
    let finalReply = prefix;
    for (const segment of segments2) {
        if (segment.startsWith("[CQ:") && segment.endsWith("]")) { // 保留完整CQ码
            finalReply += segment;
        } else { // 截断非CQ码部分到剩余可用长度
            const remaining = maxChar - nonCQLength;
            if (remaining > 0) {
                finalReply += segment.slice(0, remaining);
                nonCQLength += Math.min(segment.length, remaining);
            }
        }
    }
    reply = finalReply.trim();

    return { s, reply, images };
}

export function checkRepeat(context: Context, s: string) {
    const { stopRepeat, similarityLimit } = ConfigManager.reply;

    if (!stopRepeat) {
        return false;
    }

    const messages = context.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        // 寻找最后一条文本消息
        if (message.role === 'assistant' && !message?.tool_calls) {
            const content = message.content;
            const similarity = calculateSimilarity(content.trim(), s.trim());
            logger.info(`复读相似度：${similarity}`);

            if (similarity > similarityLimit) {
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

                return true;
            }

            break;
        }
    }
    return false;
}

/**
 * 替换艾特提及为CQ码
 * @param context 
 * @param reply 
 * @returns 
 */
async function replaceMentions(ctx: seal.MsgContext, context: Context, reply: string) {
    const match = reply.match(/<[\|｜]@(.+?)[\|｜]?>/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const name = match[i].replace(/^<[\|｜]@|[\|｜]?>$/g, '');
            const uid = await context.findUserId(ctx, name);
            if (uid !== null) {
                reply = reply.replace(match[i], `[CQ:at,qq=${uid.replace(/\D+/g, "")}]`);
            } else {
                reply = reply.replace(match[i], ` @${name} `);
            }
        }
    }

    return reply;
}

/**
 * 替换图片占位符为CQ码
 * @param context 
 * @param reply 
 * @returns 
 */
async function replaceImages(context: Context, reply: string) {
    let result = reply;
    const images = [];

    const match = reply.match(/<[\|｜]图片.+?[\|｜]?>/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const id = match[i].match(/<[\|｜]图片(.+?)[\|｜]?>/)[1].trim().slice(0, 6);
            const image = context.findImage(id);

            if (image) {
                const file = image.file;
                images.push(image);

                if (!image.isUrl || (image.isUrl && await ImageManager.checkImageUrl(file))) {
                    result = result.replace(match[i], `[CQ:image,file=${file}]`);
                    continue;
                }
            }

            result = result.replace(match[i], ``);
        }
    }

    return { result, images };
}
