import { ConfigManager } from "../config/configManager";
import { getCtxAndMsg } from "../utils/utils_seal";
import { Tool, ToolManager } from "./tool";

export function registerJrrp() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "jrrp",
            description: `查看指定用户的今日人品`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    }
                },
                required: ["name"]
            }
        }
    });
    tool.cmdInfo = {
        ext: 'fun',
        name: 'jrrp',
        fixedArgs: []
    }
    tool.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const ui = await ai.context.findUserInfo(ctx, name);
        if (ui === null) return { content: `未找到<${name}>`, images: [] };

        ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ctx.group.groupId));
        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, [], [], []);
        if (!success) return { content: '今日人品查询失败', images: [] };

        return { content: s, images: [] };
    }
}