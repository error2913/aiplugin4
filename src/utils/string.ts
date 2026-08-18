// 字符串工具：消息段转换/回复拆分过滤/复读检测等
import Handlebars from "handlebars";

import Config from "../config/config";
import { FACE_MAP } from "../config/static_config";
import { Context } from "../context/context";
import { logger } from "../logger";
import Image from "../resource/image";

import { getCtxAndMsg } from "./seal";
import { getMilkyReplyQuoteId, resolveLocalPath, transformMsgId, transformMsgIdBack } from "./utils";

export function truncateText(text: string, maxLength: number): string {
    if (!text || maxLength <= 0 || text.length <= maxLength) return text || '';
    return text.slice(0, maxLength) + '...';
}


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

/**
 * 文件消息的完整可读表示。不要只显示 name：OB11/不同适配器可能把真实路径、URL、
 * file_id、file_unique 等字段放在同一段里，AI 需要这些字段才能继续调用文件工具。
 */
export function formatFileSegmentText(rawData: any): string {
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    const nestedFile = data.file && typeof data.file === 'object' ? data.file : {};
    const pick = (...values: any[]): string => {
        for (const value of values) {
            if (value === undefined || value === null) continue;
            const text = String(value).replace(/[\r\n]+/g, ' ').trim();
            if (text) return text;
        }
        return '';
    };
    const name = pick(data.name, data.file_name, data.filename, nestedFile.name, nestedFile.file_name);
    const path = pick(data.path, data.local_path, nestedFile.path, nestedFile.local_path);
    const file = pick(typeof data.file === 'string' ? data.file : '', nestedFile.file);
    const url = pick(data.url, data.file_url, data.download_url, nestedFile.url, nestedFile.file_url);
    const fileId = pick(data.file_id, data.fileId, nestedFile.file_id, nestedFile.fileId);
    const fileUnique = pick(data.file_unique, data.fileUnique, nestedFile.file_unique, nestedFile.fileUnique);
    const size = pick(data.size, data.file_size, nestedFile.size, nestedFile.file_size);
    const mime = pick(data.content_type, data.contentType, data.mime, nestedFile.content_type, nestedFile.contentType);
    const label = name || path || file || url || fileId || '未知文件';
    const fields = [
        ['name', name], ['path', path], ['file', file], ['url', url],
        ['file_id', fileId], ['file_unique', fileUnique], ['size', size], ['mime', mime]
    ].filter(([, value]) => value).map(([key, value]) => `${key}=${value}`);
    return `【文件】${label}${fields.length ? `\n${fields.join('\n')}` : ''}`;
}

/** 为忽略/触发正则生成兼容 CQ 码的匹配文本，不改变消息段本身。 */
export function formatMessageSegmentsForMatching(messageArray: MessageSegment[], fallback: string = ''): string {
    const text = messageArray.map(item => {
        if (item.type === 'text') return (item.data && item.data.text) || '';
        if (item.type === 'at') {
            const qq = item.data && (item.data.qq || item.data.user_id);
            return qq ? `[CQ:at,qq=${qq}]` : '[at]';
        }
        return `[${item.type}]`;
    }).join('');
    return text || fallback;
}

/**
 * 把海豹 milky 消息段（seal.MessageSegment，独立 Go 结构体 + type() 编号）直接映射为
 * 项目内部统一段格式。不经过 CQ 码：milky 下 msg.message 只有纯文本拼接，
 * at/图片/回复等富文本信息必须从 segment 取。
 */
