import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { handleMessages } from "../utils/utils_message";
import { createCtx, createMsg } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerCheckCtx() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "check_ctx",
            description: `查看指定私聊或群聊的上下文`,
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
                        description: '用户名称或群聊名称' + ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : ''
                    }
                },
                required: ["msg_type", "name"]
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { msg_type, name } = args;

        if (msg_type === "private") {
            const uid = ai.context.findUserId(name);
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
            const gid = ai.context.findGroupId(name);
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

        const messages = handleMessages(ctx, ai);
        const s = messages.map(item => {
            if (item.role === 'system') {
                return '';
            }
            if (item.role === 'assistant' && item?.tool_calls) {
                return `[function_call]: ${item.tool_calls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
            }
            return `[${item.role}]: ${item.content}`;
        }).join('\n');

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}