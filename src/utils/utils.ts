import { AI } from "../AI/AI";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { parseText } from "./utils_string";

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
            console.error(`未找到HTTP依赖`);

            ai.context.lastReply = s;
            seal.replyToSender(ctx, msg, s);
            return '';
        }

        const messageArray = parseText(s);

        const epId = ctx.endPoint.userId;
        const group_id = ctx.group.groupId.replace(/\D+/g, '');
        const user_id = ctx.player.userId.replace(/\D+/g, '');
        if (ctx.isPrivate) {
            const data = {
                user_id,
                message: messageArray
            }
            const result = await globalThis.http.getData(epId, 'send_private_msg', data);
            if (result.message_id) {
                logger.info(`(${result.message_id})发送给QQ:${user_id}:${s}`);
                return transformMsgId(result.message_id);
            } else {
                throw new Error(`在replyToSender中: 获取消息ID失败`);
            }
        } else {
            const data = {
                group_id,
                message: messageArray
            }
            const result = await globalThis.http.getData(epId, 'send_group_msg', data);
            if (result.message_id) {
                logger.info(`(${result.message_id})发送给QQ-Group:${group_id}:${s}`);
                return transformMsgId(result.message_id);
            } else {
                throw new Error(`在replyToSender中: 获取消息ID失败`);
            }
        }
    } else {
        ai.context.lastReply = s;
        seal.replyToSender(ctx, msg, s);
        return '';
    }
}