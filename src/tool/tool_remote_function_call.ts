import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { createCtx, createMsg } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerRemoteFunctionCall() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "remote_function_call",
            description: `对指定私聊或群聊调用函数`,
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
                    function: {
                        type: "object",
                        properties: {
                            name: {
                                type:'string',
                                description: '函数名称'
                            },
                            arguments: {
                                type:'object',
                                description: '函数参数，按照要调用的函数的参数定义填写'
                            }
                        },
                        description: '函数调用'
                    },
                    reason: {
                        type:'string',
                        description: '发送原因' 
                    }
                },
                required: ["msg_type", "name", "function"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { msg_type, name, function: tool_call, reason = '' } = args;

        const { showNumber } = ConfigManager.message;
        const source = ctx.isPrivate ?
            `来自<${ctx.player.name}>${showNumber ? `(${ctx.player.userId.replace(/\D+/g, '')})` : ``}` :
            `来自群聊<${ctx.group.groupName}>${showNumber ? `(${ctx.group.groupId.replace(/\D+/g, '')})` : ``}`;

        if (msg_type === "private") {
            const uid = ai.context.findUserId(ctx, name);
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
            const gid = ai.context.findGroupId(ctx, name);
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


        await ai.context.systemUserIteration("_来自其他对话的函数调用", `${source}: 原因: ${reason || '无'}`);

        await ToolManager.handlePromptTool(ctx, msg, ai, tool_call);
        
        AIManager.saveAI(ai.id);

        return "函数调用成功";
    }

    ToolManager.toolMap[info.function.name] = tool;
}