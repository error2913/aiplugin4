import { AI } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { ToolInfo } from "../tool/tool";

export function log(...data: any[]) {
    const { logLevel } = ConfigManager.log;

    if (logLevel === "永不") {
        return;
    }

    if (logLevel === "简短") {
        const s = data.map(item => `${item}`).join(" ");
        if (s.length > 1000) {
            console.log(s.substring(0, 500), "\n...\n", s.substring(s.length - 500));
            return;
        }
    }

    console.log('【aiplugin4】: ', ...data);
}

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

export function parseBody(template: string[], messages: any[], tools: ToolInfo[], tool_choice: string) {
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const bodyObject: any = {};

    for (let i = 0; i < template.length; i++) {
        const s = template[i];
        if (s.trim() === '') {
            continue;
        }

        try {
            const obj = JSON.parse(`{${s}}`);
            const key = Object.keys(obj)[0];
            bodyObject[key] = obj[key];
        } catch (err) {
            throw new Error(`解析body的【${s}】时出现错误:${err}`);
        }
    }

    if (!bodyObject.hasOwnProperty('messages')) {
        bodyObject.messages = messages;
    }

    if (!bodyObject.hasOwnProperty('model')) {
        throw new Error(`body中没有model`);
    }

    if (isTool && !usePromptEngineering) {
        if (!bodyObject.hasOwnProperty('tools')) {
            bodyObject.tools = tools;
        }

        if (!bodyObject.hasOwnProperty('tool_choice')) {
            bodyObject.tool_choice = tool_choice;
        }
    } else {
        delete bodyObject?.tools;
        delete bodyObject?.tool_choice;
    }

    return bodyObject;
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

        const message: { type: string, data: any }[] = [{ type: 'text', data: { text: s } }]
        const match = s.match(/^\[CQ:reply,id=([\d\-]+)\]/);
        if (match) {
            message[0].data.text = s.replace(match[0], '');
            message.unshift({ type: 'reply', data: { id: match[1] } });
        }

        const epId = ctx.endPoint.userId;
        const group_id = ctx.group.groupId.replace(/\D+/g, '');
        const user_id = ctx.player.userId.replace(/\D+/g, '');
        if (ctx.isPrivate) {
            const data = {
                user_id,
                message: message
            }
            const result = await globalThis.http.getData(epId, 'send_private_msg', data);
            if (result.message_id) {
                log(`(${result.message_id})发送给QQ:${user_id}:${s}`);
                return transformMsgId(result.message_id);
            } else {
                throw new Error(`在replyToSender中: 获取消息ID失败`);
            }
        } else {
            const data = {
                group_id,
                message: message
            }
            const result = await globalThis.http.getData(epId, 'send_group_msg', data);
            if (result.message_id) {
                log(`(${result.message_id})发送给QQ-Group:${group_id}:${s}`);
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