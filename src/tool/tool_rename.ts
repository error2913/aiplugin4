import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerRename() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "rename",
            description: `设置群名片`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    new_name: {
                        type: 'string',
                        description: "新的名字"
                    }
                },
                required: ['name', 'new_name']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { name, new_name } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        try {
            seal.setPlayerGroupCard(ctx, new_name);
            seal.replyToSender(ctx, msg, `已将<${ctx.player.name}>的群名片设置为<${new_name}>`);
            return '设置成功';
        } catch (e) {
            console.error(e);
            return '设置失败';
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}