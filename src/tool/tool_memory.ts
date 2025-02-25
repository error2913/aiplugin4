import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerAddPersonMemory() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'add_person_memory',
            description: '添加个人记忆，尽量不要重复记忆',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '用户名称' + ConfigManager.message.showQQ ? '或纯数字QQ号' : ''
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
        ai.memory.addMemory(ctx, content);
        AIManager.saveAI(uid);

        return `添加记忆成功`;
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerAddGroupMemory() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'add_group_memory',
            description: '添加群聊记忆，尽量不要重复记忆',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: '记忆内容'
                    }
                },
                required: ['content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
        const { content } = args;

        if (ctx.isPrivate) {
            console.error('不能在私聊中添加群聊记忆');
            return `不能在私聊中添加群聊记忆`;
        }

        //记忆相关处理
        ai.memory.addMemory(ctx, content);
        AIManager.saveAI(ai.id);

        return `添加记忆成功`;
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerShowPersonMemory() {
    // 如果不显示QQ号，就不注册这个函数
    if (!ConfigManager.message.showQQ) {
        return;
    }

    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'show_person_memory',
            description: '查看个人记忆',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: '纯数字QQ号'
                    }
                },
                required: ['user_id']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, _, ai, args) => {
        const { user_id } = args;

        if (isNaN(parseInt(user_id))) {
            console.error(`<${user_id}>不是一个合法的QQ号`);
            return `<${user_id}>不是一个合法的QQ号`;
        }

        const uid = `QQ:${user_id}`;

        if (uid === ctx.endPoint.userId) {
            console.error('不能查看自己的记忆');
            return `不能查看自己的记忆`;
        }

        //记忆相关处理
        ai = AIManager.getAI(uid);
        return ai.memory.buildPersonMemoryPrompt();
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerShowGroupMemory() {
    // 后续添加
}