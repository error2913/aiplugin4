import { AIManager } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerAddMemory() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'add_memory',
            description: '添加个人记忆或群聊记忆，尽量不要重复记忆',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: "string",
                        description: "记忆类型，个人或群聊",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : ''
                    },
                    content: {
                        type: 'string',
                        description: '记忆内容'
                    }
                },
                required: ['memory_type', 'name', 'content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name, content } = args;

        if (memory_type === "private") {
            const uid = ai.context.findUserId(ctx, name);
            if (uid === null) {
                console.log(`未找到<${name}>`);
                return `未找到<${name}>`;
            }
            if (uid === ctx.endPoint.userId) {
                return `不能添加自己的记忆`;
            }
    
            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);
    
            ai = AIManager.getAI(uid);
        } else if (memory_type === "group") {
            const gid = ai.context.findGroupId(ctx, name);
            if (gid === null) {
                console.log(`未找到<${name}>`);
                return `未找到<${name}>`;
            }
    
            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);
    
            ai = AIManager.getAI(gid);
        } else {
            return `未知的消息类型<${memory_type}>`;
        }

        //记忆相关处理
        ai.memory.addMemory(ctx, content);
        AIManager.saveAI(ai.id);

        return `添加记忆成功`;
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerShowMemory() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'show_memory',
            description: '查看个人记忆或群聊记忆',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: "string",
                        description: "记忆类型，个人或群聊",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : ''
                    }
                },
                required: ['memory_type', 'name']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name } = args;

        if (memory_type === "private") {
            const uid = ai.context.findUserId(ctx, name);
            if (uid === null) {
                console.log(`未找到<${name}>`);
                return `未找到<${name}>`;
            }
            if (uid === ctx.player.userId) {
                return `查看该用户记忆无需调用函数`;
            }
            if (uid === ctx.endPoint.userId) {
                return `不能查看自己的记忆`;
            }
    
            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);
    
            ai = AIManager.getAI(uid);
            return ai.memory.buildPersonMemoryPrompt();
        } else if (memory_type === "group") {
            const gid = ai.context.findGroupId(ctx, name);
            if (gid === null) {
                console.log(`未找到<${name}>`);
                return `未找到<${name}>`;
            }
            if (gid === ctx.group.groupId) {
                return `查看当前群聊记忆无需调用函数`;
            }
    
            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);
    
            ai = AIManager.getAI(gid);
            return ai.memory.buildGroupMemoryPrompt();
        } else {
            return `未知的消息类型<${memory_type}>`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}