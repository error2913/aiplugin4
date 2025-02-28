import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { handleReply } from "../utils/utils_reply";
import { createCtx, createMsg } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerSendMsg() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "send_msg",
            description: `向指定私聊或群聊发送消息，如果要向其调用函数，请使用远程函数：remote_function_call`,
            parameters: {
                type: "object",
                properties: {
                    msg_type: {
                        type: "string",
                        description: "消息类型，私聊或群聊",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '')
                    },
                    content: {
                        type: 'string',
                        description: '消息内容'
                    },
                    reason: {
                        type: 'string',
                        description: '发送原因'
                    }
                },
                required: ["msg_type", "name", "content"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { msg_type, name, content, reason = '' } = args;

        const { showNumber } = ConfigManager.message;
        const source = ctx.isPrivate ?
            `来自<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/\D+/g, '')})` : ``}` :
            `来自群聊<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/\D+/g, '')})` : ``}`;

        if (msg_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                console.log(`未找到<${name}>`);
                return `未找到<${name}>`;
            }
            if (uid === ctx.player.userId && ctx.isPrivate) {
                return `向当前私聊发送消息无需调用函数`;
            }
            if (uid === ctx.endPoint.userId) {
                return `禁止向自己发送消息`;
            }

            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (msg_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                console.log(`未找到<${name}>`);
                return `未找到<${name}>`;
            }
            if (gid === ctx.group.groupId) {
                return `向当前群聊发送消息无需调用函数`;
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
        } else {
            return `未知的消息类型<${msg_type}>`;
        }


        await ai.context.systemUserIteration("_来自其他对话的消息发送提示", `${source}: 原因: ${reason || '无'}`);

        const { s, reply, images } = await handleReply(ctx, msg, content, ai.context);
        ai.context.lastReply = reply;
        await ai.context.iteration(ctx, s, images, "assistant");

        seal.replyToSender(ctx, msg, reply);
        AIManager.saveAI(ai.id);

        return "消息发送成功";
    }

    ToolManager.toolMap[info.function.name] = tool;
}