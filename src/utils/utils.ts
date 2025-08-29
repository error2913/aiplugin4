import { AI } from "../AI/AI";
import { logger } from "../logger";
import { ConfigManager } from "../config/config";
import { transformTextToArray } from "./utils_string";

export function transformMsgId(msgId: string | number): string {
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
        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            logger.error(`未找到HTTP依赖`);

            ai.context.lastReply = s;
            seal.replyToSender(ctx, msg, s);
            return '';
        }

        try {
            const messageArray = transformTextToArray(s);

            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/^.+:/, '');
            const user_id = ctx.player.userId.replace(/^.+:/, '');
            if (msg.messageType === 'private') {
                const data = {
                    user_id,
                    message: messageArray
                }
                const result = await globalThis.http.getData(epId, 'send_private_msg', data);
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
                const result = await globalThis.http.getData(epId, 'send_group_msg', data);
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