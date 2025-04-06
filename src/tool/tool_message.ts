import { AIManager } from "../AI/AI";
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
                        type: "object",
                        properties: {
                            name: {
                                type: 'string',
                                description: '函数名称'
                            },
                            arguments: {
                                type: 'string',
                                description: '函数参数，必须严格按照目标函数的参数定义（包括参数名和类型）完整填写，格式为JSON字符串'
                            }
                        },
                        required: ["name", "arguments"],
                        description: '函数调用，必须准确理解目标函数的参数定义后再填写'
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
        const match = content.match(/<\s?[\|│｜]图片.+?[\|│｜]?\s?>/g);
        if (match) {
            for (let i = 0; i < match.length; i++) {
                const id = match[i].match(/<\s?[\|│｜]图片(.+?)[\|│｜]?\s?>/)[1].trim().slice(0, 6);
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

        await ai.context.addSystemUserMessage("来自其他对话的消息发送提示", `${source}: 原因: ${reason || '无'}`, originalImages);

        const { s, reply, images } = await handleReply(ctx, msg, content, ai.context);

        const msgId = await replyToSender(ctx, msg, ai, reply);
        await ai.context.addMessage(ctx, s, images, 'assistant', msgId);

        if (tool_call) {
            if (ToolManager.cmdArgs == null) {
                return `暂时无法调用函数，请先使用任意海豹指令`;
            }
            if (ConfigManager.tool.toolsNotAllow.includes(tool_call.name)) {
                return `调用函数失败:禁止调用的函数:${tool_call.name}`;
            }
            if (!ToolManager.toolMap.hasOwnProperty(tool_call.name)) {
                return `调用函数失败:未注册的函数:${tool_call.name}`;
            }

            const tool = ToolManager.toolMap[tool_call.name];
            if (tool.type !== "all" && tool.type !== msg.messageType) {
                return `调用函数失败:函数${name}可使用的场景类型为${tool.type}，当前场景类型为${msg.messageType}`;
            }

            try {
                try {
                    tool_call.arguments = JSON.parse(tool_call.arguments);
                } catch (e) {
                    return `调用函数失败:arguement不是一个合法的JSON字符串`;
                }

                const args = tool_call.arguments;
                if (args !== null && typeof args !== 'object') {
                    return `调用函数失败:arguement不是一个object`;
                }
                for (const key of tool.info.function.parameters.required) {
                    if (!args.hasOwnProperty(key)) {
                        return `调用函数失败:缺少必需参数 ${key}`;
                    }
                }

                const s = await tool.solve(ctx, msg, ai, args);
                await ai.context.addSystemUserMessage('调用函数返回', s, []);

                AIManager.saveAI(ai.id);
                return `函数调用成功，返回值:${s}`;
            } catch (e) {
                const s = `调用函数 (${name}:${JSON.stringify(tool_call.arguments, null, 2)}) 失败:${e.message}`;
                logger.error(s);
                await ai.context.addSystemUserMessage('调用函数返回', s, []);

                AIManager.saveAI(ai.id);
                return s;
            }
        }

        AIManager.saveAI(ai.id);
        return "消息发送成功";
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

export function registerQuoteMsg() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'quote_msg',
            description: '引用指定消息并回复',
            parameters: {
                type: 'object',
                properties: {
                    msg_id: {
                        type: 'string',
                        description: '消息ID'
                    },
                    content: {
                        type: 'string',
                        description: '回复的内容'
                    }
                },
                required: ['msg_id', 'content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { msg_id, content } = args;

        try {
            const { s, reply, images } = await handleReply(ctx, msg, content, ai.context);
            const msgId = await replyToSender(ctx, msg, ai, `[CQ:reply,id=${transformMsgIdBack(msg_id)}]${reply}`);
            await ai.context.addMessage(ctx, s, images, 'assistant', msgId);
            return `已引用消息${msg_id}并回复`;
        } catch (e) {
            logger.error(e);
            return `引用消息失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}