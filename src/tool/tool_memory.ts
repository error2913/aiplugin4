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
                        description: "记忆类型，个人或群聊。",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与记忆类型对应'
                    },
                    keywords: {
                        type: 'array',
                        description: '记忆关键词',
                        items: {
                            type: 'string'
                        }
                    },
                    content: {
                        type: 'string',
                        description: '记忆内容，尽量简短，无需附带时间与来源'
                    }
                },
                required: ['memory_type', 'name', 'keywords', 'content']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name, keywords, content } = args;

        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return `未找到<${name}>`;
            }

            msg = createMsg(msg.messageType, uid, ctx.group.groupId);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return `未找到<${name}>`;
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        //记忆相关处理
        ai.memory.addMemory(ctx, Array.isArray(keywords) ? keywords : [], content);
        AIManager.saveAI(ai.id);

        return `添加记忆成功`;
    }

    ToolManager.toolMap[info.function.name] = tool;
}

export function registerDelMemory() {
    const info: ToolInfo = {
        type: 'function',
        function: {
            name: 'del_memory',
            description: '删除个人记忆或群聊记忆',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: "string",
                        description: "记忆类型，个人或群聊。",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与记忆类型对应'
                    },
                    index_list: {
                        type: 'array',
                        description: '记忆序号列表，可为空',
                        items: {
                            type: 'integer'
                        }
                    },
                    keywords: {
                        type: 'array',
                        description: '记忆关键词，可为空',
                        items: {
                            type: 'string'
                        }
                    }
                },
                required: ['memory_type', 'name', 'index_list', 'keywords']
            }
        }
    }

    const tool = new Tool(info);
    tool.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name, index_list, keywords } = args;

        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return `未找到<${name}>`;
            }

            msg = createMsg(msg.messageType, uid, ctx.group.groupId);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return `未找到<${name}>`;
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        //记忆相关处理
        ai.memory.delMemory(index_list, keywords);
        AIManager.saveAI(ai.id);

        return `删除记忆成功`;
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
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与记忆类型对应'
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
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return `未找到<${name}>`;
            }
            if (uid === ctx.player.userId) {
                return `查看该用户记忆无需调用函数`;
            }

            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
            return ai.memory.buildMemory(true, ctx.player.name, ctx.player.userId, '', '');
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return `未找到<${name}>`;
            }
            if (gid === ctx.group.groupId) {
                return `查看当前群聊记忆无需调用函数`;
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
            return ai.memory.buildMemory(false, '', '', ctx.group.groupName, ctx.group.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }
    }

    ToolManager.toolMap[info.function.name] = tool;
}