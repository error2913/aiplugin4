import { AIManager } from "../AI/AI";
import { logger } from "../AI/logger";
import { ConfigManager } from "../config/config";
import { replyToSender, transformMsgIdBack } from "../utils/utils";
import { createCtx, createMsg } from "../utils/utils_seal";
import { handleReply } from "../utils/utils_string";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerSendMsg() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "send_msg",
            description: `向当前聊天以外的指定私聊或群聊发送消息或调用函数`,
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
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与消息类型对应'
                    },
                    content: {
                        type: 'string',
                        description: '消息内容'
                    },
                    function: {
                        type: "string",
                        description: '函数调用，纯JSON字符串，格式为：{"name": "函数名称", "arguments": {"参数1": "值1", "参数2": "值2"}}'
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
        const { msg_type, name, content, function: tool_call, reason = '' } = args;

        const { showNumber } = ConfigManager.message;
        const source = ctx.isPrivate ?
            `来自<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/\D+/g, '')})` : ``}` :
            `来自群聊<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/\D+/g, '')})` : ``}`;

        const originalImages = [];
        const match = content.match(/[<＜]\s?[\|│｜]img:.+?(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/g);
        if (match) {
            for (let i = 0; i < match.length; i++) {
                const id = match[i].match(/[<＜]\s?[\|│｜]img:(.+?)(?:[\|│｜]\s?[>＞<＜]|[\|│｜]|\s?[>＞<＜])/)[1].trim().slice(0, 6);
                const image = ai.context.findImage(id);

                if (image) {
                    originalImages.push(image);
                }
            }
        }

        if (msg_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
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

        ai.resetState();

        await ai.context.addSystemUserMessage("来自其他对话的消息发送提示", `${source}: 原因: ${reason || '无'}`, originalImages);

        const { stringArray, replyArray, images } = await handleReply(ctx, msg, content, ai.context);

        try {
            for (let i = 0; i < stringArray.length; i++) {
                const s = stringArray[i];
                const reply = replyArray[i];
                const msgId = await replyToSender(ctx, msg, ai, reply);
                await ai.context.addMessage(ctx, s, images, 'assistant', msgId);
            }

            if (tool_call) {
                try {
                    await ToolManager.handlePromptToolCall(ctx, msg, ai, tool_call);
                } catch (e) {
                    logger.error(e);
                    return `函数调用失败:${e.message}`;
                }
            }

            AIManager.saveAI(ai.id);
            return "消息发送成功";
        } catch (e) {
            logger.error(e);
            return `消息发送失败:${e.message}`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerDeleteMsg() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'delete_msg',
            description: '撤回指定消息',
            parameters: {
                type: 'object',
                properties: {
                    msg_id: {
                        type: 'string',
                        description: '消息ID'
                    }
                },
                required: ['msg_id']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, __, args) => {
        const { msg_id } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            logger.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        try {
            const epId = ctx.endPoint.userId;
            const result = await globalThis.http.getData(epId, `get_msg?message_id=${transformMsgIdBack(msg_id)}`);
            if (result.sender.user_id != epId.replace(/\D+/g, '')) {
                if (result.sender.role == 'owner' || result.sender.role == 'admin') {
                    return `你没有权限撤回该消息`;
                }

                try {
                    const epId = ctx.endPoint.userId;
                    const group_id = ctx.group.groupId.replace(/\D+/g, '');
                    const user_id = epId.replace(/\D+/g, '');
                    const result = await globalThis.http.getData(epId, `get_group_member_info?group_id=${group_id}&user_id=${user_id}&no_cache=true`);
                    if (result.role !== 'owner' && result.role !== 'admin') {
                        return `你没有管理员权限`;
                    }
                } catch (e) {
                    logger.error(e);
                    return `获取权限信息失败`;
                }
            }
        } catch (e) {
            logger.error(e);
            return `获取消息信息失败`;
        }

        try {
            const epId = ctx.endPoint.userId;
            await globalThis.http.getData(epId, `delete_msg?message_id=${transformMsgIdBack(msg_id)}`);
            return `已撤回消息${msg_id}`;
        } catch (e) {
            logger.error(e);
            return `撤回消息失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}