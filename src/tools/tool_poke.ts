import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerPoke() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'poke',
            description: '对用户发送戳一戳',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称'
                    }
                },
                required: ['name']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, name) => {
        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        const uid = ai.context.findUid(name);
        if (uid === null) {
            console.log(`未找到<${name}>`);
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        if (uid === ctx.endPoint.userId) {
            ctx.player.name = name;
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            const user_id = ctx.player.userId.replace(/\D+/g, '');
            globalThis.http.getData(epId, `group_poke?group_id=${group_id}&user_id=${user_id}`);
            return `已向<${name}>发送戳一戳`;
        } catch (e) {
            console.error(e);
            return `发送戳一戳失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}