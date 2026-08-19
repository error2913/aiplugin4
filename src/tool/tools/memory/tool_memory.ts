// 记忆工具：添加/删除/搜索/清除记忆
import { MemoryManager } from "../../../memory/manager";
import { searchOptions as SearchOptions } from "../../../memory/types";
import { getSession, SessionService } from "../../../session/session_service";
import { GroupInfo, SessionInfo, UserInfo } from "../../../session/types";
import { getCtxAndMsg } from "../../../utils/seal";
import { normalizeGroupId, normalizeUserId } from "../../../utils/target_id";
import Tool from "../../tool";

export function registerMemory() {
    const toolAdd = new Tool({
        type: 'function',
        function: {
            name: 'add_memory',
            description: '添加个人记忆或群聊记忆，尽量不要重复记忆；仅当用户明确要求记忆只在本会话中生效时才传 visibility=private，其余情况不要传（默认 public，相关会话均可读取）',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: "string",
                        description: "记忆归属，个人或群聊（决定存到哪个会话），与可见性无关。",
                        enum: ["private", "group"]
                    },
                    target_id: {
                        type: 'string',
                        description: '目标用户ID或群ID，实际使用时与记忆类型对应'
                    },
                    text: {
                        type: 'string',
                        description: '记忆内容，尽量简短，可用[img:xxxxxx]插入图片，无需附带时间与来源'
                    },
                    keywords: {
                        type: 'array',
                        description: '相关用户ID列表',
                        items: {
                            type: 'string'
                        }
                    },
                    related_user_ids: {
                        type: 'array',
                        description: '相关用户ID列表',
                        items: {
                            type: 'string'
                        }
                    },
                    related_group_ids: {
                        type: 'array',
                        description: '相关群ID列表',
                        items: {
                            type: 'string'
                        }
                    },
                    visibility: {
                        type: 'string',
                        description: '仅当用户明确要求记忆只在本会话中生效时才传 private；其余情况不要传（默认 public，相关会话均可读取）',
                        enum: ['public', 'private']
                    }
                },
                required: ['memory_type', 'target_id', 'text']
            }
        }
    });
    toolAdd.solve = async (ctx, _, session, args) => {
        const { memory_type, target_id, text, keywords = [], related_user_ids = [], related_group_ids = [], visibility = 'public' } = args;
        // 规范化可见性，避免模型传入非法枚举值
        const normalizedVisibility: 'public' | 'private' = visibility === 'private' ? 'private' : 'public';

        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        const uiList: UserInfo[] = [];
        for (const n of related_user_ids) {
            const normalizedUserId = normalizeUserId(n);
            if (normalizedUserId === null) return `相关用户ID格式无效<${n}>`;
            const ui = session.context.getUserById(normalizedUserId);
            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
        }
        const giList: GroupInfo[] = [];
        for (const n of related_group_ids) {
            const normalizedGroupId = normalizeGroupId(n);
            if (normalizedGroupId === null) return `相关群ID格式无效<${n}>`;
            const gi = session.context.getGroupById(normalizedGroupId);
            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
        }

        //记忆相关处理
        await MemoryManager.addMemory(ctx, session, uiList, giList, Array.isArray(keywords) ? keywords : [], [], text, normalizedVisibility);
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
                    target_id: {
                        type: 'string',
                        description: '目标用户ID或群ID，实际使用时与记忆类型对应'
                    },
                    id_list: {
                        type: 'array',
                        description: '记忆ID列表，可为空',
                        items: {
                            type: 'string'
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
                required: ['memory_type', 'target_id', 'id_list', 'keywords']
            }
        }
    });
    toolDel.solve = async (ctx, _, session, args) => {
        const { memory_type, target_id, id_list, keywords } = args;
        // 记录调用方会话：与 search_memory 一致，其他会话创建的私有记忆不可删除
        const callerSessionId = session.sessionId;

        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        // 受保护记忆：非调用方会话创建的私有记忆，仅创建会话可删
        const protectedIds = new Set<string>();
        if (session.sessionId !== callerSessionId) {
            for (const m of session.memory.memories) {
                if (m.visibility === 'private' && m.sessionId !== callerSessionId) protectedIds.add(m.id);
            }
        }

        // 由 id_list 与 keywords 共同确定删除范围，剔除受保护记忆（keywords 命中任一即删，与 deleteMemory 语义一致）
        const deleteIds = new Set<string>();
        for (const id of (Array.isArray(id_list) ? id_list : [])) {
            const idStr = String(id);
            if (!protectedIds.has(idStr)) deleteIds.add(idStr);
        }
        if (Array.isArray(keywords) && keywords.length > 0) {
            for (const m of session.memory.memories) {
                if (!protectedIds.has(m.id) && keywords.some(kw => m.tags.includes(kw))) deleteIds.add(m.id);
            }
        }
        if (deleteIds.size === 0) return `没有可删除的记忆`;

        // 记忆相关处理
        session.memory.deleteMemory(Array.from(deleteIds));
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
                        description: "记忆类型，个人或群聊",
                        enum: ["private", "group"]
                    },
                    target_id: {
                        type: 'string',
                        description: '目标用户ID或群ID，实际使用时与记忆类型对应'
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
                        description: '相关用户ID列表',
                        items: {
                            type: 'string'
                        }
                    },
                    related_user_ids: {
                        type: 'array',
                        description: '相关用户ID列表',
                        items: {
                            type: 'string'
                        }
                    },
                    related_group_ids: {
                        type: 'array',
                        description: '相关群ID列表',
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
                        enum: ['similarity', 'score', 'early', 'late', 'recent']
                    }
                },
                required: ['memory_type', 'target_id']
            }
        }
    });
    toolSearch.solve = async (ctx, _, session, args) => {
        const { memory_type, target_id, query = '', topK = 5, keywords = [], related_user_ids = [], related_group_ids = [], method = 'similarity' } = args;
        // 记录调用方会话：私有记忆只对创建它的会话可见，搜索其他会话时按调用方会话过滤
        const callerSessionId = session.sessionId;

        let si: SessionInfo;
        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;

            si = { isPrivate: true, id: ui.userId, name: ui.userName || ui.userId };
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;

            si = { isPrivate: false, id: gi.groupId, name: gi.groupName || gi.groupId };
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        if (session.memory.memoryIds.length === 0) return `暂无记忆`;

        const uiList: UserInfo[] = [];
        for (const n of related_user_ids) {
            const normalizedUserId = normalizeUserId(n);
            if (normalizedUserId === null) return `相关用户ID格式无效<${n}>`;
            const ui = session.context.getUserById(normalizedUserId);
            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
        }
        const giList: GroupInfo[] = [];
        for (const n of related_group_ids) {
            const normalizedGroupId = normalizeGroupId(n);
            if (normalizedGroupId === null) return `相关群ID格式无效<${n}>`;
            const gi = session.context.getGroupById(normalizedGroupId);
            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
        }

        const options: SearchOptions = {
            topK: topK,
            tags: keywords,
            users: uiList.map(u => u.id),
            groups: giList.map(g => g.id),
            relatedMemories: [],
            method: method,
            sessionId: callerSessionId
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
                    target_id: {
                        type: 'string',
                        description: '目标用户ID或群ID，实际使用时与记忆类型对应'
                    }
                },
                required: ['memory_type', 'target_id']
            }
        }
    });
    toolClear.solve = async (ctx, _, session, args) => {
        const { memory_type, target_id } = args;
        // 记录调用方会话：与 search_memory 一致，其他会话创建的私有记忆不可清除
        const callerSessionId = session.sessionId;

        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            session = getSession(ui.userId);
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id);
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            session = getSession(gi.groupId);
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        // 受保护记忆：非调用方会话创建的私有记忆，仅创建会话可删
        const protectedIds = new Set<string>();
        if (session.sessionId !== callerSessionId) {
            for (const m of session.memory.memories) {
                if (m.visibility === 'private' && m.sessionId !== callerSessionId) protectedIds.add(m.id);
            }
        }

        if (protectedIds.size > 0) {
            // 只清空调用方可访问的记忆，保留其他会话的私有记忆
            const deleteIds = session.memory.memoryIds.filter(id => !protectedIds.has(id));
            if (deleteIds.length === 0) return `无可清除的记忆（存在其他会话的私有记忆）`;
            session.memory.deleteMemory(deleteIds);
            SessionService.save(session);
            return `清除记忆成功（保留 ${protectedIds.size} 条其他会话的私有记忆）`;
        }

        session.memory.clearMemory();
        SessionService.save(session);
        return `清除记忆成功`;
    }
}
