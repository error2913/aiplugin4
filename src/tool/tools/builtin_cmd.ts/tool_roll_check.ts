// 检定工具：技能/属性检定与 san check
import Config from "../../../config/config";
import { getCtxAndMsg } from "../../../utils/seal";
import Tool from "../../tool";

export function registerRollCheck() {
    const toolRoll = new Tool({
        type: "function",
        function: {
            name: "roll_check",
            description: `进行一次技能检定或属性检定`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: "被检定的人的名称" + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '')
                    },
                    expression: {
                        type: "string",
                        description: "属性表达式，例如：敏捷、体质/2、意志-20",
                    },
                    rank: {
                        type: "string",
                        description: "难度等级，若无特殊说明则忽略",
                        enum: ["困难", "极难", "大成功"]
                    },
                    times: {
                        type: "integer",
                        description: "检定的次数，若无特殊说明则忽略",
                    },
                    additional_dice: {
                        type: "string",
                        description: `额外的奖励骰或惩罚骰和数量，b代表奖励骰，p代表惩罚骰，若有多个，请在后面附加数字，例如：b、b2、p3，若没有奖励骰或惩罚骰则忽略`
                    },
                    reason: {
                        type: "string",
                        description: "检定的原因"
                    }
                },
                required: ["name", "expression"]
            }
        }
    });
    toolRoll.ExtCmdInfo = {
        extName: 'coc7',
        cmd: 'ra',
        staticArgs: []
    }
    toolRoll.solve = async (ctx, msg, session, args) => {
        const { name, expression, rank = '', times = 1, additional_dice = '', reason = '' } = args;

        const ui = await session.context.findUser(ctx, name);
        if (ui === null) return `未找到<${name}>`;

        ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ctx.group.groupId));

        const args2 = [];
        if (additional_dice) args2.push(additional_dice);

        if (rank || /[\dDd+\-*/]/.test(expression)) {
            args2.push(rank + expression);
        } else {
            const value = seal.vars.intGet(ctx, expression)[0];
            args2.push(expression + (value === 0 ? '50' : ''));
        }

        if (reason) args2.push(reason);

        if (Tool.cmdArgs && parseInt(times) !== 1 && !isNaN(parseInt(times))) Tool.cmdArgs.specialExecuteTimes = parseInt(times);

        const [s, success] = await Tool.extensionSolve(ctx, msg, session.tool.listen, toolRoll.ExtCmdInfo, args2, [], []);
        if (Tool.cmdArgs) Tool.cmdArgs.specialExecuteTimes = 1;
        if (!success) return '检定执行失败';
        return s;
    }

    // 该函数疑似无法正常工作。无法找到原因。
    // 表现：使用该函数时，san值会被异常清0
    // 调试发现正常指令的cmdArgs与该函数构建的完全一致的情况下也能触发bug
    // 推测：构建的临时ctx导致bug，详细原因不明，期待后续修复
    const tool = new Tool({
        type: "function",
        function: {
            name: "san_check",
            description: `进行san check(sc)，并根据结果扣除san`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: 'string',
                        description: "进行sancheck的人的名称" + (Config.message.SHOW_NUMBER ? '或纯数字QQ号' : '')
                    },
                    expression: {
                        type: "string",
                        description: `san check的表达式，格式为 成功时掉san/失败时掉san ,例如：1/1d6、0/1`
                    },
                    additional_dice: {
                        type: "string",
                        description: `额外的奖励骰或惩罚骰和数量，b代表奖励骰，p代表惩罚骰，若有多个，请在后面附加数字，例如：b、b2、p3`
                    }
                },
                required: ['name', 'expression']
            }
        }
    })
    tool.ExtCmdInfo = {
        extName: 'coc7',
        cmd: 'sc',
        staticArgs: []
    }
    tool.solve = async (ctx, msg, session, args) => {
        const { name, expression, additional_dice } = args;

        const ui = await session.context.findUser(ctx, name);
        if (ui === null) return `未找到<${name}>`;

        ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ctx.group.groupId));

        const value = seal.vars.intGet(ctx, 'san')[0];
        if (value === 0) seal.vars.intSet(ctx, 'san', 60);

        const args2 = [];
        if (additional_dice) args2.push(additional_dice);
        args2.push(expression);

        const [s, success] = await Tool.extensionSolve(ctx, msg, session.tool.listen, tool.ExtCmdInfo, args2, [], []);
        if (!success) return 'san check执行失败';
        return s;
    }
}
