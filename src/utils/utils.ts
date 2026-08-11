// 通用工具：消息ID转换/回复发送/超时/revive/路径解析等
import Config from "../config/config";
import { ALIAS_MAP } from "../config/static_config";
import { logger } from "../logger";

import { netExists, sendGroupMsg, sendPrivateMsg } from "./ob11";
import { transformTextToArray } from "./string";

export function transformMsgId(msgId: string | number | null): string {
    if (msgId === null || msgId === '') {
        return '';
    }
    if (typeof msgId === 'string') {
        msgId = parseInt(msgId, 10); // 原始十进制 ID；负数保留符号
    }
    // 消息 ID 可能为负数（NapCat 等实现会产生负的 int64 ID），
    // base36 转换会保留符号（如 -123 -> -3f），反向转换可无损还原
    return isNaN(msgId) ? '' : msgId.toString(36);
}

export function transformMsgIdBack(msgId: string): number {
    return parseInt(msgId, 36); // 将36进制字符串转换为数字（负数保留符号）
}

/**
 * 消息记录用的唯一 ID。milky 格式（msg.segment 非空）下 msg.rawId 只是会话内的
 * message_seq，经 ob11 依赖的 net.messageId 转成 OB11 唯一 message_id 后再按现有
 * base36 规则记录；未装依赖、参数缺失或转换失败时回退原逻辑（transformMsgId(rawId)）。
 * 注意：发送引用仍使用原始 rawId（milky 端需要 message_seq），此处仅用于上下文记录。
 */