export function expandMilkySegments(ctx: seal.MsgContext, segments: seal.MessageSegment[]): MessageSegment[] {
    const result: MessageSegment[] = [];
    for (const seg of segments) {
        if (!seg || typeof seg !== 'object' || typeof seg.type !== 'function') continue;
        // goja 反射会把 Go 命名 int（ElementType）包装成 Number 对象而非原始值，
        // 导致严格相等 0 === seg.type() 不成立（字符串化却显示 "0"），必须先归一化为数字；
        // type() 异常（如消息段结构损坏）时按未知段兜底，不中断整条消息处理
        let typeValue: number;
        try {
            typeValue = Number(seg.type());
        } catch (_e) {
            logger.warning('milky 消息段 type() 解析异常，按未知段处理');
            result.push({ type: 'text', data: { text: '[未知消息段]' } });
            continue;
        }
        switch (typeValue) {
            case 0: { // 文本 Text
                const content = 'content' in seg ? seg.content : '';
                result.push({ type: 'text', data: { text: content === undefined || content === null ? '' : String(content) } });
                break;
            }
            case 1: { // 艾特 At
                const target = 'target' in seg ? seg.target : '';
                result.push({ type: 'at', data: { qq: target === undefined || target === null ? '' : String(target) } });
                break;
            }
            case 2: { // 文件 File
                result.push({ type: 'text', data: { text: formatFileSegmentText(seg) } });
                break;
            }
            case 3: { // 图片 Image
                const url = 'url' in seg ? seg.url : '';
                const file = 'file' in seg
                    ? (typeof seg.file === 'string'
                        ? seg.file
                        : seg.file && typeof seg.file === 'object'
                            ? ((seg.file as any).url || (seg.file as any).file || '')
                            : '')
                    : '';
                result.push({ type: 'image', data: { url: url || file || '' } });
                break;
            }
            case 4: { // 文字转语音 TTS
                const content = 'content' in seg ? seg.content : '';
                result.push({ type: 'text', data: { text: content === undefined || content === null ? '' : String(content) } });
                break;
            }
            case 5: { // 回复 Reply
                const replySeq = 'replySeq' in seg ? seg.replySeq : '';
                result.push({ type: 'reply', data: { id: getMilkyReplyQuoteId(ctx, replySeq) } });
                break;
            }
            case 6: { // 语音 Record
                result.push({ type: 'text', data: { text: '【语音】' } });
                break;
            }
            case 7: { // 表情 Face
                const faceID = 'faceID' in seg ? seg.faceID : '';
                result.push({ type: 'face', data: { id: faceID === undefined || faceID === null ? '' : String(faceID) } });
                break;
            }
            case 8: { // 戳一戳 Poke
                const target = 'target' in seg ? seg.target : '';
                result.push({ type: 'poke', data: { qq: target === undefined || target === null ? '' : String(target) } });
                break;
            }
            default: {
                logger.debug(`milky 未知消息段类型: ${typeValue}，按文本占位处理`);
                result.push({ type: 'text', data: { text: '[未知消息段]' } });
            }
        }
    }
    return result;
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
                // 无法解析的 [CQ:... 字样保留为纯文本，避免用户内容被静默吞掉
                logger.error(`无法解析CQ码，保留为文本：${segment}`);
                messageArray.push({ type: 'text', data: { text: segment } });
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
                // 防注入：用户输入中的内部上下文标签（from/msg_id/system/time）直接剥离，不进入上下文
                content += stripInternalTags(seg.data.text);
                break;
            }
            case 'at': {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group ? ctx.group.groupId : '';
                const prefix = epId.includes(':') ? epId.slice(0, epId.indexOf(':')) : 'QQ';
                const uid = `${prefix}:${seg.data.qq || ''}`;
                if (seg.data.qq === 'all') {
                    content += '[at:全体成员]';
                    break;
                }
                // OB11 段通常直接带 name；优先使用它，避免为每个 at 额外请求群成员信息。
                let name = seg.data.name || '未知用户';
                try {
                    if (!seg.data.name) {
                        const targetCtx = getCtxAndMsg(epId, uid, gid).ctx;
                        name = targetCtx.player?.name || name;
                    }
                } catch (_e) {
                    // 目标用户上下文创建失败（如目标不在当前会话）时保留 at 标签，不中断整条消息转换
                }
                content += `[at:${name}]`;
                break;
            }
            case 'poke': {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group ? ctx.group.groupId : '';
                const prefix = epId.includes(':') ? epId.slice(0, epId.indexOf(':')) : 'QQ';
                const uid = `${prefix}:${seg.data.qq || ''}`;
                let name = '未知用户';
                try {
                    const targetCtx = getCtxAndMsg(epId, uid, gid).ctx;
                    name = targetCtx.player?.name || name;
                } catch (_e) {
                    // 目标用户上下文创建失败时保留 poke 标签，不中断整条消息转换
                }
                content += `[poke:${name}]`;
                break;
            }
            case 'reply': {
                const quoteId = transformMsgId(seg.data.id || '');
                if (quoteId) content += `[quote:${quoteId}]`;
                break;
            }
            case 'image': {
                const result = await Image.handleImageMessageSegment(ctx, seg);
                content += result.content;
                images.push(...result.images);
                break;
            }
            case 'face': {
                const faceName = FACE_MAP[String(seg.data.id)] || '';
                // 未知 face id 也保留占位，避免用户表情静默丢失；名称作为可见文案的一部分
                content += `[face:${faceName || `未知表情${String(seg.data.id)}`}]`;
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
                if (msgId) {
                    const backId = transformMsgIdBack(msgId);
                    // msgid 可能为负数（base36 保留符号），仅当可解析时才生成引用，避免 id=NaN
                    if (Number.isFinite(backId)) text += `[CQ:reply,id=${backId}]`;
                }
                break;
            }
            case 'img': {
                const id = seg.content;
                // 兼容 [img:imageId:描述]：描述部分可能带冒号，整体找不到时取首个冒号前作为图片 id
                const image = await session.context.findImage(ctx, id) || (id.includes(':') ? await session.context.findImage(ctx, id.split(':')[0]) : null);

                if (image) {
                    images.push(image);
                    text += image.CQCode;
                } else {
                    logger.warning(`无法找到图片：${id}`);
                }
                break;
            }
            case 'avatar': {
                const name = seg.content;
                const ui = await session.context.findUser(ctx, name);
                if (ui !== null) {
                    const image = Image.getUserAvatar(ui.userId);
                    images.push(image);
                    text += image.CQCode;
                } else {
                    logger.warning(`无法找到用户：${name}`);
                }
                break;
            }
            case 'group_avatar': {
                const name = seg.content;
                const gi = await session.context.findGroup(ctx, name);
                if (gi) {
                    const image = Image.getGroupAvatar(gi.groupId);
                    images.push(image);
                    text += image.CQCode;
                } else {
                    logger.warning(`无法找到群聊：${name}`);
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

    // 兼容历史 <|...|> 标签：归一化后才能识别旧格式的 [from] 多轮分段
    s = normalizeRenderTags(s);

    // 分离AI臆想出来的多轮对话
    const segments = s
        .split(/([[［]from.+?[\]］])/)
        .filter(item => item.trim());
    if (segments.length === 0) {
        return { contextArray: [], replyArray: [], images: [] };
    }

    s = '';
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const match = segment.match(/^[[［]from[:：]?\s?(.+?)[\]］]$/);
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
        s = segments.find((segment: string) => !/[[［]from.+?[\]］]/.test(segment)) || '';
        if (!s || !s.trim()) return { contextArray: [], replyArray: [], images: [] };
    }

    // 剥离残留的内部上下文标签（msg_id/system/time 及未参与多轮分段的 from），不进入发送内容与上下文
    s = stripInternalTags(s);

    // 分离回复消息和戳一戳消息
    s = s.replace(/[[［]quote[:：]?\s?(.+?)[\]］]/g, (match) => `\\f${match}`)
        .replace(/[[［]poke[:：]?\s?(.+?)[\]］]/g, (match) => `\\f${match}\\f`);

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
        if (message.role === 'assistant' && !(((message as any).toolCalls && (message as any).toolCalls.length > 0) || ((message as any).tool_calls && (message as any).tool_calls.length > 0))) {
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
                    if (message.role === 'tool' || (message.role === 'assistant' && (((message as any).toolCalls && (message as any).toolCalls.length > 0) || ((message as any).tool_calls && (message as any).tool_calls.length > 0)))) {
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

/** 内置回复过滤规则（原「回复消息过滤正则表达式」配置，改为硬编码）：
 *  第 0 条整条匹配并剔除（think 块/函数调用残留/旧版 <|...|> 未知标签/新版 [from]/[msg_id]/[system]/[time] 内部上下文标签），
 *  其余按捕获组替换（代码块/加粗/删除线/列表/标题）；旧格式标签名单补全 audio/avatar/group_avatar/user_avatar，避免误删可发送标签 */
const REPLY_FILTER_PATTERNS = [
    "<think>[\\s\\S]*<\\/think>|<[\\|│｜]?func[^>]{0,9}$|[<＜][\\|│｜](?!at|poke|quote|img|face|audio|avatar|group_avatar|user_avatar).*?(?:[\\|│｜][>＞]|[\\|│｜>＞])|^[^\\|│｜>＞]{0,10}[\\|│｜][>＞]|[<＜][\\|│｜][^\\|│｜>＞]{0,20}$|[[［](?:from|msg_id|system|time)[:：][^\\]］]*[\\]］]",
    "<[\\|│｜]?function(?:_call)?>[\\s\\S]*<\\/function(?:_call)?>",
    "```.*\\n([\\s\\S]*?)\\n```",
    "\\*\\*(.*?)\\*\\*",
    "~~(.*?)~~",
    "(?:^|\\n)\\s{0,12}[-*]\\s+(.*)",
    "(?:^|\\n)#{1,6}\\s+(.*)"
];
const REPLY_FILTER_CONTEXT_TEMPLATES = ["", "{{{match.[0]}}}", "{{{match.[0]}}}", "{{{match.[0]}}}", "{{{match.[0]}}}", "{{{match.[0]}}}", "{{{match.[0]}}}"];
const REPLY_FILTER_REPLY_TEMPLATES = ["", "", "\n{{{match.[1]}}}\n", "{{{match.[1]}}}", "{{{match.[1]}}}", "\n{{{match.[1]}}}", "\n{{{match.[1]}}}"];
const REPLY_FILTER_REGEX = new RegExp(REPLY_FILTER_PATTERNS.join('|'));

let replyFilters: { regex: RegExp, contextTemplate: HandlebarsTemplateDelegate<any>, replyTemplate: HandlebarsTemplateDelegate<any> }[] | null = null;
function getReplyFilters() {
    if (replyFilters) return replyFilters;
    replyFilters = REPLY_FILTER_PATTERNS.map((pattern, index) => ({
        regex: new RegExp(pattern),
        contextTemplate: Handlebars.compile(REPLY_FILTER_CONTEXT_TEMPLATES[index] || ''),
        replyTemplate: Handlebars.compile(REPLY_FILTER_REPLY_TEMPLATES[index] || '')
    }));
    return replyFilters;
}

function filterString(s: string): { contextArray: string[], replyArray: string[] } {
    const { MAX_CHARS: maxChar } = Config.reply;

    const contextArray: string[] = [];
    const replyArray: string[] = [];
    let replyLength = 0; //只计算未被匹配的部分

    const filters = getReplyFilters();

    // 应用过滤正则表达式，并按照\f分割消息
    const segments = advancedSplit(s, REPLY_FILTER_REGEX).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        let isMatched = false;
        for (let j = 0; j < filters.length; j++) {
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

                // 长度超过最大限制，直接截断（maxChar 为 0 时不限制）
                if (maxChar > 0 && replyLength + seg.length > maxChar) {
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
                if (maxChar > 0 && replyLength > maxChar) {
                    break;
                }
            }

            if (segment.endsWith('\\f') || segment.endsWith('\f')) {
                contextArray.push('');
                replyArray.push('');
            }
        }

        // 长度超过最大限制，直接退出（maxChar 为 0 时不限制）
        if (maxChar > 0 && replyLength > maxChar) {
            break;
        }
    }

    return { contextArray, replyArray };
}

interface TokenSegment {
    type: 'text' | 'at' | 'poke' | 'quote' | 'img' | 'avatar' | 'group_avatar' | 'face' | 'audio';
    content: string;
}

/** 旧版 <|xxx|> 渲染标签归一化为新版 [xxx]（含全角/缺竖杠变体）；仅用于 4.14.0 首次对话的历史数据迁移，解析层不再兼容旧标签 */
const RENDER_TAG_CONTENT = '[^|｜>＞]+?';
const RENDER_TAG_CLOSE = '(?:[\\|│｜][>＞]|[\\|│｜>＞])';

export function normalizeRenderTags(s: string): string {
    if (!s.includes('<')) return s;
    // 图片标签特殊处理：user_avatar/group_avatar 前缀拆成独立标签 [avatar]/[group_avatar]
    s = s.replace(
        new RegExp(`[<＜][\\|│｜]img[:：]?\\s?(?:user_avatar[:：]?(${RENDER_TAG_CONTENT})|group_avatar[:：]?(${RENDER_TAG_CONTENT})|(${RENDER_TAG_CONTENT}))${RENDER_TAG_CLOSE}`, 'gi'),
        (_all: string, user: string | undefined, group: string | undefined, img: string | undefined) =>
            user ? `[avatar:${user}]` : group ? `[group_avatar:${group}]` : `[img:${img}]`
    );
    return s.replace(
        new RegExp(`[<＜][\\|│｜](at|poke|quote|face|img|audio|from|msg_id|system|time|user_avatar|group_avatar)[:：]?\\s?(${RENDER_TAG_CONTENT})${RENDER_TAG_CLOSE}`, 'gi'),
        (_all: string, type: string, content: string) =>
            type === 'user_avatar' ? `[avatar:${content}]` : `[${type}:${content}]`
    );
}

/** 内部上下文标签名：由代码注入上下文，其余任何来源（用户输入/AI 回复/工具回调/记忆等）出现时一律剥离 */
const INTERNAL_TAG_NAMES = ['from', 'msg_id', 'system', 'time'];
const INTERNAL_TAG_TYPES = new Set(INTERNAL_TAG_NAMES);

/** 剥离内部上下文标签（from/msg_id/system/time）：先归一化旧版 <|...|> 变体，再移除新/旧方括号格式（含全角）；
 *  保留 at/poke/quote/img/avatar/group_avatar/face/audio 等可发送标签 */
export function stripInternalTags(s: string): string {
    if (!s) return s;
    s = normalizeRenderTags(s);
    return s.replace(new RegExp(`[[［](?:${INTERNAL_TAG_NAMES.join('|')})[:：]?\\s?[^\\]］]*[\\]］]`, 'gi'), '');
}

export function parseSpecialTokens(s: string): TokenSegment[] {
    const result: TokenSegment[] = [];
    const segs = s.split(/([[［](?:at|poke|quote|face|img|avatar|group_avatar|audio|from|msg_id|system|time|user_avatar)[:：]?[^\]］]*[\]］])/);
    segs.forEach(seg => {
        if (!seg) return;
        const match = seg.match(/^[[［]([a-z_]+)[:：]?\s?([^\]］]*)[\]］]$/i);
        if (!match) {
            result.push({
                type: 'text',
                content: seg
            })
        } else {
            const [_, rawType = 'text', content = ''] = match;
            const type = rawType.toLowerCase();
            // 内部上下文标签（来源/消息ID/系统/时间）不用于发送，直接丢弃避免泄露
            if (INTERNAL_TAG_TYPES.has(type)) return;
            // 兼容旧格式 [user_avatar:xxx] 别名
            const mapped = type === 'user_avatar' ? 'avatar' : type;
            if (!['at', 'poke', 'quote', 'img', 'avatar', 'group_avatar', 'face', 'audio'].includes(mapped)) {
                result.push({
                    type: 'text',
                    content: seg
                })
            } else {
                result.push({
                    type: mapped as TokenSegment['type'],
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
