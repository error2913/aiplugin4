import { ConfigManager } from "../config/config";
import { createCtx, createMsg } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerJrrp() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.cmdInfo = {
        ext: 'fun',
        name: 'jrrp',
        fixedArgs: []
    }
    tool.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, [], [], []);
        if (!success) {
            return '今日人品查询失败'
        }

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}