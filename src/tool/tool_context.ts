import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { buildContent } from "../utils/utils_message";
import { createCtx, createMsg } from "../utils/utils_seal";
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
    toolGet.solve = async (ctx, msg, ai, args) => {
        const { ctx_type, name } = args;

        if (ctx_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }
            if (uid === ctx.player.userId && ctx.isPrivate) {
                return { content: `向当前私聊发送消息无需调用函数`, images: [] };
            }
            if (uid === ctx.endPoint.userId) {
                return { content: `禁止向自己发送消息`, images: [] };
            }

            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (ctx_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }
            if (gid === ctx.group.groupId) {
                return { content: `向当前群聊发送消息无需调用函数`, images: [] };
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
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