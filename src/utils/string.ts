// 字符串工具：消息段转换/回复拆分过滤/复读检测等
import Config from "../config/config";
import { FACE_MAP } from "../config/static_config";
import { Context } from "../context/context";
import { logger } from "../logger";
import Image from "../resource/image";

import { getCtxAndMsg } from "./seal";
import { resolveLocalPath, transformMsgId, transformMsgIdBack } from "./utils";


/* 先丢这一坨东西在这。之所以不用是因为被类型检查整烦了

export interface MessageSegmentText {
    type: 'text';
    data: {
        text: string;
    };
}

export interface MessageSegmentAt {
    type: 'at';
    data: {
        qq: string;
    };
}

export interface MessageSegmentImage {
    type: 'image';
    data: {
        file: string;
        url?: string;
    };
}

export interface MessageSegmentFace {
    type: 'face';
    data: {
        id: string;
    };
}

export interface MessageSegmentJson {
    type: 'json';
    data: {
        data: string;
    };
}

export interface MessageSegmentRecord {
    type: 'record';
    data: {
        file: string;
    };
}

export interface MessageSegmentVideo {
    type: 'video';
    data: {
        file: string;
    };
}

export interface MessageSegmentReply {
    type: 'reply';
    data: {
        id: string;
    };
}

export interface MessageSegmentMusic {
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

export interface MessageSegmentDice {
    type: 'dice';
}

export interface MessageSegmentRps {
    type: 'rps';
}

export interface MessageSegmentFile {
    type: 'file';
    data: {
        file: string;
    };
}

export interface MessageSegmentNode { // 这是干嘛的？是合并转发吗？
    type: 'node';
    data: {
        user_id: string;
        nickname: string;
        content: (MessageSegmentText | MessageSegmentAt | MessageSegmentImage | MessageSegmentFace | MessageSegmentJson | MessageSegmentRecord | MessageSegmentVideo | MessageSegmentReply | MessageSegmentMusic | MessageSegmentDice | MessageSegmentRps | MessageSegmentFile)[];
    };
}

export type MessageSegment = MessageSegmentText | MessageSegmentAt | MessageSegmentImage | MessageSegmentFace | MessageSegmentJson | MessageSegmentRecord | MessageSegmentVideo | MessageSegmentReply | MessageSegmentMusic | MessageSegmentDice | MessageSegmentRps | MessageSegmentFile | MessageSegmentNode;
*/

export interface MessageSegment {
    type: string;
    data: {
        [key: string]: string
    };
}

/** 解析 QQ 卡片消息（CQ:json / OB11 json 段的 data 字段），提取标题/描述/链接等可读文本 */
export function parseCardToText(raw: any): string {
    if (!raw) return '[卡片消息]';

    let obj: any = null;
    try {
        obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_e) {
        return `[卡片消息] ${String(raw).slice(0, 200)}`;
    }

    const str = (v: any): string => (typeof v === 'string' && v.trim()) ? v.trim() : '';

    // 常见卡片结构：view / meta.news / meta.detail 等
    const view = (obj && (obj.view || (obj.meta && (obj.meta.news || obj.meta.detail || obj.meta.article)))) || obj || {};
    const title = str(view.title) || str(obj.desc) || str(view.desc) || '';
    const desc = str(view.desc) || str(view.summary) || (view.news && str(view.news.desc)) || '';
    const url = str(view.url) || str(view.jumpUrl) || (view.news && str(view.news.jumpUrl)) || (view.detail && str(view.detail.jumpUrl)) || '';

    const parts = [title, desc].filter(Boolean);
    if (parts.length === 0) return '[卡片消息]';
    return `【卡片】${parts.join('\n')}${url ? `\n${url}` : ''}`;
}

/** 音乐段转可读文本（data 为 qq/163 id 或 custom 对象） */
export function parseMusicToText(data: any): string {
    if (data && data.title) return `【音乐】${data.title}`;
    const type = data && data.type ? String(data.type) : '';
    const id = data && data.id ? String(data.id) : '';
    return `【音乐】${type}${id ? ` ${id}` : ''}`;
}

