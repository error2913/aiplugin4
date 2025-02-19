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
                        description: "要修改的名字"
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
    tool.solve = async (ctx, msg, ai, name, new_name) => {
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