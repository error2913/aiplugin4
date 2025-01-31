import { getMsg, getCtx } from "../utils/utils";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerAttrShow() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'attr_show',
            description: '展示指定玩家的全部个人属性',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '玩家名称'
                    }
                },
                required: ['name']
            }
        }
    }

    const tool = new Tool(info);
    tool.cmdInfo = {
        ext: 'coc7',
        name: 'st',
        fixedArgs: ['show']
    }
    tool.solve = async (ctx, msg, ai, name) => {
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

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo);
        if (!success) {
            return '展示完成';
        }

        return s;
    }
    
    ToolManager.toolMap[info.function.name] = tool;
}

// TODO: 批量查看指定属性，批量设置属性