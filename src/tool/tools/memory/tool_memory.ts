// 记忆工具：添加/更新/删除/搜索/清除记忆
import Config from "../../../config/config";
import { MemoryManager } from "../../../memory/manager";
import { bumpMemoryRevision } from "../../../memory/revision";
import { resolveTargetSession } from "../../../memory/session_target";
import { resolveBankId } from "../../../memory/v2/bank_resolver";
import { getMemoryEngine } from "../../../memory/v2/index";
import type { RecallOptions } from "../../../memory/v2/types";
import { SessionService } from "../../../session/session_service";
import { GroupInfo, SessionInfo, UserInfo } from "../../../session/types";
import { getCtxAndMsg } from "../../../utils/seal";
import { stripInternalTags } from "../../../utils/string";
import { normalizeGroupId, normalizeUserId, platformOf } from "../../../utils/target_id";
import Tool from "../../tool";

export function registerMemory() {
    const toolAdd = new Tool({
        type: 'function',
        function: {
            name: 'memory_add',
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
                        description: '记忆关键词/标签列表，便于检索与删除定位',
                        items: {
                            type: 'string'
                        }
                    },
                    related_user_ids: {
                        type: 'array',
                        description: '相关用户ID列表（与记忆有关联的用户）',
                        items: {
                            type: 'string'
                        }
                    },
                    related_group_ids: {
                        type: 'array',
                        description: '相关群ID列表（与记忆有关联的群）',
                        items: {
                            type: 'string'
                        }
                    },
                    type: {
                        type: 'string',
                        description: '记忆类型：fact（事实/偏好/属性）、rule（规则/群规/指令）、relation（人物关系）、event（事件），默认 text',
                        enum: ['text', 'fact', 'rule', 'relation', 'event']
                    },
                    importance: {
                        type: 'number',
                        description: '重要性 0-1，默认 0.5；对角色塑造/长期关系重要给高分',
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
        const { memory_type, target_id, text, keywords = [], related_user_ids = [], related_group_ids = [], visibility = 'public', type, importance } = args;
        // 规范化可见性，避免模型传入非法枚举值
        const normalizedVisibility: 'public' | 'private' = visibility === 'private' ? 'private' : 'public';

        if (memory_type === "private" || memory_type === "group") {
            const target = resolveTargetSession(session, memory_type, target_id);
            if (!target) return `目标ID格式无效<${target_id}>`;
            if (memory_type === "private") {
                const normalizedTargetId = normalizeUserId(target_id, platformOf(ctx));
                if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
                const ui = session.context.getUserById(normalizedTargetId);
                if (ui === null) return `未找到目标ID<${target_id}>`;
                ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
            } else {
                const normalizedTargetId = normalizeGroupId(target_id, platformOf(ctx));
                if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
                const gi = session.context.getGroupById(normalizedTargetId);
                if (gi === null) return `未找到目标ID<${target_id}>`;
                ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
            }
            session = target;
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }

        const uiList: UserInfo[] = [];
        for (const n of related_user_ids) {
            const normalizedUserId = normalizeUserId(n, platformOf(ctx));
            if (normalizedUserId === null) return `相关用户ID格式无效<${n}>`;
            const ui = session.context.getUserById(normalizedUserId);
            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
        }
        const giList: GroupInfo[] = [];
        for (const n of related_group_ids) {
            const normalizedGroupId = normalizeGroupId(n, platformOf(ctx));
            if (normalizedGroupId === null) return `相关群ID格式无效<${n}>`;
            const gi = session.context.getGroupById(normalizedGroupId);
            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
        }

        //记忆相关处理
        const result = await MemoryManager.retainMemory(ctx, session, uiList, giList, Array.isArray(keywords) ? keywords : [], [], text, normalizedVisibility, type, importance);
        SessionService.save(session);

        const id = result.unitIds[0];
        if (result && result.action === 'merged') return `记忆已存在，已合并到<${id}>`;
        return id ? `添加记忆成功<${id}>` : `添加记忆成功`;
    }

    const toolDel = new Tool({
        type: 'function',
        function: {
            name: 'memory_delete',
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
        // 记录调用方会话：其他会话的记忆（含 public）不可由本会话删除，防止越权
        const callerSessionId = session.sessionId;

        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id, platformOf(ctx));
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id, platformOf(ctx));
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }
        session = target;

        // 受保护记忆：目标会话与调用方会话不一致时，全部记忆仅归属会话可删（避免跨会话越权删除）
        const protectedIds = new Set<string>();
        if (session.sessionId !== callerSessionId) {
            for (const m of session.memory.memories) {
                protectedIds.add(m.id);
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
        if (deleteIds.size === 0) return `没有可删除的记忆${protectedIds.size > 0 ? '（目标会话与当前会话不一致，仅可在该会话内删除）' : ''}`;

        // 记忆相关处理
        session.memory.deleteMemory(Array.from(deleteIds));
        SessionService.save(session);

        return `删除记忆成功`;
    }

    const toolSearch = new Tool({
        type: 'function',
        function: {
            name: 'memory_recall',
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
                        description: '记忆关键词/标签过滤，命中任一标签才返回',
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
        const { memory_type, target_id, query = '', topK = 5, keywords = [], related_user_ids = [], related_group_ids = [], method: _method = 'similarity' } = args;
        // 记录调用方会话：私有记忆只对创建它的会话可见，搜索其他会话时按调用方会话过滤
        const callerSessionId = session.sessionId;

        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        let si: SessionInfo | null = null;
        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id, platformOf(ctx));
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;
            si = { isPrivate: true, id: ui.userId, name: ui.userName || ui.userId };
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id, platformOf(ctx));
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;
            si = { isPrivate: false, id: gi.groupId, name: gi.groupName || gi.groupId };
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }
        session = target;

        if (session.memory.memoryIds.length === 0) return `暂无记忆`;

        const uiList: UserInfo[] = [];
        for (const n of related_user_ids) {
            const normalizedUserId = normalizeUserId(n, platformOf(ctx));
            if (normalizedUserId === null) return `相关用户ID格式无效<${n}>`;
            const ui = session.context.getUserById(normalizedUserId);
            if (ui !== null) uiList.push({ isPrivate: true, id: ui.userId, name: ui.userName });
        }
        const giList: GroupInfo[] = [];
        for (const n of related_group_ids) {
            const normalizedGroupId = normalizeGroupId(n, platformOf(ctx));
            if (normalizedGroupId === null) return `相关群ID格式无效<${n}>`;
            const gi = session.context.getGroupById(normalizedGroupId);
            if (gi !== null) giList.push({ isPrivate: false, id: gi.groupId, name: gi.groupName });
        }

        const options: Partial<RecallOptions> & { sessionId?: string } = {
            tags: keywords,
            maxTokens: topK * 200,
            sessionId: callerSessionId
        }

        const memoryList = await session.memory.recallMemory(query, options);
        return session.memory.buildMemory(si, memoryList) || '暂无记忆';
    }

    const toolClear = new Tool({
        type: 'function',
        function: {
            name: 'memory_clear',
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
        // 记录调用方会话：目标会话与调用方不一致时不可清除（防止越权）
        const callerSessionId = session.sessionId;

        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        if (memory_type === "private") {
            const normalizedTargetId = normalizeUserId(target_id, platformOf(ctx));
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const ui = session.context.getUserById(normalizedTargetId);
            if (ui === null) return `未找到目标ID<${target_id}>`;
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.userId, ''));
        } else if (memory_type === "group") {
            const normalizedTargetId = normalizeGroupId(target_id, platformOf(ctx));
            if (normalizedTargetId === null) return `目标ID格式无效<${target_id}>`;
            const gi = session.context.getGroupById(normalizedTargetId);
            if (gi === null) return `未找到目标ID<${target_id}>`;
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.groupId));
        } else {
            return `未知的记忆类型<${memory_type}>`;
        }
        session = target;

        // 受保护记忆：目标会话与调用方会话不一致时，全部记忆不可清除（仅归属会话可管理）
        const protectedIds = new Set<string>();
        if (session.sessionId !== callerSessionId) {
            for (const m of session.memory.memories) {
                protectedIds.add(m.id);
            }
        }

        if (protectedIds.size > 0) {
            // 只清空调用方可访问的记忆，保留其他会话的记忆
            const deleteIds = session.memory.memoryIds.filter(id => !protectedIds.has(id));
            if (deleteIds.length === 0) return `无可清除的记忆（目标会话与当前会话不一致，仅可在该会话内清除）`;
            session.memory.deleteMemory(deleteIds);
            SessionService.save(session);
            return `清除记忆成功（保留 ${protectedIds.size} 条其他会话的记忆）`;
        }

        session.memory.clearMemory();
        SessionService.save(session);
        return `清除记忆成功`;
    }

    const toolUpdate = new Tool({
        type: 'function',
        function: {
            name: 'memory_update',
            description: '更新一条已有记忆的内容/标签/重要性（按 ID 定位）。仅可更新本会话相关记忆，其他会话的私有记忆不可更新；发现记错了请用它修正而不是删除重加',
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
                    id: {
                        type: 'string',
                        description: '要更新的记忆ID（来自记忆列表或 search_memory 结果）'
                    },
                    text: {
                        type: 'string',
                        description: '新的记忆内容（不传则保留原内容）'
                    },
                    keywords: {
                        type: 'array',
                        description: '要追加的记忆关键词/标签',
                        items: {
                            type: 'string'
                        }
                    },
                    importance: {
                        type: 'number',
                        description: '重要性 0-1：对角色塑造/长期关系重要给高分（≥0.8 常驻注入），日常琐事给低分'
                    }
                },
                required: ['memory_type', 'target_id', 'id']
            }
        }
    });
    toolUpdate.solve = async (_ctx, _, session, args) => {
        const { memory_type, target_id, id, text, keywords, importance } = args;
        const callerSessionId = session.sessionId;

        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        const bankId = resolveBankId(target.sessionId, target.sessionType === 'group' ? 'group' : 'user', target.agentName).bankId;
        const unit = getMemoryEngine().repository.getUnit(bankId, String(id));
        if (!unit) return `未找到记忆<${id}>`;

        // 保护：其他会话的私有记忆不可更新
        if (target.sessionId !== callerSessionId && unit.tags.includes(`vis:private:${callerSessionId}`)) {
            return `无权更新其他会话的私有记忆<${id}>`;
        }

        if (typeof text === 'string' && text.trim()) {
            unit.text = stripInternalTags(text.trim());
        }
        if (Array.isArray(keywords)) {
            unit.tags = Array.from(new Set([...unit.tags, ...keywords.map(String)]));
        }
        if (typeof importance === 'number') {
            unit.importance = Math.min(1, Math.max(0, importance));
        }
        unit.lastAccessedAt = Math.floor(Date.now() / 1000);
        unit.updatedAt = unit.lastAccessedAt;

        // 更新后如果与另一条有效记忆内容完全相同，则合并到已有记忆，避免“同内容两条”
        if (typeof text === 'string' && text.trim()) {
            const normalized = text.replace(/\s+/g, '').toLowerCase();
            const duplicate = getMemoryEngine().repository.listUnits(bankId).find(u =>
                u.id !== unit.id && u.state === 'valid' && u.text.replace(/\s+/g, '').toLowerCase() === normalized
            );
            if (duplicate) {
                duplicate.tags = Array.from(new Set([...duplicate.tags, ...unit.tags]));
                duplicate.importance = Math.max(duplicate.importance, unit.importance);
                getMemoryEngine().repository.updateUnit(bankId, duplicate);
                unit.state = 'invalidated';
                getMemoryEngine().repository.updateUnit(bankId, unit);
                bumpMemoryRevision();
                SessionService.save(target);
                return `记忆已更新并合并到<${duplicate.id}>`;
            }
        }

        getMemoryEngine().repository.updateUnit(bankId, unit);
        bumpMemoryRevision();
        SessionService.save(target);
        return `记忆已更新<${unit.id}>`;
    }

    const toolConsolidate = new Tool({
        type: 'function',
        function: {
            name: 'memory_consolidate',
            description: '触发指定个人或群聊记忆的观察巩固，把已有事实合并生成观察记忆',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: 'string',
                        description: '记忆归属，个人或群聊',
                        enum: ['private', 'group']
                    },
                    target_id: {
                        type: 'string',
                        description: '目标用户ID或群ID'
                    }
                },
                required: ['memory_type', 'target_id']
            }
        }
    });
    toolConsolidate.solve = async (_ctx, _, session, args) => {
        const { memory_type, target_id } = args;
        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        const bank = resolveBankId(target.sessionId, target.sessionType === 'group' ? 'group' : 'user', target.agentName);
        const result = await getMemoryEngine().consolidate(bank.bankId);
        // R2：巩固后自动刷新心智模型（引擎层防重入 + 最小间隔限流）
        let refreshText = '';
        if (Config.memory.MEMORY_REFRESH_AFTER_CONSOLIDATE) {
            const refreshed = await getMemoryEngine().refreshMentalModels(bank.bankId);
            refreshText = `，刷新心智模型 ${refreshed} 条`;
        }
        SessionService.save(target);
        return `观察巩固完成：新建 ${result.created.length} 条，更新 ${result.updated.length} 条，合并 ${result.merged.length} 条${refreshText}`;
    };


    const toolMmCreate = new Tool({
        type: 'function',
        function: {
            name: 'memory_mm_create',
            description: '为指定个人或群聊创建心智模型：给一个问题，基于该会话现有记忆自动推理生成答案并保存；心智模型是长期注入的高层结论（如用户偏好、群规则）',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: { type: 'string', description: '记忆归属，个人或群聊', enum: ['private', 'group'] },
                    target_id: { type: 'string', description: '目标用户ID或群ID' },
                    question: { type: 'string', description: '心智模型要回答的问题，如“这个用户的偏好是什么？”' },
                    answer: { type: 'string', description: '可选：直接给出的答案；不传时自动基于记忆推理' },
                    scope_tag: { type: 'string', description: '可选：作用域标签，默认 user:<目标> 或 group:<目标>，如 user:QQ:123' }
                },
                required: ['memory_type', 'target_id', 'question']
            }
        }
    });
    toolMmCreate.solve = async (_ctx, _, session, args) => {
        const { memory_type, target_id, question, answer, scope_tag } = args;
        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        const bank = resolveBankId(target.sessionId, target.sessionType === 'group' ? 'group' : 'user', target.agentName);
        getMemoryEngine().ensureBank(bank.bankId, bank.kind, bank.agentName);
        const defaultTag = target.sessionType === 'group' ? `group:${target.sessionId}` : `user:${target.sessionId}`;
        const scopeTags = typeof scope_tag === 'string' && scope_tag.trim() ? [scope_tag.trim()] : [defaultTag];
        if (typeof answer === 'string' && answer.trim()) {
            const m = await getMemoryEngine().createMentalModel(bank.bankId, String(question || ''), stripInternalTags(answer.trim()), scopeTags);
            bumpMemoryRevision();
            SessionService.save(target);
            return `心智模型已创建<${m.id}>：${m.question} => ${m.answer.slice(0, 200)}`;
        }
        const result = await getMemoryEngine().reflect(bank.bankId, String(question || ''));
        const m = await getMemoryEngine().createMentalModel(bank.bankId, String(question || ''), result.text, scopeTags);
        bumpMemoryRevision();
        SessionService.save(target);
        return `心智模型已创建<${m.id}>（基于记忆推理）\n问题: ${m.question}\n答案: ${result.text}`;
    };

    const toolMmRefresh = new Tool({
        type: 'function',
        function: {
            name: 'memory_mm_refresh',
            description: '刷新指定个人或群聊的心智模型：基于当前最新记忆重新推理；不传 model_id 时刷新全部，返回实际更新条数',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: { type: 'string', description: '记忆归属，个人或群聊', enum: ['private', 'group'] },
                    target_id: { type: 'string', description: '目标用户ID或群ID' },
                    model_id: { type: 'string', description: '可选：要刷新的心智模型 ID，不传则刷新全部' }
                },
                required: ['memory_type', 'target_id']
            }
        }
    });
    toolMmRefresh.solve = async (_ctx, _, session, args) => {
        const { memory_type, target_id, model_id } = args;
        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        const bank = resolveBankId(target.sessionId, target.sessionType === 'group' ? 'group' : 'user', target.agentName);
        const engine = getMemoryEngine();
        if (model_id) {
            const exists = engine.listMentalModels(bank.bankId).some(m => m.id === model_id);
            if (!exists) return `未找到心智模型<${model_id}>`;
        }
        const total = model_id ? 1 : engine.listMentalModels(bank.bankId).length;
        const updated = await engine.refreshMentalModels(bank.bankId, model_id ? String(model_id) : undefined, { force: true });
        if (updated > 0) bumpMemoryRevision();
        SessionService.save(target);
        return `心智模型刷新完成：更新 ${updated} 条，跳过 ${total - updated} 条`;
    };

    const toolMmDelete = new Tool({
        type: 'function',
        function: {
            name: 'memory_mm_delete',
            description: '删除指定个人或群聊的一条心智模型',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: { type: 'string', description: '记忆归属，个人或群聊', enum: ['private', 'group'] },
                    target_id: { type: 'string', description: '目标用户ID或群ID' },
                    model_id: { type: 'string', description: '要删除的心智模型 ID' }
                },
                required: ['memory_type', 'target_id', 'model_id']
            }
        }
    });
    toolMmDelete.solve = async (_ctx, _, session, args) => {
        const { memory_type, target_id, model_id } = args;
        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        const bank = resolveBankId(target.sessionId, target.sessionType === 'group' ? 'group' : 'user', target.agentName);
        const ok = getMemoryEngine().deleteMentalModel(bank.bankId, String(model_id));
        if (!ok) return `未找到心智模型<${model_id}>`;
        bumpMemoryRevision();
        SessionService.save(target);
        return `心智模型已删除<${model_id}>`;
    };

    const toolReflect = new Tool({
        type: 'function',
        function: {
            name: 'memory_reflect',
            description: '基于指定个人或群聊记忆进行推理，返回心智模型、观察记忆和事实证据的汇总回答',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: 'string',
                        description: '记忆归属，个人或群聊',
                        enum: ['private', 'group']
                    },
                    target_id: {
                        type: 'string',
                        description: '目标用户ID或群ID'
                    },
                    query: {
                        type: 'string',
                        description: '要推理的问题'
                    }
                },
                required: ['memory_type', 'target_id', 'query']
            }
        }
    });
    toolReflect.solve = async (_ctx, _, session, args) => {
        const { memory_type, target_id, query } = args;
        const target = resolveTargetSession(session, memory_type, target_id);
        if (!target) return `目标ID格式无效<${target_id}>`;
        const bank = resolveBankId(target.sessionId, target.sessionType === 'group' ? 'group' : 'user', target.agentName);
        const result = await getMemoryEngine().reflect(bank.bankId, String(query || ''));
        return result.text;
    };

}



