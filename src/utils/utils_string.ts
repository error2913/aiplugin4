import { Context } from "../AI/context";
import { Image, ImageManager } from "../AI/image";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { transformMsgIdBack } from "./utils";

export function parseText(s: string): { type: string, data: { [key: string]: string } }[] {
    const segments = s.split(/(\[CQ:.*?\])/).filter(segment => segment);
    const messageArray: { type: string, data: { [key: string]: string } }[] = [];
    for (const segment of segments) {
        if (segment.startsWith('[CQ:')) {
            const match = segment.match(/^\[CQ:([^,]+),?([^\]]*)\]$/);
            if (match) {
                const params: { [key: string]: string } = {};
                if (match[2]) {
                    match[2].trim().split(',').forEach(param => {
                        const eqIndex = param.indexOf('=');
                        if (eqIndex === -1) {
                            return;
                        }

                        const key = param.slice(0, eqIndex).trim();
                        const value = param.slice(eqIndex + 1).trim();
                        if (key) {
                            params[key] = value;
                        }
                    });
                }

                messageArray.push({
                    type: match[1].trim(),
                    data: params
                });
            } else {
                logger.error(`无法解析CQ码：${segment}`);
            }
        } else {
            messageArray.push({ type: 'text', data: { text: segment } });
        }
    }

    return messageArray;
}

export async function handleReply(ctx: seal.MsgContext, msg: seal.Message, s: string, context: Context): Promise<{ stringArray: string[], replyArray: string[], images: Image[] }> {
    const { maxChar, replymsg, filterRegex } = ConfigManager.reply;

    // 分离AI臆想出来的多轮对话
    const segments = s
        .split(/([<＜]\s?[\|│｜]from[:：]?\s?.*?(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜]))/)
        .filter(item => item.trim());
    if (segments.length === 0) {
        return { stringArray: [], replyArray: [], images: [] };
    }

    s = '';
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const match = segment.match(/[<＜]\s?[\|│｜]from[:：]?\s?(.*?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/);
        if (match) {
            const uid = await context.findUserId(ctx, match[1]);
            if (uid === ctx.endPoint.userId && i < segments.length - 1) {
                s += segments[i + 1]; // 如果臆想对象是自己，那么将下一条消息添加到s中
            }
        } else if (i === 0) {
            s = segment;
        }
    }

    // 如果臆想对象不包含自己，那么就随便把第一条消息添加到s中吧，毁灭吧世界
    if (!s.trim()) {
        s = segments.find(segment => !/[<＜]\s?[\|│｜]from[:：]?\s?.*?(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/.test(segment));
        if (!s || !s.trim()) {
            return { stringArray: [], replyArray: [], images: [] };
        }
    }

    // 分离回复消息和戳一戳消息
    s = s
        .replace(/[<＜]\s?[\|│｜]quote[:：]?\s?(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g, (match) => `\\f${match}`)
        .replace(/[<＜]\s?[\|│｜]poke[:：]?\s?(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g, (match) => `\\f${match}\\f`);

    const stringArray: string[] = [];
    const replyArray: string[] = [];
    const images: Image[] = [];
    let replyLength = 0;

    // 应用过滤正则表达式，并分割消息
    // 过滤正则表达式的捕获组会保留在stringArray中
    try {
        const regex = new RegExp(filterRegex, 'g');
        const segments = s.split(regex).filter(item => item);
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const match = segment.match(regex);
            if (match) {
                if (stringArray.length === 0) {
                    stringArray.push(segment);
                    replyArray.push('');
                } else {
                    stringArray[stringArray.length - 1] += match[0];
                }
            } else {
                const segs = segment.split('\\f').filter(item => item);

                for (let j = 0; j < segs.length; j++) {
                    const seg = segs[j];

                    // 长度超过最大限制，直接截断
                    replyLength += seg.length;
                    if (replyLength > maxChar) {
                        break;
                    }

                    if (stringArray.length === 0 || j !== 0) {
                        stringArray.push(seg);
                        replyArray.push(seg);
                    } else {
                        stringArray[stringArray.length - 1] += segs[0];
                        replyArray[replyArray.length - 1] += segs[0];
                    }
                }
            }
        }
    } catch (error) {
        logger.error(`正则表达式错误，内容:${filterRegex}，错误信息:${error}`);
    }

    // 处理回复消息
    for (let i = 0; i < replyArray.length; i++) {
        let reply = replyArray[i].trim();
        reply = await replaceMentions(ctx, context, reply);
        reply = await replacePoke(ctx, context, reply);
        reply = await replaceQuote(reply);
        const { result, images: replyImages } = await replaceImages(context, reply);
        reply = result;

        const prefix = (replymsg && msg.rawId && !/^\[CQ:reply,id=-?\d+\]/.test(reply)) ? `[CQ:reply,id=${msg.rawId}]` : ``;
        replyArray[i] = prefix + reply;
        images.push(...replyImages);
    }

    return { stringArray, replyArray, images };
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
            const content = message.contentArray[message.contentArray.length - 1] || '';
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
 * 替换艾特为CQ码
 * @param ctx
 * @param context 
 * @param reply 
 * @returns 
 */
async function replaceMentions(ctx: seal.MsgContext, context: Context, reply: string) {
    const match = reply.match(/[<＜]\s?[\|│｜]@(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const name = match[i].replace(/^[<＜]\s?[\|│｜]@|(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])$/g, '');
            const uid = await context.findUserId(ctx, name);
            if (uid !== null) {
                reply = reply.replace(match[i], `[CQ:at,qq=${uid.replace(/\D+/g, "")}]`);
            } else {
                logger.warning(`无法找到用户：${name}`);
                reply = reply.replace(match[i], ` @${name} `);
            }
        }
    }

    return reply;
}

/**
 * 替换戳一戳为CQ码
 * @param ctx
 * @param context 
 * @param reply 
 * @returns 
 */
async function replacePoke(ctx: seal.MsgContext, context: Context, reply: string) {
    const match = reply.match(/[<＜]\s?[\|│｜]poke[:：]?\s?(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const name = match[i].replace(/^[<＜]\s?[\|│｜]poke[:：]?\s?|(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])$/g, '');
            const uid = await context.findUserId(ctx, name);
            if (uid !== null) {
                reply = reply.replace(match[i], `[CQ:poke,qq=${uid.replace(/\D+/g, "")}]`);
            } else {
                logger.warning(`无法找到用户：${name}`);
                reply = reply.replace(match[i], '');
            }
        }
    }

    return reply;
}

/**
 * 替换引用为CQ码
 * @param reply 
 * @returns 
 */
async function replaceQuote(reply: string) {
    const match = reply.match(/[<＜]\s?[\|│｜]quote[:：]?\s?(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const msgId = match[i].replace(/^[<＜]\s?[\|│｜]quote[:：]?\s?|(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])$/g, '');
            reply = reply.replace(match[i], `[CQ:reply,id=${transformMsgIdBack(msgId)}]`);
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

    const match = reply.match(/[<＜]\s?[\|│｜]img:.+?(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const id = match[i].match(/[<＜]\s?[\|│｜]img:(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/)[1].trim().slice(0, 6);
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
    if (!s1 || !s2 || s1 === s2) {
        return 0;
    }

    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - distance / maxLength || 0;
}