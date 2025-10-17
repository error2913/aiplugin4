import Handlebars from "handlebars";
import { Context } from "../AI/context";
import { Image, ImageManager } from "../AI/image";
import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { transformMsgIdBack } from "./utils";
import { AI } from "../AI/AI";

/* 先丢这一坨东西在这。之所以不用是因为被类型检查整烦了

export interface MessageItemText {
    type: 'text';
    data: {
        text: string;
    };
}

export interface MessageItemAt {
    type: 'at';
    data: {
        qq: string;
    };
}

export interface MessageItemImage {
    type: 'image';
    data: {
        file: string;
        url?: string;
    };
}

export interface MessageItemFace {
    type: 'face';
    data: {
        id: string;
    };
}

export interface MessageItemJson {
    type: 'json';
    data: {
        data: string;
    };
}

export interface MessageItemRecord {
    type: 'record';
    data: {
        file: string;
    };
}

export interface MessageItemVideo {
    type: 'video';
    data: {
        file: string;
    };
}

export interface MessageItemReply {
    type: 'reply';
    data: {
        id: string;
    };
}

export interface MessageItemMusic {
    type: 'music';
    data: {
        type: 'qq' | '163';
        id: string;
    } | {
        type: 'custom';
        url: string;
        audio: string;
        title: string;
        image: string;
    };
}

export interface MessageItemDice {
    type: 'dice';
}

export interface MessageItemRps {
    type: 'rps';
}

export interface MessageItemFile {
    type: 'file';
    data: {
        file: string;
    };
}

export interface MessageItemNode { // 这是干嘛的？是合并转发吗？
    type: 'node';
    data: {
        user_id: string;
        nickname: string;
        content: (MessageItemText | MessageItemAt | MessageItemImage | MessageItemFace | MessageItemJson | MessageItemRecord | MessageItemVideo | MessageItemReply | MessageItemMusic | MessageItemDice | MessageItemRps | MessageItemFile)[];
    };
}

export type MessageItem = MessageItemText | MessageItemAt | MessageItemImage | MessageItemFace | MessageItemJson | MessageItemRecord | MessageItemVideo | MessageItemReply | MessageItemMusic | MessageItemDice | MessageItemRps | MessageItemFile | MessageItemNode;
*/

export interface MessageItem {
    type: string;
    data: { 
        [key: string]: string
    };
}

