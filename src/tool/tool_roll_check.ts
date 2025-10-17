import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolManager } from "./tool";

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
                        description: "被检定的人的名称" + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
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
    toolRoll.cmdInfo = {
        ext: 'coc7',
        name: 'ra',
        fixedArgs: []
    }
    toolRoll.solve = async (ctx, msg, ai, args) => {
        const { name, expression, rank = '', times = 1, additional_dice = '', reason = '' } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return { content: `未找到<${name}>`, images: [] };
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        const args2 = [];

        if (additional_dice) {
            args2.push(additional_dice);
        }

        if (rank || /[\dDd+\-*/]/.test(expression)) {
            args2.push(rank + expression);
        } else {
            const value = seal.vars.intGet(ctx, expression)[0];
            args2.push(expression + (value === 0 ? '50' : ''));
        }

        if (reason) {
            args2.push(reason);
        }

        if (parseInt(times) !== 1 && !isNaN(parseInt(times))) {
            ToolManager.cmdArgs.specialExecuteTimes = parseInt(times);
        }

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, toolRoll.cmdInfo, args2, [], []);

        ToolManager.cmdArgs.specialExecuteTimes = 1;

        if (!success) {
            return { content: '检定执行失败', images: [] };
        }

        return { content: s, images: [] };
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
                        description: "进行sancheck的人的名称" + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
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
    tool.cmdInfo = {
        ext: 'coc7',
        name: 'sc',
        fixedArgs: []
    }
    tool.solve = async (ctx, msg, ai, args) => {
        const { name, expression, additional_dice } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return { content: `未找到<${name}>`, images: [] };
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        const value = seal.vars.intGet(ctx, 'san')[0];
        if (value === 0) {
            seal.vars.intSet(ctx, 'san', 60);
        }

        const args2 = [];
        if (additional_dice) {
            args2.push(additional_dice);
        }
        args2.push(expression);

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, args2, [], []);
        if (!success) {
            return { content: 'san check执行失败', images: [] };
        }

        return { content: s, images: [] };
    }
}