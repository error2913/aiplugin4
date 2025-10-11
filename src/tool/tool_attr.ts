import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolManager } from "./tool";

export function registerAttr() {
    const toolShow = new Tool({
        type: 'function',
        function: {
            name: 'attr_show',
            description: '展示指定玩家的全部个人属性',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    }
                },
                required: ['name']
            }
        }
    });
    toolShow.cmdInfo = {
        ext: 'coc7',
        name: 'st',
        fixedArgs: ['show']
    }
    toolShow.solve = async (ctx, msg, ai, args) => {
        const { name } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        const [s, success] = await ToolManager.extensionSolve(ctx, msg, ai, toolShow.cmdInfo, [], [], []);
        if (!success) {
            return '展示失败';
        }

        return s;
    }

    const toolGet = new Tool({
        type: 'function',
        function: {
            name: 'attr_get',
            description: '获取指定玩家的指定属性',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    attr: {
                        type: 'string',
                        description: '属性名称'
                    }
                },
                required: ['name', 'attr']
            }
        }
    });
    toolGet.solve = async (ctx, msg, ai, args) => {
        const { name, attr } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

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
                    name: {
                        type: 'string',
                        description: '用户名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '')
                    },
                    expression: {
                        type: 'string',
                        description: '修改表达式，例如`hp=hp+1d6`就是将hp的值修改为hp+1d6'
                    }
                },
                required: ['name', 'expression']
            }
        }
    });
    toolSet.solve = async (ctx, msg, ai, args) => {
        const { name, expression } = args;

        const uid = await ai.context.findUserId(ctx, name);
        if (uid === null) {
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        const [attr, expr] = expression.split('=');
        if (expr === undefined) {
            return `修改失败，表达式 ${expression} 格式错误`;
        }

        const value = seal.vars.intGet(ctx, attr)[0];

        const attrs = expr.split(/[\s\dDd+\-*/=]+/).filter(item => item);
        const values = attrs.map(item => seal.vars.intGet(ctx, item)[0]);

        let s = expr;
        for (let i = 0; i < attrs.length; i++) {
            s = s.replace(attrs[i], values[i].toString());
        }

        const result = parseInt(seal.format(ctx, `{${s}}`));

        if (isNaN(result)) {
            return `修改失败，表达式 ${expression} 格式化错误`;
        }

        seal.vars.intSet(ctx, attr, result);

        seal.replyToSender(ctx, msg, `进行了 ${expression} 修改\n${attr}: ${value}=>${result}`);
        return `进行了 ${expression} 修改\n${attr}: ${value}=>${result}`;
    }
}