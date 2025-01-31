import { getMsg, getCtx } from "../utils/utils";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerRollCheck() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "roll_check",
            description: `进行一次技能检定或属性检定`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: "被检定的人的名称",
                    },
                    attr: {
                        type: "string",
                        description: "被检定的技能或属性",
                    },
                    reason: {
                        type: "string",
                        description: "检定的原因，默认为空"
                    }
                },
                required: ["name", "attr"]
            }
        }
    }

    const tool = new Tool(info);
    tool.cmdInfo = {
        ext: 'coc7',
        name: 'rc',
        fixedArgs: []
    }
    tool.solve = async (ctx, msg, ai, name, attr, reason = '') => {
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

        const [v, _] = seal.vars.intGet(ctx, attr);
        if (v == 0) {
            attr += '50';
        }

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, attr, reason);
        if (!success) {
            return '检定完成';
        }

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}