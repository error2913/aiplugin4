// 记忆工具（7 个）：recall / add / update / delete / consolidate / reflect / mental_model。
// 所有工具只调 MemoryService；权限/可见性由服务层裁定。
import { MemoryScheduler } from "../../../agent/memory_scheduler";
import { PRIVILEGE_LEVEL_MAP } from "../../../config/static_config";
import { bumpMemoryRevision, bumpSummaryRevision } from "../../../memory/revision";
import { MemoryService } from "../../../memory/service";
import type { Session } from "../../../session/session";
import Tool from "../../tool";

function currentBank(session: Session): { bankId: string; kind: 'user' | 'group' } {
    const kind = session.sessionType === 'group' ? 'group' : 'user';
    return { bankId: MemoryService.bankIdForSessionId(session.sessionId, session.agentName), kind };
}

function resolveBank(session: Session, scope?: string, targetId?: string): { ok: true; bankId: string; kind: 'user' | 'group' | 'global' } | { ok: false; error: string } {
    const kind = scope === 'group' ? 'group' : scope === 'global' ? 'global' : scope === 'user' ? 'user' : (session.sessionType === 'group' ? 'group' : 'user');
    if (kind === 'global') {
        if ((session.setting?.priv ?? 0) < PRIVILEGE_LEVEL_MAP.master) return { ok: false, error: 'global 记忆仅骰主会话可写' };
        return { ok: true, bankId: MemoryService.globalBankId(session.agentName), kind };
    }
    const current = currentBank(session);
    if (!targetId) return { ok: true, bankId: current.bankId, kind: current.kind };
    const expected = kind === 'group' ? session.sessionType === 'group' ? session.sessionId : '' : session.sessionType === 'user' ? session.sessionId : '';
    if (targetId !== expected && (session.setting?.priv ?? 0) < PRIVILEGE_LEVEL_MAP.master) {
        return { ok: false, error: `目标 ${targetId} 不是当前会话；跨目标仅骰主可用` };
    }
    return { ok: true, bankId: MemoryService.bankIdForSessionId(targetId, session.agentName), kind };
}

function formatHits(hits: Array<{ kind: string; unit?: any; observation?: any; score: number }>): string {
    if (!hits.length) return '未找到相关记忆';
    return hits.map((h, i) => {
        const id = h.unit?.id || h.observation?.id || '';
        const text = h.unit?.text || h.observation?.text || '';
        return `${i + 1}. [${id}] (${h.kind}) ${text}`;
    }).join('\n');
}

