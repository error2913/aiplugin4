import { AIManager } from "../AI/AI";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerMemory() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'memory',
            description: '添加记忆或者留下对别人印象，尽量不要重复',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称'
                    },
                    content: {
                        type: 'string',
                        description: '记忆内容'
                    }
                },
                required: ['name', 'content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { name, content } = args;

        const ext = seal.ext.find('HTTP依赖');
        if (!ext) {
            console.error(`未找到HTTP依赖`);
            return `未找到HTTP依赖，请提示用户安装HTTP依赖`;
        }

        const uid = ai.context.findUid(name);
        if (uid === null) {
            console.log(`未找到<${name}>`);
            return `未找到<${name}>`;
        }

        msg = createMsg(msg.messageType, uid, ctx.group.groupId);
        ctx = createCtx(ctx.endPoint.userId, msg);

        if (uid === ctx.endPoint.userId) {
            ctx.player.name = name;
            console.error('不能添加自己的记忆');
            return `不能添加自己的记忆`;
        }

        //记忆相关处理
        ai = AIManager.getAI(uid);
        ai.memory.addMemory(ctx.group.groupId, ctx.group.groupName, content);
        AIManager.saveAI(uid);

        return `添加记忆成功`;
    }

    ToolManager.toolMap[info.function.name] = tool;
}