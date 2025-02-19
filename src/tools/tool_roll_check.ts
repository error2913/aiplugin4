import { createMsg, createCtx } from "../utils/utils_seal";
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
                    expression: {
                        type: "string",
                        description: "属性表达式，例如：敏捷、体质/2、意志-20",
                    },
                    rank : {
                        type: "string",
                        description: "难度等级，若无特殊说明则为空字符串",
                        enum: ["", "困难", "极难", "大成功"]
                    },
                    times: {
                        type: "integer",
                        description: "检定的次数，若无特殊说明一般为1",
                    },
                    additional_dice: {
                        type: "string",
                        description: `额外的奖励骰或惩罚骰和数量，b代表奖励骰，p代表惩罚骰，若有多个，请在后面附加数字，例如：b、b2、p3，若没有奖励骰或惩罚骰则为空字符串`
                    },
                    reason: {
                        type: "string",
                        description: "检定的原因，默认为空"
                    }
                },
                required: ["name", "expression", "rank", "times", "additional_dice"]
            }
        }
    }

    const tool = new Tool(info);
    tool.cmdInfo = {
        ext: 'coc7',
        name: 'ra',
        fixedArgs: []
    }
    tool.solve = async (ctx, msg, ai, name, expression, rank, times, additional_dice, reason = '') => {
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

        const args = [];

        if (additional_dice) {
            args.push(additional_dice);
        }

        args.push(rank + expression);

        if (reason) {
            args.push(reason);
        }

        if (parseInt(times) !== 1 && !isNaN(parseInt(times))) {
            ToolManager.cmdArgs.specialExecuteTimes = parseInt(times);
        }

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, ...args);

        ToolManager.cmdArgs.specialExecuteTimes = 1;

        if (!success) {
            return '检定完成';
        }

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}