export function transformTextToArray(text: string): MessageSegment[] {
    const segments = text.split(/(\[CQ:.*?\])/).filter(segment => segment);
    const messageArray: MessageSegment[] = [];
    for (const segment of segments) {
        if (segment.startsWith('[CQ:')) {
            const match = segment.match(/^\[CQ:([^,]+),?([^\]]*)\]$/);
            if (match) {
                const type = match[1].trim();
                const params: { [key: string]: string } = {};
                if (match[2]) {
                    match[2].trim().split(',').forEach(param => {
                        const eqIndex = param.indexOf('=');
                        if (eqIndex === -1) return;

                        const key = param.slice(0, eqIndex).trim();
                        const value = param.slice(eqIndex + 1).trim();

                        if (type === 'image' && key === 'file') params['url'] = value; // 这对吗？nc是这样的吗？
                        if (key) params[key] = value;
                    });
                }

                messageArray.push({ type, data: params });
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
    let text = '';
    for (const message of messageArray) {
        if (message.type === 'text') {
            text += message.data['text'];
        } else {
            if (message.type === 'image') {
                if (message.data['url']) {
                    text += `[CQ:image,file=${message.data['url']}]`;
                } else if (message.data['file']) {
                    text += `[CQ:image,file=${message.data['file']}]`;
                }
            } else {
                text += `[CQ:${message.type}`;
                for (const key in message.data) {
                    if (typeof message.data[key] === 'string') {
                        text += `,${key}=${message.data[key]}`;
                    }
                }
                text += ']';
            }
        }
    }
    return text;
}

export async function transformArrayToContent(ctx: seal.MsgContext, messageArray: MessageSegment[]): Promise<{ content: string, images: Image[] }> {
    let content = '';
    const images: Image[] = [];
    for (const seg of messageArray) {
        switch (seg.type) {
            case 'text': {
                content += seg.data.text;
                break;
            }
            case 'at': {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group!.groupId;
                const uid = `QQ:${seg.data.qq || ''}`;
                ({ ctx } = getCtxAndMsg(epId, uid, gid));
                const name = ctx.player!.name || '未知用户';
                content += `<|at:${name}|>`;
                break;
            }
            case 'poke': {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group!.groupId;
                const uid = `QQ:${seg.data.qq || ''}`;
                ({ ctx } = getCtxAndMsg(epId, uid, gid));
                const name = ctx.player!.name || '未知用户';
                content += `<|poke:${name}|>`;
                break;
            }
            case 'reply': {
                content += `<|quote:${transformMsgId(seg.data.id || '')}|>`;
                break;
            }
            case 'image': {
                const result = await Image.handleImageMessageSegment(ctx, seg);
                content += result.content;
                images.push(...result.images);
                break;
            }
            case 'face': {
                const faceName = FACE_MAP[seg.data.id] || '';
                content += faceName ? `<|face:${faceName}|>` : '';
                break;
            }
        }
    }
    return { content, images };
}

/**
 * 转换文本内容中的特殊标签为CQ码
 * @param ctx 消息上下文
 * @param ai AI实例
 * @param content 文本内容
 * @returns 包含处理后的结果和图片列表的对象
 */
async function transformContentToText(ctx: seal.MsgContext, session: { context: Context }, content: string): Promise<{ text: string, images: Image[] }> {
    const segs = parseSpecialTokens(content);
    let text = '';
    const images: Image[] = [];
    for (const seg of segs) {
        switch (seg.type) {
            case 'text': {
                text += seg.content;
                break;
            }
            case 'at': {
                const name = seg.content;
                const ui = await session.context.findUser(ctx, name);
                if (ui !== null) {
                    text += `[CQ:at,qq=${ui.userId.replace(/^.+:/, "")}]`;
                } else {
                    logger.warning(`无法找到用户：${name}`);
                    text += ` @${name} `;
                }
                break;
            }
            case 'poke': {
                const name = seg.content;
                const ui = await session.context.findUser(ctx, name);
                if (ui !== null) {
                    text += `[CQ:poke,qq=${ui.userId.replace(/^.+:/, "")}]`;
                } else {
                    logger.warning(`无法找到用户：${name}`);
                }
                break;
            }
            case 'quote': {
                const msgId = seg.content;
                text += `[CQ:reply,id=${transformMsgIdBack(msgId)}]`;
                break;
            }
            case 'img': {
                const id = seg.content;
                const image = await session.context.findImage(ctx, id);

                if (image) {
                    images.push(image);
                    text += image.CQCode;
                } else {
                    logger.warning(`无法找到图片：${id}`);
                }
                break;
            }
            case 'audio': {
                const id = seg.content;
                const audios: { audioId: string, path: string }[] = Config.resource.LOCAL_AUDIOS || [];
                const audio = audios.find(a => a.audioId === id);

                if (audio) {
                    text += `[语音:${resolveLocalPath(audio.path)}]`;
                } else {
                    logger.warning(`无法找到本地语音：${id}`);
                }
                break;
            }
            case 'face': {
                const faceId = Object.keys(FACE_MAP).find(key => FACE_MAP[key] === seg.content) || '';
                text += faceId ? `[CQ:face,id=${faceId}]` : '';
                break;
            }
        }
    }
    return { text, images };
}

export async function handleReply(ctx: seal.MsgContext, msg: seal.Message, session: { context: Context }, s: string): Promise<{ contextArray: string[], replyArray: string[], images: Image[] }> {
    const { QUOTE_REPLY: replymsg, TRIM: isTrim } = Config.reply;

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
            // 如果臆想对象是自己，那么将下一条消息添加到s中
            const ui = await session.context.findUser(ctx, match[1]);
            if (ui && ui.userId === ctx.endPoint.userId && i < segments.length - 1) s += segments[i + 1];
        } else if (i === 0) {
            s = segment;
        }
    }

    // 如果臆想对象不包含自己，那么就随便把第一条消息添加到s中吧，毁灭吧世界
    if (!s.trim()) {
        s = segments.find((segment: string) => !/[<＜][\|│｜]from.+?(?:[\|│｜][>＞]|[\|│｜>＞])/.test(segment)) || '';
        if (!s || !s.trim()) return { contextArray: [], replyArray: [], images: [] };
    }

    // 分离回复消息和戳一戳消息
    s = s.replace(/[<＜][\|│｜]quote[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g, (match) => `\\f${match}`)
        .replace(/[<＜][\|│｜]poke[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/g, (match) => `\\f${match}\\f`);

    const { contextArray, replyArray } = filterString(s);
    const images: Image[] = [];

    // 处理回复消息
    for (let i = 0; i < replyArray.length; i++) {
        const result = await transformContentToText(ctx, session, replyArray[i]);
        const reply = isTrim ? result.text.trim() : result.text;

        // 含戳戳时引用前缀会导致消息无法显示，故跳过引用
        const prefix = (replymsg && msg.rawId && !/\[CQ:poke,/i.test(reply) && !/^\[CQ:reply,id=-?\d+\]/.test(reply)) ? `[CQ:reply,id=${msg.rawId}]` : ``;
        replyArray[i] = prefix + reply;
        images.push(...result.images);
    }

    return { contextArray, replyArray, images };
}

export function checkRepeat(context: Context, s: string) {
    const { STOP_REPEAT: stopRepeat, REPEAT_SIMILARITY: similarityLimit } = Config.reply;

    if (!stopRepeat) {
        return false;
    }

    const messages = context.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        // 寻找最后一条文本消息
        if (message.role === 'assistant' && !((message as any).toolCalls || (message as any).tool_calls)) {
            const items = ((message as any).contentItems || (message as any).msgArray) || [];
            const last = items[items.length - 1];
            const content = last ? (last.text || '') : '';
            const similarity = calculateSimilarity(content.trim(), s.trim());
            logger.info(`复读相似度：${similarity}`);

            if (similarity > similarityLimit) {
                // 找到最近的一块assistant消息全部删除，防止触发tool相关的bug
                let start = i;
                let count = 1;
                for (let j = i - 1; j >= 0; j--) {
                    const message = messages[j];
                    if (message.role === 'tool' || (message.role === 'assistant' && ((message as any).toolCalls || (message as any).tool_calls))) {
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
    const { MAX_CHARS: maxChar, FILTER_REGEX: filterRegex, FILTER_REGEXES: filterRegexes, CONTEXT_TEMPLATES: contextTemplates, REPLY_TEMPLATES: replyTemplates } = Config.reply;

    const contextArray: string[] = [];
    const replyArray: string[] = [];
    let replyLength = 0; //只计算未被匹配的部分

    if (filterRegexes.length !== contextTemplates.length || filterRegexes.length !== replyTemplates.length) {
        logger.error(`回复消息过滤正则表达式、正则处理上下文消息模板、正则处理回复消息模板数量不一致`);
        return { contextArray: [], replyArray: [] };
    }

    const filters = Array.from({ length: filterRegexes.length }, (_, index) => ({
        regex: filterRegexes[index],
        contextTemplate: contextTemplates[index],
        replyTemplate: replyTemplates[index]
    }));

    // 应用过滤正则表达式，并按照\f分割消息
    const segments = advancedSplit(s, filterRegex).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        let isMatched = false;
        for (let j = 0; j < filterRegexes.length; j++) {
            const filter = filters[j];
            const match = segment.match(filter.regex);
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

interface TokenSegment {
    type: 'text' | 'at' | 'poke' | 'quote' | 'img' | 'face' | 'audio';
    content: string;
}

export function parseSpecialTokens(s: string): TokenSegment[] {
    const result: TokenSegment[] = [];
    const segs = s.split(/([<＜][\|│｜][^:：]+[:：]?\s?.+?(?:[\|│｜][>＞]|[\|│｜>＞]))/);
    segs.forEach(seg => {
        if (!seg) return;
        const match = seg.match(/[<＜][\|│｜]([^:：]+)[:：]?\s?(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/);
        if (!match) {
            result.push({
                type: 'text',
                content: seg
            })
        } else {
            const [_, type = 'text', content = ''] = match;
            if (!['at', 'poke', 'quote', 'img', 'face', 'audio'].includes(type)) {
                result.push({
                    type: 'text',
                    content: seg
                })
            } else {
                result.push({
                    type: type as TokenSegment['type'],
                    content: content
                })
            }
        }
    })
    return result;
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

/**
 * 高级字符串分割函数，支持正则表达式匹配分割，保留匹配部分
 * @param s 待分割的字符串
 * @param r 正则表达式
 * @returns 分割后的字符串数组
 */
function advancedSplit(s: string, r: RegExp) {
    const parts = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

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

/**
 * 修复json字符串，将其中缺少前半双引号的字符串添加前半双引号，修复失败返回空字符串
 * @param s 
 * @returns 
 */
export function fixJsonString(s: string): string {
    try {
        JSON.parse(s);
        return s;
    } catch (_err) {
        const patterns = [
            // 匹配键缺少前半引号: {key": 或 ,key":
            /([{,][\s\n]*)([a-zA-Z_$][a-zA-Z0-9_$]*)("[\s\n]*:)/g,
            // 匹配值缺少前半引号: :value", 或 :value"} 或 
            /(:[\s\n]*)([^"]+)("[\s\n]*[,}])/g,
            // 匹配数组中的字符串缺少前半引号: [value", 或 [value"] 或 ,value", 或 ,value"]
            /([\[,][\s\n]*)([^"]+)("[\s\n]*[,\]])/g
        ];

        let fixed = s;
        let matched = false;

        for (const pattern of patterns) {
            fixed = fixed.replace(pattern, (fullMatch, prefix, content, suffix) => {
                matched = true;
                const fixedContent = `${prefix}"${content}${suffix}`;
                logger.info(`修复json字符串: ${fullMatch} -> ${fixedContent}`);
                return fixedContent;
            });

            if (matched) {
                try {
                    JSON.parse(fixed);
                    return fixed;
                } catch (_err) {
                    matched = false;
                    continue;
                }
            }
        }

        if (!matched) {
            return "";
        }

        return fixed;
    }
}

export function parseActivityTime(s: string): [number, number, number] {
    const arr = s.split('-').map((item, index) => {
        const parts = item.split(/[:：,，]+/).map(Number).map(i => isNaN(i) ? 0 : i);
        if (index < 2) return Math.ceil((parts[0] * 60 + (parts[1] || 0)) % (24 * 60));
        return parts[0];
    })

    const [start = 0, end = 0, segs = 1] = arr;

    if (start === end) throw new Error('活跃时间段开始时间和结束时间不能相同');

    if (!Number.isInteger(segs)) throw new Error('活跃次数必须为整数');

    const endReal = end >= start ? end : end + 24 * 60;
    if (segs > endReal - start) throw new Error('活跃次数不能大于活跃时间段分钟数');

    return [start, end, segs];
}
