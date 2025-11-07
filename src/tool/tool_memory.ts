import { AIManager } from "../AI/AI";
import { GroupInfo, UserInfo } from "../AI/context";
import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool } from "./tool";

export function registerMemory() {
    const toolAdd = new Tool({
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
                        description: '目标用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与记忆类型对应'
                    },
                    text: {
                        type: 'string',
                        description: '记忆内容，尽量简短，无需附带时间与来源'
                    },
                    keywords: {
                        type: 'array',
                        description: '相关用户名称列表',
                        items: {
                            type: 'string'
                        }
                    },
                    groupList: {
                        type: 'array',
                        description: '相关群聊名称列表',
                        items: {
                            type: 'string'
                        }
                    }
                },
                required: ['memory_type', 'name', 'text', 'keywords']
            }
        }
    });
    toolAdd.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name, text, keywords, userList = [], groupList = [] } = args;

        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg(msg.messageType, uid, ctx.group.groupId);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }

        const uiList: UserInfo[] = [];
        for (const n of userList) {
            const uid = await ai.context.findUserId(ctx, n, true);
            if (uid !== null) {
                uiList.push({
                    userId: uid,
                    name: n
                });
            }
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gid = await ai.context.findGroupId(ctx, n);
            if (gid !== null) {
                giList.push({
                    groupId: gid,
                    groupName: n
                });
            }
        }

        //记忆相关处理
        await ai.memory.addMemory(ctx, ai, uiList, giList, Array.isArray(keywords) ? keywords : [], text);
        AIManager.saveAI(ai.id);

        return { content: `添加记忆成功`, images: [] };
    }

    const toolDel = new Tool({
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
                    id_list: {
                        type: 'array',
                        description: '记忆ID列表，可为空',
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
                required: ['memory_type', 'name', 'id_list', 'keywords']
            }
        }
    });
    toolDel.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name, id_list, keywords } = args;

        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg(msg.messageType, uid, ctx.group.groupId);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }

        //记忆相关处理
        ai.memory.delMemory(id_list, keywords);
        AIManager.saveAI(ai.id);

        return { content: `删除记忆成功`, images: [] };
    }

    const toolShow = new Tool({
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
    });
    toolShow.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name } = args;

        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }
            if (uid === ctx.player.userId) {
                return { content: `查看该用户记忆无需调用函数`, images: [] };
            }

            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
            return {
                content: await ai.memory.buildMemory({
                    isPrivate: true,
                    sessionName: ctx.player.name,
                    sessionId: ctx.player.userId
                }, ''), images: []
            };
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }
            if (gid === ctx.group.groupId) {
                return { content: `查看当前群聊记忆无需调用函数`, images: [] };
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
            return {
                content: await ai.memory.buildMemory({
                    isPrivate: false,
                    sessionName: ctx.group.groupName,
                    sessionId: ctx.group.groupId
                }, ''), images: []
            };
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }
    }
}