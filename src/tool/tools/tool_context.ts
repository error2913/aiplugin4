// 上下文工具：查看指定会话上下文
import Config from "../../config/config";
import { getSession } from "../../session/session_service";
import { buildContent } from "../../utils/message";
import { getCtxAndMsg } from "../../utils/seal";
import Tool from "../tool";

export function registerContext() {
    const toolGet = new Tool({
        type: "function",
        function: {
            name: "get_context",
            description: `查看指定私聊或群聊的上下文`,
            parameters: {
                type: "object",
                properties: {
                    ctx_type: {
                        type: "string",
                        description: "上下文类型，私聊或群聊",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (Config.message.SHOW_NUMBER ? '或纯数字QQ号、群号' : '') + '，实际使用时与上下文类型对应'
                    }
                },
                required: ["ctx_type", "name"]
            }
        }
    });
    toolGet.solve = async (ctx, _, session, args) => {
        const { ctx_type, name } = args;

        if (ctx_type === "private") {
            const ui = await session.context.findUser(ctx, name, true);
            if (ui === null) return `未找到<${name}>`;
            if (ui.userId === ctx.player.userId && ctx.isPrivate) return `向当前私聊发送消息无需调用函数`;
            if (ui.userId === ctx.endPoint.userId) return `禁止向自己发送消息`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (ctx_type === "group") {
            const gi = await session.context.findGroup(ctx, name);
            if (gi === null) return `未找到<${name}>`;
            if (gi.groupId === ctx.group.groupId) return `向当前群聊发送消息无需调用函数`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的上下文类型<${ctx_type}>`;
        }

        const messages = session.context.messages;
        const s = messages.map(message => {
            const toolCalls = (message as any).toolCalls || (message as any).tool_calls;
            if (message.role === 'assistant' && toolCalls && toolCalls.length > 0) {
                return `\n[function_call]: ${toolCalls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
            }

            return `[${message.role}]: ${buildContent(message)}`;
        }).join('\n');

        return s;
    }
}
