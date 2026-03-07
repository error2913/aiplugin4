import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { buildContent } from "../utils/utils_message";
import { getCtxAndMsg } from "../utils/utils_seal";
import { Tool } from "./tool";

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
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与上下文类型对应'
                    }
                },
                required: ["ctx_type", "name"]
            }
        }
    });
    toolGet.solve = async (ctx, _, ai, args) => {
        const { ctx_type, name } = args;

        if (ctx_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };
            if (ui.id === ctx.player.userId && ctx.isPrivate) return { content: `向当前私聊发送消息无需调用函数`, images: [] };
            if (ui.id === ctx.endPoint.userId) return { content: `禁止向自己发送消息`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (ctx_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };
            if (gi.id === ctx.group.groupId) return { content: `向当前群聊发送消息无需调用函数`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
        } else {
            return { content: `未知的上下文类型<${ctx_type}>`, images: [] };
        }

        const messages = ai.context.messages;
        const images = [];
        const s = messages.map(message => {
            images.push(...message.images);

            if (message.role === 'assistant' && message?.tool_calls && message?.tool_calls.length > 0) {
                return `\n[function_call]: ${message.tool_calls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
            }

            return `[${message.role}]: ${buildContent(message)}`;
        }).join('\n');

        return { content: s, images: images };
    }
}