export function registerMemory() {
    const recall = new Tool({
        type: 'function',
        function: {
            name: 'memory_recall',
            description: 'Retrieve long-term memory (personal/group/bot). Returns only relevant facts and observations, not the full injected text.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Query/keywords; leave empty to list recent important memories' },
                    memory_scope: { type: 'string', enum: ['user', 'group', 'global'], description: 'Scope; defaults to the current session' },
                    target_id: { type: 'string', description: 'Target user/group ID; defaults to the current session; cross-target access is owner-only' },
                    topK: { type: 'number', description: 'Max number of results; default 5' },
                    keywords: { type: 'array', items: { type: 'string' }, description: 'Tag filter (optional)' },
                },
                required: [],
            },
        },
    });
    recall.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        const hits = await MemoryService.recall(target.bankId, {
            query: String(args.query || ''),
            tags: Array.isArray(args.keywords) ? args.keywords.map(String) : [],
            tagsMatch: 'any',
            maxTokens: Math.max(1, Number(args.topK) || 5) * 200,
            collapseObservations: true,
        });
        const topK = Math.max(1, Number(args.topK) || 5);
        return formatHits(hits.slice(0, topK));
    };

    const add = new Tool({
        type: 'function',
        function: {
            name: 'memory_add',
            description: 'Add a long-term memory. Writes to the current session by default; private chats default to visible only to the person, group chats default to visible within the group.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Atomic fact; keep it short' },
                    memory_scope: { type: 'string', enum: ['user', 'group', 'global'], description: 'Owner; defaults to the current session' },
                    target_id: { type: 'string', description: 'Target user/group ID; defaults to the current session' },
                    keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords/tags' },
                    fact_kind: { type: 'string', enum: ['fact', 'rule', 'relation', 'event'], description: 'Fact type' },
                    importance: { type: 'number', description: 'Importance 0-1' },
                    visibility: { type: 'string', enum: ['public', 'origin', 'owner'], description: 'public=cross-group (self), origin=source only, owner=self only' },
                },
                required: ['text'],
            },
        },
    });
    add.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        const result = await MemoryService.retainToBank(target.bankId, {
            content: String(args.text || ''),
            relatedUserIds: target.kind === 'user' ? [target.bankId.replace(/^user_/, '')] : [],
            relatedGroupIds: target.kind === 'group' ? [target.bankId.replace(/^group_/, '')] : [],
            keywords: Array.isArray(args.keywords) ? args.keywords.map(String) : [],
            metadata: { type: String(args.fact_kind || 'fact') },
            importance: typeof args.importance === 'number' ? args.importance : 0.6,
            visibility: args.visibility,
        });
        bumpMemoryRevision();
        MemoryScheduler.poke();
        return result.action === 'duplicate' ? `已存在同文记忆 <${result.unitIds[0]}>` : `已添加 <${result.unitIds[0]}>`;
    };

    const update = new Tool({
        type: 'function',
        function: {
            name: 'memory_update',
            description: 'Update the text of a memory visible in the current session.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' }, text: { type: 'string' }, memory_scope: { type: 'string', enum: ['user', 'group', 'global'] }, target_id: { type: 'string' } },
                required: ['id', 'text'],
            },
        },
    });
    update.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        const unit = MemoryService.getFact(target.bankId, String(args.id || ''));
        if (!unit) return `记忆不存在<${args.id}>`;
        unit.text = String(args.text || '');
        unit.updatedAt = Math.floor(Date.now() / 1000);
        MemoryService.saveFact(target.bankId, unit);
        bumpMemoryRevision();
        return `已更新<${unit.id}>`;
    };

    const del = new Tool({
        type: 'function',
        function: {
            name: 'memory_delete',
            description: 'Delete (soft-invalidate by default) a memory visible in the current session; hard delete is owner-only.',
            parameters: {
                type: 'object',
                properties: {
                    id_list: { type: 'array', items: { type: 'string' } },
                    memory_scope: { type: 'string', enum: ['user', 'group', 'global'] },
                    target_id: { type: 'string' },
                    hard: { type: 'boolean' },
                },
                required: ['id_list'],
            },
        },
    });
    del.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        const ids = Array.isArray(args.id_list) ? args.id_list.map(String) : [];
        if (!ids.length) return 'id_list 不能为空';
        if (args.hard && (session.setting?.priv ?? 0) < PRIVILEGE_LEVEL_MAP.master) return 'hard 仅骰主可用';
        const n = args.hard ? await MemoryService.deleteFacts(target.bankId, ids) : await MemoryService.invalidateFacts(target.bankId, ids);
        bumpMemoryRevision();
        return `已${args.hard ? '物理删除' : '失效'} ${n} 条`;
    };

    const consolidate = new Tool({
        type: 'function',
        function: {
            name: 'memory_consolidate',
            description: 'Consolidate memories of the current session immediately (facts -> observations).',
            parameters: { type: 'object', properties: { memory_scope: { type: 'string', enum: ['user', 'group', 'global'] }, target_id: { type: 'string' } }, required: [] },
        },
    });
    consolidate.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        const result = await MemoryService.consolidateBank(target.bankId);
        bumpSummaryRevision();
        return `巩固完成：新建 ${result.created.length}，更新 ${result.updated.length}，合并 ${result.merged.length}，剩余 pending ${result.pendingRemaining}`;
    };

    const reflectTool = new Tool({
        type: 'function',
        function: {
            name: 'memory_reflect',
            description: 'Reason over current memory (mental models first; fall back to observations/raw facts when needed).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    memory_scope: { type: 'string', enum: ['user', 'group', 'global'] },
                    target_id: { type: 'string' },
                    deep: { type: 'boolean', description: 'Force drilling down to raw facts' },
                },
                required: ['query'],
            },
        },
    });
    reflectTool.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        const result = await MemoryService.reflect(target.bankId, String(args.query || ''), { fastPath: !args.deep, strict: false });
        return `${result.text || '暂无足够记忆进行推理'}\n来源：模型 ${result.basedOn.mentalModels.length} / 观察 ${result.basedOn.observations.length} / 事实 ${result.basedOn.memories.length}`;
    };

    const mm = new Tool({
        type: 'function',
        function: {
            name: 'memory_mental_model',
            description: 'Manage mental models: list/view/create/refresh/clear/delete.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'view', 'create', 'refresh', 'clear', 'delete'] },
                    model_id: { type: 'string' },
                    question: { type: 'string' },
                    answer: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    mode: { type: 'string', enum: ['full', 'delta'] },
                    auto: { type: 'boolean' },
                    memory_scope: { type: 'string', enum: ['user', 'group', 'global'] },
                    target_id: { type: 'string' },
                },
                required: ['action'],
            },
        },
    });
    mm.solve = async (_ctx, _msg, session, args) => {
        const target = resolveBank(session, args.memory_scope, args.target_id);
        if ('error' in target) return target.error;
        if (args.action === 'list') {
            const models = MemoryService.listMentalModels(target.bankId);
            return models.length ? models.map(m => `${m.id} ${m.sourceQuery} · ${m.status}`).join('\n') : '暂无心智模型';
        }
        if (args.action === 'view') {
            const m = MemoryService.listMentalModels(target.bankId).find(x => x.id === args.model_id);
            return m ? `${m.sourceQuery}\n${m.content || '（待生成）'}` : '未找到';
        }
        if (args.action === 'create') {
            const m = await MemoryService.createMentalModel(target.bankId, String(args.question || ''), String(args.answer || ''), Array.isArray(args.tags) ? args.tags : [], {
                mode: args.mode === 'delta' ? 'delta' : args.mode === 'full' ? 'full' : undefined,
                autoRefresh: typeof args.auto === 'boolean' ? args.auto : undefined,
            });
            MemoryScheduler.enqueueMentalModelRefresh(target.bankId, m.id, 'manual');
            return `已创建 <${m.id}>（${m.status}）`;
        }
        if (args.action === 'refresh') {
            const summary = await MemoryService.refreshMentalModels(target.bankId, { id: args.model_id, force: true, reason: 'manual' });
            return `刷新：更新 ${summary.updated}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
        }
        if (args.action === 'clear') {
            const m = MemoryService.listMentalModels(target.bankId).find(x => x.id === args.model_id);
            if (!m) return '未找到';
            m.content = '';
            m.structuredContent = { version: 1, sections: [] };
            m.status = 'pending';
            MemoryService.saveMentalModel(target.bankId, m);
            MemoryScheduler.enqueueMentalModelRefresh(target.bankId, m.id, 'manual');
            return '已清空，正在重建';
        }
        if (args.action === 'delete') {
            await MemoryService.deleteMentalModel(target.bankId, String(args.model_id || ''));
            return '已删除';
        }
        return '未知 action';
    };

    void recall; void add; void update; void del; void consolidate; void reflectTool; void mm;
}
