import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerSanCheck() {
    const info: ToolInfo = {
        type: "function",
        function: {
            name: "san_check",
            description: `进行san check(sc)，并根据结果扣除san`,
            parameters: {
                type: "object",
                properties: {
                    expression: {
                        type: "string",
                        description: `san check的表达式，格式为 成功时掉san/失败时掉san ,例如：1/1d6、0/1`
                    },
                    additional_dice: {
                        type: "string",
                        description: `额外的奖励骰或惩罚骰和数量，b代表奖励骰，p代表惩罚骰，若有多个，请在后面附加数字，例如：b、b2、p3`
                    }
                },
                required: ['expression']
            }
        }
    }

    const tool = new Tool(info)
    tool.cmdInfo = {
        ext: 'coc7',
        name: 'sc',
        fixedArgs: []
    }
    tool.solve = async (ctx, msg, ai, args) => {
        const { expression, additional_dice } = args;

        const args2 = [];
        if (additional_dice) {
            args2.push(additional_dice);
        }
        args2.push(expression);

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, tool.cmdInfo, ...args2);
        if (!success) {
            return 'san check已执行';
        }

        return s;
    }

    ToolManager.toolMap[info.function.name] = tool;
}