import { AI, GroupInfo, UserInfo } from "../AI/AI";
import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { transformTextToArray } from "./utils_string";

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
    if (showMsgId) {
        const net = globalThis.net || globalThis.http;
        if (!net) {
            logger.error(`未找到ob11网络连接依赖`);
            ai.context.lastReply = s;
            seal.replyToSender(ctx, msg, s);
            return '';
        }

        try {
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

            if (messageArray.length === 0) {
                return '';
            }

            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = ctx.player.userId.replace(/^.+:/, '');
            if (msg.messageType === 'private') {
                const data = {
                    user_id,
                    message: messageArray
                }
                const result = await net.callApi(epId, 'send_private_msg', data);
                if (result?.message_id) {
                    logger.info(`(${result.message_id})发送给QQ:${user_id}:${s}`);
                    return transformMsgId(result.message_id);
                } else {
                    throw new Error(`发送私聊消息失败，无法获取message_id`);
                }
            } else if (msg.messageType === 'group') {
                const data = {
                    group_id,
                    message: messageArray
                }
                const result = await net.callApi(epId, 'send_group_msg', data);
                if (result?.message_id) {
                    logger.info(`(${result.message_id})发送给QQ-Group:${group_id}:${s}`);
                    return transformMsgId(result.message_id);
                } else {
                    throw new Error(`发送群聊消息失败，无法获取message_id`);
                }
            } else {
                throw new Error(`未知的消息类型`);
            }
        } catch (error) {
            logger.error(`在replyToSender中: ${error}`);
            ai.context.lastReply = s;
            seal.replyToSender(ctx, msg, s);
            return '';
        }
    } else {
        ai.context.lastReply = s;
        seal.replyToSender(ctx, msg, s);
        return '';
    }
}

export function withTimeout<T>(asyncFunc: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        asyncFunc(),
        new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

/**
 * 恢复一个对象，只恢复构造函数中定义的属性，暂不支持嵌套属性
 * @param constructor 传入构造函数，必须有 validKeys 属性
 * @param value 要恢复的对象
 * @returns 恢复后的对象
 */
export function revive<T>(constructor: { new(): T, validKeys: (keyof T)[] }, value: any): T {
    const obj = new constructor();

    if (!constructor.validKeys) {
        logger.error(`revive: ${constructor.name} 没有 validKeys 属性`);
        return obj;
    }

    for (const k of constructor.validKeys) {
        if (value.hasOwnProperty(k)) {
            obj[k] = value[k];
        }
    }

    return obj;
}

export function aliasToCmd(val: string) {
    // 命令别名映射表，别名：原始命令
    const aliasMap = {
        "AI": "ai",
        "priv": "privilege",
        "ses": "session",
        "st": "set",
        "ck": "check",
        "clr": "clear",
        "sb": "standby",
        "fgt": "forget",
        "f": "forget",
        "ass": "assistant",
        "memo": "memory",
        "p": "private",
        "g": "group",
        "del": "delete",
        "ign": "ignore",
        "rm": "remove",
        "lst": "list",
        "tk": "token",
        "y": "year",
        "m": "month",
        "lcl": "local",
        "stl": "steal",
        "ran": "random",
        "nick": "nickname"
    }
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

export function getCommonUser(a: UserInfo[], b: UserInfo[]): UserInfo[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a.map(u => u.id));
    return b.filter(u => aid.has(u.id));
}
export function getCommonGroup(a: GroupInfo[], b: GroupInfo[]): GroupInfo[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a.map(g => g.id));
    return b.filter(g => aid.has(g.id));
}
export function getCommonKeyword(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a);
    return b.filter(k => aid.has(k));
}