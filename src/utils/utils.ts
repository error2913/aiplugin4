import { AI } from "../AI/AI";
import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { transformTextToArray } from "./utils_string";
import { aliasMap } from "../config/config";
import { netExists, sendGroupMsg, sendPrivateMsg } from "./utils_ob11";

export function transformMsgId(msgId: string | number | null): string {
    if (msgId === null) {
        return '';
    }
    if (typeof msgId === 'string') {
        msgId = parseInt(msgId);
    }
    return isNaN(msgId) ? '' : msgId.toString(36); // 将数字转换为36进制字符串
}

export function transformMsgIdBack(msgId: string): number {
    return parseInt(msgId, 36); // 将36进制字符串转换为数字 
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}

export async function replyToSender(ctx: seal.MsgContext, msg: seal.Message, ai: AI, s: string): Promise<string> {
    if (!s) {
        return '';
    }

    const { showMsgId } = ConfigManager.message;
    if (showMsgId && netExists()) {
        const rawMessageArray = transformTextToArray(s);
        const messageArray = rawMessageArray.filter(item => item.type !== 'poke');

        // 处理戳戳戳
        const pokeMsgArr = rawMessageArray.filter(item => item.type === 'poke');
        if (pokeMsgArr.length > 0) {
            pokeMsgArr.forEach(item => {
                const s = `[CQ:poke,qq=${item.data.qq}]`;
                ai.context.lastReply = s;
                seal.replyToSender(ctx, msg, s);
            });
        }

        if (messageArray.length === 0) return '';

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        const uid = ctx.player.userId;
        if (msg.messageType === 'private') {
            const result = await sendPrivateMsg(epId, uid.replace(/^.+:/, ''), messageArray);
            if (result?.message_id) {
                logger.info(`(${result.message_id})发送给${uid}:${s}`);
                return transformMsgId(result.message_id);
            }
        } else if (msg.messageType === 'group') {
            const result = await sendGroupMsg(epId, gid.replace(/^.+:/, ''), messageArray);
            if (result?.message_id) {
                logger.info(`(${result.message_id})发送给${gid}:${s}`);
                return transformMsgId(result.message_id);
            }
        }
        logger.warning(`无法获取message_id`);
    }
    ai.context.lastReply = s;
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
    | 'string'
    | 'number'
    | 'boolean'
    | 'any'
    | TypeDescriptor<any>[] // 元组元素类型
    | { array: TypeDescriptor<any> } // 数组元素类型
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
    function reviveItem<T>(descriptor: TypeDescriptor<T>, defaultValue: any, value: any): any {
        if (descriptor === 'string') {
            if (typeof value === 'string') return value;
        } else if (descriptor === 'number') {
            if (typeof value === 'number') return value;
        } else if (descriptor === 'boolean') {
            if (typeof value === 'boolean') return value;
        } else if (descriptor === 'any') {
            return value;
        } else if (Array.isArray(descriptor)) {
            if (Array.isArray(value)) return descriptor.map((d: any, index: number) => {
                if (index < value.length && index < defaultValue.length) return reviveItem(d, defaultValue[index], value[index]);
                if (index < defaultValue.length) return defaultValue[index];
                return undefined;
            });
        } else if (typeof descriptor === 'object' && 'array' in descriptor) {
            if (Array.isArray(value)) return value.map((item: any) => reviveItem(descriptor.array, defaultValue[0], item));
        } else if (typeof descriptor === 'function') {
            return revive(descriptor, value);
        } else {
            return value;
        }
    }

    const obj: any = new constructor();

    if (constructor.validKeysMap) {
        for (const k in constructor.validKeysMap) {
            const descriptor = constructor.validKeysMap[k];
            if (value.hasOwnProperty(k)) {
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
    return aliasMap[val] || val;
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

export function getCommonUser(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a);
    return b.filter(u => aid.has(u));
}
export function getCommonGroup(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a);
    return b.filter(g => aid.has(g));
}
export function getCommonKeyword(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a);
    return b.filter(k => aid.has(k));
}