// 记忆工具：添加/删除/搜索/清除记忆（含知识库）
import { knowledgeService } from "../../../memory/knowledge";
import { MemoryManager } from "../../../memory/manager";
import { searchOptions as SearchOptions } from "../../../memory/types";
import { getSession, SessionService } from "../../../session/session_service";
import { GroupInfo, SessionInfo, UserInfo } from "../../../session/types";
import { getRoleSetting } from "../../../utils/message";
import { getCtxAndMsg } from "../../../utils/seal";
import Tool from "../../tool";

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
                        description: '目标用户名称或群聊名称或纯数字QQ号、群号，实际使用时与记忆类型对应'
                    },
                    text: {
                        type: 'string',
                        description: '记忆内容，尽量简短，可用[img:xxxxxx]插入图片，无需附带时间与来源'
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
    toolAdd.solve = async (ctx, _, session, args) => {
        const { memory_type, name, text, keywords = [], userList = [], groupList = [] } = args;

        if (memory_type === "private") {
            const ui = await session.context.findUser(ctx, name, true);
            if (ui === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const gi = await session.context.findGroup(ctx, name);
            if (gi === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        const uiList: UserInfo[] = [];
        for (const n of userList) {
            const ui = await session.context.findUser(ctx, n, true);
            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gi = await session.context.findGroup(ctx, n);
            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
        }

        //记忆相关处理
        await MemoryManager.addMemory(ctx, session, uiList, giList, Array.isArray(keywords) ? keywords : [], [], text);
        SessionService.save(session);

        return `添加记忆成功`;
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
                        description: '用户名称或群聊名称或纯数字QQ号、群号，实际使用时与记忆类型对应'
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
    toolDel.solve = async (ctx, _, session, args) => {
        const { memory_type, name, id_list, keywords } = args;

        if (memory_type === "private") {
            const ui = await session.context.findUser(ctx, name, true);
            if (ui === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const gi = await session.context.findGroup(ctx, name);
            if (gi === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        //记忆相关处理
        session.memory.deleteMemory(id_list, keywords);
        SessionService.save(session);

        return `删除记忆成功`;
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
                        description: '用户名称或群聊名称或纯数字QQ号、群号，实际使用时与记忆类型对应'
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
    toolSearch.solve = async (ctx, _, session, args) => {
        const { memory_type, name = '', query = '', topK = 5, keywords = [], userList = [], groupList = [], method = 'similarity' } = args;

        const si: SessionInfo = {
            isPrivate: false,
            id: '',
            name: ''
        };
        if (memory_type === "private") {
            const ui = await session.context.findUser(ctx, name, true);
            if (ui === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const gi = await session.context.findGroup(ctx, name);
            if (gi === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else if (memory_type === "knowledge") {
            const giList: GroupInfo[] = [];
            for (const n of groupList) {
                const gi = await session.context.findGroup(ctx, n);
                if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
            }
            const uiList: UserInfo[] = [];
            for (const n of userList) {
                const ui = await session.context.findUser(ctx, n, true);
                if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
            }

            const options: SearchOptions = {
                topK: topK,
                tags: keywords,
                users: uiList.map(u => u.id),
                groups: giList.map(g => g.id),
                relatedMemories: [],
                method: method
            }

            const { roleIndex } = getRoleSetting(ctx);
            await knowledgeService.updateKnowledgeMemory(roleIndex);
            if (knowledgeService.memoryIdList.length === 0) return `暂无记忆`;

            const memoryList = await knowledgeService.search(query, options);
            return knowledgeService.buildKnowledgeMemory(memoryList) || '暂无记忆';
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        if (session.memory.memoryIds.length === 0) return `暂无记忆`;

        const uiList: UserInfo[] = [];
        for (const n of userList) {
            const ui = await session.context.findUser(ctx, n, true);
            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gi = await session.context.findGroup(ctx, n);
            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
        }

        const options: SearchOptions = {
            topK: topK,
            tags: keywords,
            users: uiList.map(u => u.id),
            groups: giList.map(g => g.id),
            relatedMemories: [],
            method: method
        }

        const memoryList = await session.memory.search(query, options);
        return session.memory.buildMemory(si, memoryList) || '暂无记忆';
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
                        description: '用户名称或群聊名称或纯数字QQ号、群号，实际使用时与记忆类型对应'
                    }
                },
                required: ['memory_type', 'name']
            }
        }
    });
    toolClear.solve = async (ctx, _, session, args) => {
        const { memory_type, name } = args;

        if (memory_type === "private") {
            const ui = await session.context.findUser(ctx, name, true);
            if (ui === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const gi = await session.context.findGroup(ctx, name);
            if (gi === null) return `未找到<${name}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        session.memory.clearMemory();
        SessionService.save(session);
        return `清除记忆成功`;
    }
}
