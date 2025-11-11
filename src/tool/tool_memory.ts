import { AIManager, GroupInfo, SessionInfo, UserInfo } from "../AI/AI";
import { ConfigManager } from "../config/config";
import { createMsg, createCtx } from "../utils/utils_seal";
import { Tool } from "./tool";
import { knowledgeMM, searchOptions as SearchOptions } from "../AI/memory";

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
                    userList: {
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
                required: ['memory_type', 'name', 'text']
            }
        }
    });
    toolAdd.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name, text, keywords = [], userList = [], groupList = [] } = args;

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
                    isPrivate: true,
                    id: uid,
                    name: n
                });
            }
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gid = await ai.context.findGroupId(ctx, n);
            if (gid !== null) {
                giList.push({
                    isPrivate: false,
                    id: gid,
                    name: n
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
        ai.memory.deleteMemory(id_list, keywords);
        AIManager.saveAI(ai.id);

        return { content: `删除记忆成功`, images: [] };
    }

    const toolSearch = new Tool({
        type: 'function',
        function: {
            name: 'search_memory',
            description: '搜索个人记忆或群聊记忆',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: "string",
                        description: "记忆类型，个人或群聊或知识库，选择知识库时不用填写name",
                        enum: ["private", "group", "knowledge"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与记忆类型对应'
                    },
                    query: {
                        type: 'string',
                        description: '搜索查询，为空时返回权重靠前的记忆'
                    },
                    topK: {
                        type: 'number',
                        description: '返回记忆条数，默认5条'
                    },
                    keywords: {
                        type: 'array',
                        description: '相关用户名称列表',
                        items: {
                            type: 'string'
                        }
                    },
                    userList: {
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
                    },
                    includeImages: {
                        type: 'boolean',
                        description: '是否包含图片'
                    },
                    method: {
                        type: 'string',
                        description: '搜索方法，默认score',
                        enum: ['weight', 'similarity', 'score']
                    }
                },
                required: ['memory_type']
            }
        }
    });
    toolSearch.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name = '', query = '', topK = 5, keywords = [], userList = [], groupList = [], includeImages = false, method = 'score' } = args;

        let si: SessionInfo = {
            isPrivate: false,
            id: '',
            name: ''
        };
        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg('private', uid, '');
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(uid);
            si = {
                isPrivate: true,
                id: uid,
                name: name
            }
        } else if (memory_type === "group") {
            const gid = await ai.context.findGroupId(ctx, name);
            if (gid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg('group', ctx.player.userId, gid);
            ctx = createCtx(ctx.endPoint.userId, msg);

            ai = AIManager.getAI(gid);
            si = {
                isPrivate: false,
                id: gid,
                name: name
            }
        } else if (memory_type === "knowledge") {
            const giList: GroupInfo[] = [];
            for (const n of groupList) {
                const gid = await ai.context.findGroupId(ctx, n);
                if (gid !== null) {
                    giList.push({
                        isPrivate: false,
                        id: gid,
                        name: n
                    });
                }
            }

            const options: SearchOptions = {
                topK: topK,
                keywords: keywords,
                userList: userList,
                groupList: groupList,
                includeImages: includeImages,
                method: method
            }

            const { roleSettingNames, roleSettingTemplate } = ConfigManager.message;
            const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
            let roleIndex = 0;
            if (exists && roleName !== '' && roleSettingNames.includes(roleName)) {
                roleIndex = roleSettingNames.indexOf(roleName);
                if (roleIndex < 0 || roleIndex >= roleSettingTemplate.length) roleIndex = 0;
            } else {
                const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
                if (exists2 && roleIndex2 >= 0 && roleIndex2 < roleSettingTemplate.length) roleIndex = roleIndex2;
            }
            await knowledgeMM.updateKnowledgeMemory(roleIndex);
            if (knowledgeMM.memoryIds.length === 0) return { content: `暂无记忆`, images: [] };

            const memoryList = await knowledgeMM.search(query, options);
            const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));

            return { content: knowledgeMM.buildKnowledgeMemory(memoryList) || '暂无记忆', images: images };
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }

        if (ai.memory.memoryIds.length === 0) return { content: `暂无记忆`, images: [] };

        const uiList: UserInfo[] = [];
        for (const n of userList) {
            const uid = await ai.context.findUserId(ctx, n, true);
            if (uid !== null) {
                uiList.push({
                    isPrivate: true,
                    id: uid,
                    name: n
                });
            }
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gid = await ai.context.findGroupId(ctx, n);
            if (gid !== null) {
                giList.push({
                    isPrivate: false,
                    id: gid,
                    name: n
                });
            }
        }

        const options: SearchOptions = {
            topK: topK,
            keywords: keywords,
            userList: userList,
            groupList: groupList,
            includeImages: includeImages,
            method: method
        }

        const memoryList = await ai.memory.search(query, options);
        const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));

        return { content: ai.memory.buildMemory(si, memoryList) || '暂无记忆', images: images };
    }

    const toolClear = new Tool({
        type: 'function',
        function: {
            name: 'clear_memory',
            description: '清除个人记忆或群聊记忆',
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
    toolClear.solve = async (ctx, msg, ai, args) => {
        const { memory_type, name } = args;

        if (memory_type === "private") {
            const uid = await ai.context.findUserId(ctx, name, true);
            if (uid === null) {
                return { content: `未找到<${name}>`, images: [] };
            }

            msg = createMsg('private', uid, '');
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


        ai.memory.clearMemory();
        AIManager.saveAI(ai.id);
        return { content: `清除记忆成功`, images: [] };
    }
}