export function transformTextToArray(s: string): MessageItem[] {
    const segments = s.split(/(\[CQ:.*?\])/).filter(segment => segment);
    const messageArray: MessageItem[] = [];
    for (const segment of segments) {
        if (segment.startsWith('[CQ:')) {
            const match = segment.match(/^\[CQ:([^,]+),?([^\]]*)\]$/);
            if (match) {
                const type = match[1].trim();
                const params: { [key: string]: string } = {};
                if (match[2]) {
                    match[2].trim().split(',').forEach(param => {
                        const eqIndex = param.indexOf('=');
                        if (eqIndex === -1) {
                            return;
                        }

                        const key = param.slice(0, eqIndex).trim();
                        const value = param.slice(eqIndex + 1).trim();

                        // 这对吗？nc是这样的吗？
                        if (type === 'image' && key === 'file') {
                            params['url'] = value;
                        }

                        if (key) {
                            params[key] = value;
                        }
                    });
                }

                messageArray.push({
                    type: type,
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

export function transformArrayToText(messageArray: { type: string, data: { [key: string]: string } }[]): string {
    let s = '';
    for (const message of messageArray) {
        if (message.type === 'text') {
            s += message.data['text'];
        } else {
            if (message.type === 'image') {
                if (message.data['url']) {
                    s += `[CQ:image,file=${message.data['url']}]`;
                } else if (message.data['file']) {
                    s += `[CQ:image,file=${message.data['file']}]`;
                }
            } else {
                s += `[CQ:${message.type}`;
                for (const key in message.data) {
                    if (typeof message.data[key] === 'string') {
                        s += `,${key}=${message.data[key]}`;
                    }
                }
                s += ']';
            }
        }
    }
    return s;
}

export async function handleReply(ctx: seal.MsgContext, msg: seal.Message, ai: AI, s: string): Promise<{ contextArray: string[], replyArray: string[], images: Image[] }> {
    const { replymsg, isTrim } = ConfigManager.reply;

    // 分离AI臆想出来的多轮对话
    const segments = s
        .split(/([<＜][\|│｜]from.+?(?:[\|│｜][>＞]|[\|│｜>＞]))/)
        .filter(item => item.trim());
    if (segments.length === 0) {
        return { contextArray: [], replyArray: [], images: [] };
    }

    s = '';
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const match = segment.match(/[<＜][\|│｜]from[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/);
        if (match) {
            const uid = await ai.context.findUserId(ctx, match[1]);
            if (uid === ctx.endPoint.userId && i < segments.length - 1) {
                s += segments[i + 1]; // 如果臆想对象是自己，那么将下一条消息添加到s中
            }
        } else if (i === 0) {
            s = segment;
        }
    }

    // 如果臆想对象不包含自己，那么就随便把第一条消息添加到s中吧，毁灭吧世界
    if (!s.trim()) {
        s = segments.find(segment => !/[<＜][\|│｜]from.+?(?:[\|│｜][>＞]|[\|│｜>＞])/.test(segment));
        if (!s || !s.trim()) {
            return { contextArray: [], replyArray: [], images: [] };
        }
    }

    // 分离回复消息和戳一戳消息
    s = s
        .replace(/[<＜][\|│｜]quote[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g, (match) => `\\f${match}`)
        .replace(/[<＜][\|│｜]poke[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g, (match) => `\\f${match}\\f`);

    const { contextArray, replyArray } = filterString(s);
    const images: Image[] = [];

    // 处理回复消息
    for (let i = 0; i < replyArray.length; i++) {
        let reply = replyArray[i];
        reply = await replaceMentions(ctx, ai.context, reply);
        reply = await replacePoke(ctx, ai.context, reply);
        reply = await replaceQuote(reply);
        const { result, images: replyImages } = await replaceImages(ai.context, ai.imageManager, reply);
        reply = isTrim ? result.trim() : result;

        const prefix = (replymsg && msg.rawId && !/^\[CQ:reply,id=-?\d+\]/.test(reply)) ? `[CQ:reply,id=${msg.rawId}]` : ``;
        replyArray[i] = prefix + reply;
        images.push(...replyImages);
    }

    return { contextArray, replyArray, images };
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
            const content = message.msgArray[message.msgArray.length - 1].content || '';
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

function filterString(s: string): { contextArray: string[], replyArray: string[] } {
    const { maxChar, filterRegexes, contextTemplate, replyTemplate } = ConfigManager.reply;

    const contextArray: string[] = [];
    const replyArray: string[] = [];
    let replyLength = 0; //只计算未被匹配的部分

    const filterRegex = filterRegexes.join('|');
    let pattern: RegExp;
    try {
        pattern = new RegExp(filterRegex, 'g');
    } catch (e) {
        logger.error(`正则表达式错误，内容:${filterRegex}，错误信息:${e.message}`);
    }

    const filters = filterRegexes.map((regex, index) => {
        let pattern: RegExp;
        try {
            pattern = new RegExp(regex);
        } catch (e) {
            logger.error(`正则表达式错误，内容:${regex}，错误信息:${e.message}`);
        }
        return {
            pattern,
            contextTemplate: Handlebars.compile(contextTemplate[index] || ''),
            replyTemplate: Handlebars.compile(replyTemplate[index] || '')
        }
    })

    // 应用过滤正则表达式，并按照\f分割消息
    const segments = advancedSplit(s, pattern).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        let isMatched = false;
        for (let j = 0; j < filterRegexes.length; j++) {
            const filter = filters[j];
            const match = segment.match(filter.pattern);
            if (match) {
                isMatched = true;
                const data = {
                    "match": match
                }

                const contextString = filter.contextTemplate(data);
                const replyString = filter.replyTemplate(data);

                if (contextArray.length === 0) {
                    contextArray.push(contextString);
                    replyArray.push(replyString);
                } else {
                    contextArray[contextArray.length - 1] += contextString;
                    replyArray[replyArray.length - 1] += replyString;
                }

                break;
            }
        }

        if (!isMatched) {
            const segs = segment.split(/\\f|\f/g).filter(item => item);

            if (segment.startsWith('\\f') || segment.startsWith('\f')) {
                contextArray.push('');
                replyArray.push('');
            }

            for (let j = 0; j < segs.length; j++) {
                let seg = segs[j];

                // 长度超过最大限制，直接截断
                if (replyLength + seg.length > maxChar) {
                    seg = seg.slice(0, maxChar - replyLength);
                }

                if (contextArray.length === 0 || j !== 0) {
                    contextArray.push(seg);
                    replyArray.push(seg);
                } else {
                    contextArray[contextArray.length - 1] += seg;
                    replyArray[replyArray.length - 1] += seg;
                }

                // 长度超过最大限制，直接退出
                replyLength += seg.length;
                if (replyLength > maxChar) {
                    break;
                }
            }

            if (segment.endsWith('\\f') || segment.endsWith('\f')) {
                contextArray.push('');
                replyArray.push('');
            }
        }

        // 长度超过最大限制，直接退出
        if (replyLength > maxChar) {
            break;
        }
    }

    return { contextArray, replyArray };
}

/**
 * 替换艾特为CQ码
 * @param ctx
 * @param context 
 * @param reply 
 * @returns 
 */
async function replaceMentions(ctx: seal.MsgContext, context: Context, reply: string) {
    const match = reply.match(/[<＜][\|│｜]at[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const name = match[i].replace(/^[<＜][\|│｜]at[:：]?\s?|(?:[\|│｜][>＞]|[\|│｜>＞])$/g, '');
            const uid = await context.findUserId(ctx, name);
            if (uid !== null) {
                reply = reply.replace(match[i], `[CQ:at,qq=${uid.replace(/^.+:/, "")}]`);
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
    const match = reply.match(/[<＜][\|│｜]poke[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const name = match[i].replace(/^[<＜][\|│｜]poke[:：]?\s?|(?:[\|│｜][>＞]|[\|│｜>＞])$/g, '');
            const uid = await context.findUserId(ctx, name);
            if (uid !== null) {
                reply = reply.replace(match[i], `[CQ:poke,qq=${uid.replace(/^.+:/, "")}]`);
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
    const match = reply.match(/[<＜][\|│｜]quote[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const msgId = match[i].replace(/^[<＜][\|│｜]quote[:：]?\s?|(?:[\|│｜][>＞]|[\|│｜>＞])$/g, '');
            reply = reply.replace(match[i], `[CQ:reply,id=${transformMsgIdBack(msgId)}]`);
        }
    }

    return reply;
}

/**
 * 替换图片占位符为CQ码
 * @param context 
 * @param im 图片管理器
 * @param reply 
 * @returns 
 */
async function replaceImages(context: Context, im: ImageManager, reply: string) {
    let result = reply;
    const images = [];

    const match = reply.match(/[<＜][\|│｜]img:.+?(?:[\|│｜][>＞]|[\|│｜>＞])/g);
    if (match) {
        for (let i = 0; i < match.length; i++) {
            const id = match[i].match(/[<＜][\|│｜]img:(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/)[1];
            const image = context.findImage(id, im);

            if (image) {
                images.push(image);

                if (!image.isUrl || (image.isUrl && await ImageManager.checkImageUrl(image.file))) {
                    if (image.base64) {
                        image.weight += 1;
                    }
                    result = result.replace(match[i], `[CQ:image,file=${image.file}]`);
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

function advancedSplit(s: string, r: RegExp) {
    const parts = [];
    let lastIndex = 0;
    let match: RegExpExecArray;

    // 确保是全局正则
    if (!r.global) {
        r = new RegExp(r.source, r.flags + "g");
    }

    while ((match = r.exec(s)) !== null) {
        // 添加匹配前的部分
        if (match.index > lastIndex) {
            parts.push(s.slice(lastIndex, match.index));
        }

        // 添加匹配部分
        parts.push(match[0]);
        lastIndex = match.index + match[0].length;

        // 处理零长度匹配（避免死循环）
        if (match[0].length === 0) {
            if (r.lastIndex < s.length) {
                r.lastIndex++;
            } else {
                break;
            }
        }
    }

    // 添加剩余部分
    if (lastIndex < s.length) {
        parts.push(s.slice(lastIndex));
    }

    return parts;
}

export function fmtDate(timestamp: number) {
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}