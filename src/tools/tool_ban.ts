import { getMsg, getCtx } from "../utils/utils";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerBan() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'ban',
            description: '禁言指定用户',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称'
                    },
                    duration: {
                        type: 'integer',
                        description: '禁言时长，单位为秒，最大为2591940'
                    }
                },
                required: ['name', 'duration']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, name, duration) => {
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

        msg = getMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = getCtx(ctx.endPoint.userId, msg);

        if (uid === ctx.endPoint.userId) {
            ctx.player.name = name;
        }

        try {
            const epId = ctx.endPoint.userId;
            const group_id = ctx.group.groupId.replace(/\D+/g, '');
            const user_id = ctx.player.userId.replace(/\D+/g, '');
            globalThis.http.getData(epId, `set_group_ban?group_id=${group_id}&user_id=${user_id}&duration=${duration}`);
            return `已禁言<${name}> ${duration}秒`;
        } catch (e) {
            console.error(e);
            return `禁言失败`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}