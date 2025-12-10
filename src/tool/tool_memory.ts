import { AIManager, GroupInfo, SessionInfo, UserInfo } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { getCtxAndMsg } from "../utils/utils_seal";
import { Tool } from "./tool";
import { knowledgeMM, searchOptions as SearchOptions } from "../AI/memory";
import { getRoleSetting } from "../utils/utils_message";

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
                        description: '记忆内容，尽量简短，可用<|img:xxxxxx|>插入图片，无需附带时间与来源'
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
    toolAdd.solve = async (ctx, _, ai, args) => {
        const { memory_type, name, text, keywords = [], userList = [], groupList = [] } = args;

        if (memory_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (memory_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }

        const uiList: UserInfo[] = [];
        for (const n of userList) {
            const ui = await ai.context.findUserInfo(ctx, n, true);
            if (ui !== null) uiList.push(ui);
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gi = await ai.context.findGroupInfo(ctx, n);
            if (gi !== null) giList.push(gi);
        }

        //记忆相关处理
        await ai.memory.addMemory(ctx, ai, uiList, giList, Array.isArray(keywords) ? keywords : [], [], text);
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
    toolDel.solve = async (ctx, _, ai, args) => {
        const { memory_type, name, id_list, keywords } = args;

        if (memory_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (memory_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
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
                        description: '搜索方法，默认similarity',
                        enum: ['weight', 'similarity', 'score', 'early', 'late', 'recent']
                    }
                },
                required: ['memory_type']
            }
        }
    });
    toolSearch.solve = async (ctx, _, ai, args) => {
        const { memory_type, name = '', query = '', topK = 5, keywords = [], userList = [], groupList = [], includeImages = false, method = 'similarity' } = args;

        let si: SessionInfo = {
            isPrivate: false,
            id: '',
            name: ''
        };
        if (memory_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (memory_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
        } else if (memory_type === "knowledge") {
            const giList: GroupInfo[] = [];
            for (const n of groupList) {
                const gi = await ai.context.findGroupInfo(ctx, n);
                if (gi !== null) giList.push(gi);
            }

            const options: SearchOptions = {
                topK: topK,
                keywords: keywords,
                userList: userList,
                groupList: groupList,
                includeImages: includeImages,
                method: method
            }

            const { roleIndex } = getRoleSetting(ctx);
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
            const ui = await ai.context.findUserInfo(ctx, n, true);
            if (ui !== null) uiList.push(ui);
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gi = await ai.context.findGroupInfo(ctx, n);
            if (gi !== null) giList.push(gi);
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
    toolClear.solve = async (ctx, _, ai, args) => {
        const { memory_type, name } = args;

        if (memory_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (memory_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }

        ai.memory.clearMemory();
        AIManager.saveAI(ai.id);
        return { content: `清除记忆成功`, images: [] };
    }
}