export function getRecordMessageId(ctx: seal.MsgContext, msg: seal.Message): string {
    const segments = (msg as any).segment;
    if (Array.isArray(segments) && segments.length > 0) {
        const net = (globalThis as any).net;
        if (net && typeof net.messageId === 'function' && msg.rawId !== null && msg.rawId !== undefined && msg.rawId !== '') {
            try {
                const rawStr = String(msg.rawId);
                const peerStr = ctx.isPrivate ? (ctx.player && ctx.player.userId) || '' : (ctx.group && ctx.group.groupId) || '';
                const peerMatch = /(\d+)$/.exec(peerStr);
                if (peerMatch && /^\d+$/.test(rawStr)) {
                    const mid = net.messageId({ scene: ctx.isPrivate ? 'friend' : 'group', id: Number(peerMatch[1]), msgid: Number(rawStr) });
                    if (mid !== null && mid !== undefined) {
                        return transformMsgId(Number(mid));
                    }
                }
            } catch (e) {
                logger.warning(`milky 消息 ID 转换失败，回退原始 rawId:${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    return transformMsgId(msg.rawId);
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}

export async function replyToSender(ctx: seal.MsgContext, msg: seal.Message, session: { context: { lastReply: string } }, s: string): Promise<string> {
    if (!s) {
        return '';
    }

    const { showMsgId = true } = Config.message as any;
    if (showMsgId && netExists()) {
        const rawMessageArray = transformTextToArray(s);
        const messageArray = rawMessageArray.filter(item => item.type !== 'poke');

        // 处理戳戳戳
        const pokeMsgArr = rawMessageArray.filter(item => item.type === 'poke');
        if (pokeMsgArr.length > 0) {
            pokeMsgArr.forEach(item => {
                const s = `[CQ:poke,qq=${item.data.qq}]`;
                session.context.lastReply = s;
                seal.replyToSender(ctx, msg, s);
            });
        }

        if (messageArray.length === 0) return '';

        const epId = ctx.endPoint.userId;
        const uid = ctx.player!.userId;
        if (msg.messageType === 'private') {
            const result = await sendPrivateMsg(epId, uid.replace(/^.+:/, ''), messageArray);
            if (result?.message_id) {
                logger.info(`(${result.message_id})发送给${uid}:${s}`);
                return transformMsgId(result.message_id);
            }
        } else if (msg.messageType === 'group') {
            const gid = ctx.group ? ctx.group.groupId : '';
            const result = await sendGroupMsg(epId, gid.replace(/^.+:/, ''), messageArray);
            if (result?.message_id) {
                logger.info(`(${result.message_id})发送给${gid}:${s}`);
                return transformMsgId(result.message_id);
            }
        }
        logger.warning(`无法获取message_id`);
    }
    session.context.lastReply = s;
    seal.replyToSender(ctx, msg, s);
    return '';
}

export function withTimeout<T>(asyncFunc: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        asyncFunc(),
        new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

export type TypeDescriptor<T> =
    'default'
    | 'string'
    | 'number'
    | 'boolean'
    | 'any'
    | TypeDescriptor<any>[] // 元组元素类型
    | { array: TypeDescriptor<any> } // 数组元素类型
    | {
        object?: { [key: string]: TypeDescriptor<any> },
        objectValue?: TypeDescriptor<any>
    } // 对象键值对类型，对象值类型
    | RevivableConstructor<T>; // 嵌套类

interface RevivableConstructor<T> {
    new(): T; // 构造函数必须无参数
    validKeysMap: { [key in keyof T]?: TypeDescriptor<T[key]> };
}

/**
 * 恢复一个对象，只恢复构造函数中定义的属性，支持嵌套属性  希望没有bug
 * @param constructor 传入构造函数，必须有 validKeys 属性
 * @param value 要恢复的对象
 * @returns 恢复后的对象
 */
export function revive<T>(constructor: RevivableConstructor<T>, value: any): T {
    function reviveItem(descriptor: any, defaultValue: any, value: any): any {
        if (descriptor === 'string') {
            if (typeof value === 'string') return value;
        } else if (descriptor === 'number') {
            if (typeof value === 'number') return value;
        } else if (descriptor === 'boolean') {
            if (typeof value === 'boolean') return value;
        } else if (Array.isArray(descriptor)) {
            if (Array.isArray(value)) return descriptor.map((d: any, i: number) => reviveItem(d, defaultValue?.[i], value?.[i]));
        } else if (typeof descriptor === 'object' && 'array' in descriptor) {
            if (Array.isArray(value)) return value.map((v: any, i: number) => reviveItem(descriptor.array, defaultValue?.[i], v));
        } else if (typeof descriptor === 'object' && ('object' in descriptor || 'objectValue' in descriptor)) {
            const ov: any = {}, o: any = {};
            if (typeof value === 'object' && value !== null) {
                if ('objectValue' in descriptor) Object.keys(value).forEach(k => ov[k] = reviveItem((descriptor as any).objectValue, defaultValue?.[k], value?.[k]));
                if ('object' in descriptor) Object.keys((descriptor as any).object || {}).forEach(k => o[k] = reviveItem((descriptor as any).object[k], defaultValue?.[k], value?.[k]));
                return { ...o, ...ov };
            }
        } else if (typeof descriptor === 'function') {
            return revive(descriptor, value);
        } else {
            return value;
        }
        return defaultValue;
    }

    const obj: any = new constructor();

    if (constructor.validKeysMap) {
        for (const k in constructor.validKeysMap) {
            const descriptor: TypeDescriptor<T[Extract<keyof T, string>]> | undefined = (constructor.validKeysMap as any)[k];
            if (Object.prototype.hasOwnProperty.call(value, k)) {
                const item = reviveItem(descriptor, obj[k], value[k]);
                if (item !== undefined) obj[k] = item;
            }
        }
    } else { // 没有定义 validKeysMap，直接赋值
        for (const k in value) {
            obj[k] = value[k];
        }
    }

    return obj;
}

export function aliasToCmd(val: string) {
    return ALIAS_MAP[val as keyof typeof ALIAS_MAP] || val;
}

// 计算余弦相似度
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        logger.error(`cosineSimilarity: 向量维度必须相同，a: ${a.length}, b: ${b.length}`);
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function getCommonItem(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aset = new Set(a);
    return b.filter(u => aset.has(u));
}

/**
 * 将本地资源路径解析为绝对路径：
 * 相对路径（不以 / 或盘符开头）会拼接 SealDice 核心路径 Config.base.SEALDICE_PATH。
 */
export function resolveLocalPath(p: string): string {
    if (!p) return p;
    if (/^([a-zA-Z]:[\\/]|\/)/.test(p)) return p;
    const { SEALDICE_PATH } = Config.base;
    if (!SEALDICE_PATH) return p;
    return `${SEALDICE_PATH}/${p}`;
}
