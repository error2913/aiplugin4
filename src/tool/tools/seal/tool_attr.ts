// 属性工具（seal API）：获取/修改指定玩家的 COC 属性
import { getCtxAndMsg } from "../../../utils/seal";
import Tool from "../../tool";

export function registerAttrSeal() {
    const toolGet = new Tool({
        type: 'function',
        function: {
            name: 'attr_get',
            description: '获取指定玩家的指定属性',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: '用户ID'
                    },
                    attr: {
                        type: 'string',
                        description: '属性名称'
                    }
                },
                required: ['user_id', 'attr']
            }
        }
    });
    toolGet.solve = async (ctx, _, session, args) => {
        const { user_id, attr } = args;

        const ui = await session.context.getUserById(user_id);
        if (ui === null) return `未找到用户ID<${user_id}>`;

        ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ctx.group!.groupId));

        const value = seal.vars.intGet(ctx, attr)[0];
        return `${attr}: ${value}`;
    }

    const toolSet = new Tool({
        type: 'function',
        function: {
            name: 'attr_set',
            description: '修改指定玩家的指定属性',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: '用户ID'
                    },
                    expression: {
                        type: 'string',
                        description: '修改表达式，例如`hp=hp+1d6`就是将hp的值修改为hp+1d6'
                    }
                },
                required: ['user_id', 'expression']
            }
        }
    });
    toolSet.solve = async (ctx, msg, session, args) => {
        const { user_id, expression } = args;

        const ui = await session.context.getUserById(user_id);
        if (ui === null) return `未找到用户ID<${user_id}>`;

        ({ ctx, msg } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ctx.group!.groupId));

        const [attr, expr] = expression.split('=');
        if (expr === undefined) return `修改失败，表达式 ${expression} 格式错误`;

        const value = seal.vars.intGet(ctx, attr)[0];

        const attrs = expr.split(/[\s\dDd+\-*/=]+/).filter((item: string) => item);
        const values = attrs.map((item: string) => seal.vars.intGet(ctx, item)[0]);

        let s = expr;
        attrs.forEach((a: string, i: number) => s = s.replace(a, values[i].toString()));

        const result = parseInt(seal.format(ctx, `{${s}}`));

        if (isNaN(result)) return `修改失败，表达式 ${expression} 格式化错误`;

        seal.vars.intSet(ctx, attr, result);

        seal.replyToSender(ctx, msg, `进行了 ${expression} 修改\n${attr}: ${value}=>${result}`);
        return `进行了 ${expression} 修改\n${attr}: ${value}=>${result}`;
    }
}
