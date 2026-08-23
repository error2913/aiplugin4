// 记忆服务：MemoryItem 存取/检索/权重/总结记忆
import Agent from "../agent/agent";
import Config from "../config/config";
import { CORE_FACT_IMPORTANCE, STALE_DELETE_DAYS, STALE_IMPORTANCE_THRESHOLD, STALE_MARK_DAYS, SUMMARY_MERGE_THRESHOLD, VECTOR_SIMILARITY } from "../config/static_config";
import type { Context } from "../context/context";
import Logger from "../logger";
import Model from "../model/model";
import { MEMORY_TEMPLATE } from "../prompt/templates";
import Image from "../resource/image";
import { Session } from "../session/session";
import { GroupInfo, SessionInfo, UserInfo } from "../session/types";
import { buildCharNGrams, stripInternalTags, truncateText } from "../utils/string";
import { normalizeGroupId, normalizeUserId } from "../utils/target_id";
import { generateId, getCommonItem, revive, TypeDescriptor } from "../utils/utils";

import MemoryItem from "./memory_item";
import { bumpMemoryRevision } from "./revision";
import { MemoryFact, MemoryFactResult, MemorySource, searchOptions } from "./types";

const MEMORY_RENDER_LIMIT = 1000;

export default class MemoryService {
    static validKeysMap: { [key in keyof MemoryService]?: TypeDescriptor<MemoryService[key]> } = {
        memoryMap: { array: MemoryItem },
        persona: 'string',
        summaries: { array: 'string' }
    };
    memoryMap: { [id: string]: MemoryItem };
    persona: string;
    /** 规范化内容 → id 列表的倒排索引（惰性重建，写入/删除后置空） */
    private contentIndex: Map<string, string[]> | null;

    constructor() {
        this.memoryMap = {};
        this.persona = '无';
        this.summaries = [];
        this.contentIndex = null;
    }

    get memoryIds() {
        return Object.keys(this.memoryMap);
    }
    get memories() {
        return Object.values(this.memoryMap);
    }
    get users() {
        const users = new Set<string>();
        this.memories.forEach(m => m.users.forEach(u => users.add(u)));
        return Array.from(users);
    }
    get groups() {
        const groups = new Set<string>();
        this.memories.forEach(m => m.groups.forEach(g => groups.add(g)));
        return Array.from(groups);
    }
    get tags() {
        const tags = new Set<string>();
        this.memories.forEach(m => m.tags.forEach(t => tags.add(t)));
        return Array.from(tags);
    }
    get keywords() {
        return this.tags;
    }

    reviveMemoryMap() {
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            if (!(m instanceof MemoryItem)) {
                this.memoryMap[id] = revive(MemoryItem, m);
            }
        }
        this.contentIndex = null;
    }

    // ===== 内容去重索引（规范化 content → id，惰性重建） =====

    /** 规范化记忆内容：去空白、小写，用于精确查重 */
    static normalizeContent(s: string): string {
        return String(s || '').replace(/\s+/g, '').toLowerCase();
    }

    private invalidateContentIndex() {
        this.contentIndex = null;
    }

    private getContentIndex(): Map<string, string[]> {
        if (!this.contentIndex) {
            const idx = new Map<string, string[]>();
            for (const m of this.memories) {
                const key = MemoryService.normalizeContent(m.content);
                if (!key) continue;
                const arr = idx.get(key);
                if (arr) arr.push(m.id);
                else idx.set(key, [m.id]);
            }
            this.contentIndex = idx;
        }
        return this.contentIndex;
    }

    /** 按规范化内容精确查重（同会话内唯一） */
    findMemoryByContent(content: string): MemoryItem | null {
        const key = MemoryService.normalizeContent(content);
        if (!key) return null;
        const ids = this.getContentIndex().get(key);
        if (!ids) return null;
        for (const id of ids) {
            if (this.memoryMap[id]) return this.memoryMap[id];
        }
        return null;
    }

    // ===== 语义记忆（核心事实） =====

    /** 核心事实：重要性达阈值的语义记忆，常驻注入 prompt（persona 之后） */
    getCoreFacts(topN: number = 3): MemoryItem[] {
        return this.memories
            .filter(m => !m.stale && (m.type === 'fact' || m.type === 'rule' || m.type === 'relation') && m.importance >= CORE_FACT_IMPORTANCE)
            .sort((a, b) => b.importance - a.importance)
            .slice(0, topN);
    }

    // ===== 事实应用管线（Mem0 风格：add/update/delete/noop） =====

    /**
     * 应用一条记忆事实：精确内容查重 → 合并/覆盖/删除/新增。
     * 返回动作与命中的记忆 ID，供工具反馈与日志使用。
     */
    async applyFact(fact: MemoryFact): Promise<MemoryFactResult> {
        const text = stripInternalTags(fact.text || '').trim();
        const now = Math.floor(Date.now() / 1000);
        const op = fact.op || 'add';
        if (!text && op !== 'delete' && op !== 'noop') return { action: 'noop' };

        const kws = Array.isArray(fact.keywords) ? fact.keywords.map(String) : [];
        const related = (Array.isArray(fact.related_memory_ids) ? fact.related_memory_ids : [])
            .map(String)
            .filter(id => this.memoryMap[id]);
        const users = (Array.isArray(fact.related_user_ids) ? fact.related_user_ids : [])
            .map(id => normalizeUserId(id))
            .filter((id): id is string => id !== null);
        const groups = (Array.isArray(fact.related_group_ids) ? fact.related_group_ids : [])
            .map(id => normalizeGroupId(id))
            .filter((id): id is string => id !== null);
        const importance = typeof fact.importance === 'number' ? Math.min(1, Math.max(0, fact.importance)) : 0.5;

        // 定位已存在条目：existing_id 优先，其次精确内容查重
        const byId = fact.existing_id && this.memoryMap[String(fact.existing_id)];
        const exact = text ? this.findMemoryByContent(text) : null;
        const existing = byId || exact || null;

        if (op === 'delete') {
            if (existing) {
                delete this.memoryMap[existing.id];
                this.invalidateContentIndex();
                bumpMemoryRevision();
                return { action: 'deleted', id: existing.id };
            }
            return { action: 'noop' };
        }

        if (existing) {
            if (op === 'noop') return { action: 'noop', id: existing.id };
            if (!byId && op === 'add') {
                // 精确内容重复（add 命中查重）：合并而非覆盖，保持原内容/向量
                existing.tags = Array.from(new Set([...existing.tags, ...kws]));
                existing.relatedMemories = Array.from(new Set([...existing.relatedMemories, ...related]));
                existing.users = Array.from(new Set([...existing.users, ...users]));
                existing.groups = Array.from(new Set([...existing.groups, ...groups]));
                existing.importance = Math.max(existing.importance, importance);
                existing.stale = false;
                existing.accessCount++;
                existing.lastAccessedAt = now;
                this.invalidateContentIndex();
                bumpMemoryRevision();
                return { action: 'merged', id: existing.id };
            }
            // update / 按 ID 定位：覆盖内容
            existing.content = text;
            if (fact.type) existing.type = fact.type;
            existing.tags = Array.from(new Set([...existing.tags, ...kws]));
            existing.relatedMemories = Array.from(new Set([...existing.relatedMemories, ...related]));
            existing.users = Array.from(new Set([...existing.users, ...users]));
            existing.groups = Array.from(new Set([...existing.groups, ...groups]));
            existing.importance = Math.max(existing.importance, importance);
            existing.stale = false;
            existing.lastAccessedAt = now;
            existing.accessCount++;
            await existing.updateVector();
            this.invalidateContentIndex();
            bumpMemoryRevision();
            return { action: 'updated', id: existing.id };
        }

        if (op === 'noop') return { action: 'noop' };

        // 新增
        const id = this.generateMemoryId();
        const m = new MemoryItem();
        m.id = id;
        m.sessionId = (this as MemoryService & { sessionId?: string }).sessionId || '';
        m.type = fact.type || 'text';
        m.visibility = fact.visibility === 'private' ? 'private' : 'public';
        m.content = text;
        m.createAt = now;
        m.lastAccessedAt = now;
        m.tags = kws;
        m.relatedMemories = related;
        m.users = users;
        m.groups = groups;
        m.importance = importance;
        await m.updateVector();
        this.limitMemory();
        this.memoryMap[id] = m;
        this.invalidateContentIndex();
        bumpMemoryRevision();
        return { action: 'added', id };
    }

    // ===== stale 记忆治理（巩固任务调用） =====

    /**
     * 标记/清理过期记忆：低重要性且长期未访问 → 标记 stale（移出检索）；
     * stale 且再次超期 → 删除。返回统计供日志/反馈。
     */
    markAndPruneStale(): { marked: number; deleted: string[] } {
        const now = Math.floor(Date.now() / 1000);
        const deleted: string[] = [];
        let marked = 0;
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            if (m.stale) {
                if (now - m.lastAccessedAt > STALE_DELETE_DAYS * 86400) {
                    delete this.memoryMap[id];
                    deleted.push(id);
                }
            } else if (
                m.importance < STALE_IMPORTANCE_THRESHOLD &&
                now - (m.lastAccessedAt || m.createAt) > STALE_MARK_DAYS * 86400
            ) {
                m.stale = true;
                marked++;
            }
        }
        if (deleted.length > 0 || marked > 0) {
            this.invalidateContentIndex();
            bumpMemoryRevision();
        }
        return { marked, deleted };
    }

    /** 合并高度相似的总结条目（n-gram 最小集归一化 ≥ 阈值视为重复），保序去重 */
    static mergeSimilarSummaries(summaries: string[], threshold = SUMMARY_MERGE_THRESHOLD): string[] {
        const merged: string[] = [];
        for (const s of summaries) {
            let dup = false;
            for (const m of merged) {
                if (MemoryService.summarySimilarity(s, m) >= threshold) { dup = true; break; }
            }
            if (!dup) merged.push(s);
        }
        return merged;
    }

    /** 两条文本的 n-gram 相似度（0-1）：重合 gram 数 / 较小 gram 集大小 */
    static summarySimilarity(a: string, b: string): number {
        const ga = buildCharNGrams(a || '', 2, 3);
        const gb = buildCharNGrams(b || '', 2, 3);
        if (ga.size === 0 || gb.size === 0) return 0;
        let hit = 0;
        for (const g of ga) if (gb.has(g)) hit++;
        return hit / Math.min(ga.size, gb.size);
    }

    /** 4.14.0：把历史 <|...|> 渲染标签迁移为新格式 [xxx]；4.14.4 起同时剥离内部上下文标签（幂等，首次对话时调用） */
    migrateLegacyTags() {
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            if (m && typeof m.content === 'string') m.content = stripInternalTags(m.content);
        }
        if (Array.isArray(this.summaries)) {
            this.summaries = this.summaries.map(s => stripInternalTags(s));
        }
        if (typeof this.persona === 'string') this.persona = stripInternalTags(this.persona);
    }


    // ===== methods ported from legacy src/AI/memory.ts =====

    summaries: string[];

    clearMemory() {
        this.memoryMap = {};
        this.contentIndex = null;
        bumpMemoryRevision();
    }

    deleteMemory(ids: string[] = [], kws: string[] = []) {
        const before = this.memories.length;
        // 按 id 精确删除（复用 deleteMemories 的严格匹配路径）
        let bumpedByDeleteMemories = false;
        if (ids.length > 0) {
            const beforeIds = this.memories.length;
            this.deleteMemories(ids);
            bumpedByDeleteMemories = this.memories.length !== beforeIds;
        }
        // 按关键词宽松删除：命中任一关键词即删除
        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                if (kws.some(kw => this.memoryMap[id].tags.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
        if (!bumpedByDeleteMemories && this.memories.length !== before) bumpMemoryRevision();
        if (this.memories.length !== before) this.invalidateContentIndex();
    }

    async addMemory(
        _ctx: seal.MsgContext | null,
        session: Session,
        ul: UserInfo[],
        gl: GroupInfo[],
        kws: string[],
        images: Image[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type: MemoryItem['type'] = 'text',
        importance = 0.5
    ): Promise<MemoryFactResult> {
        const now = Math.floor(Date.now() / 1000);
        const cleanText = stripInternalTags(text);
        // 防重复：同会话规范化内容一致时合并而非新增（模型重复记忆不再累积）
        const existing = this.findMemoryByContent(cleanText);
        if (existing) {
            existing.tags = Array.from(new Set([...existing.tags, ...kws]));
            existing.users = Array.from(new Set([...existing.users, ...ul.map(u => u.id)]));
            existing.groups = Array.from(new Set([...existing.groups, ...gl.map(g => g.id)]));
            existing.accessCount++;
            existing.lastAccessedAt = now;
            existing.stale = false;
            if (existing.importance < importance) existing.importance = importance;
            bumpMemoryRevision();
            return { action: 'merged', id: existing.id };
        }
        const id = this.generateMemoryId();
        const m = new MemoryItem();
        m.id = id;
        m.sessionId = session.sessionId;
        // 可见性：public 对相关会话开放；private 仅创建会话可读（search 时按调用方会话过滤）
        m.visibility = visibility;
        // 防注入：记忆内容中的内部上下文标签（from/msg_id/system/time）直接剥离
        m.content = cleanText;
        m.createAt = now;
        m.lastAccessedAt = now;
        m.tags = kws;
        m.users = ul.map(u => u.id);
        m.groups = gl.map(g => g.id);
        m.type = type;
        m.importance = importance;
        images.forEach(img => {
            if (!img.imageId) img.imageId = generateId();
            Image.save(img);
        });
        await m.updateVector();
        this.limitMemory();
        this.memoryMap[id] = m;
        this.invalidateContentIndex();
        bumpMemoryRevision();
        return { action: 'added', id };
    }

    limitMemory() {
        // 单条写入入口：预留 1 个空位给待写入的新记忆
        this.limitMemories(1);
    }

    buildMemory(si: SessionInfo, ml: Array<{ id: string, content: string }>): string {
        if (ml.length === 0) return '';
        const listText = ml.map((m, i) =>
            (i + 1) + '. [' + m.id + '] ' + m.content
        ).join('\n');
        if (si.isPrivate) {
            return '记忆类型:个人记忆\n记忆列表:\n' + listText;
        }
        return '记忆类型:群聊记忆\n群聊名称:' + si.name + '\n记忆列表:\n' + listText;
    }

    getLatestMemoryListText(si: SessionInfo, p: number = 1): string {
        if (this.memories.length === 0) return '';
        if (p > Math.ceil(this.memories.length / 5)) p = Math.ceil(this.memories.length / 5);
        const latest = this.memories
            .sort((a, b) => b.createAt - a.createAt)
            .slice((p - 1) * 5, p * 5);
        return this.buildMemory(si, latest) + '\n当前页码: ' + p + '/' + Math.ceil(this.memories.length / 5);
    }

    async getTopScoreMemoryList(text: string = '', users: string[] = [], groups: string[] = []) {
        const { MEMORY_SHOW_NUMBER } = Config.memory;
        return await this.search(text, {
            topK: MEMORY_SHOW_NUMBER,
            tags: [],
            relatedMemories: [],
            users,
            groups,
            method: 'score'
        });
    }

    findMemoryAndImageByImageIdPrefix(id: string): { memory: MemoryItem, image: Image } | null {
        for (const m of this.memories) {
            // 图片标签为新版 [img:id]（4.14.0 起不再兼容旧版 <|img:id|>）
            const match = m.content.match(/\[img:([^\]]+)\]/);
            const imageId = match?.[1];
            if (imageId && imageId.replace(/_\d+$/, '') === id) {
                const img = Image.get(imageId);
                if (img) return { memory: m, image: img };
            }
        }
        return null;
    }

    findImage(id: string): Image | null {
        for (const m of this.memories) {
            if (m.content.includes('[img:' + id + ']')) {
                return Image.get(id);
            }
        }
        return null;
    }

    async buildMemoryPrompt(ctx: seal.MsgContext, _context: Context, text: string, uis: UserInfo[], gi: GroupInfo | null): Promise<string> {
        // 群聊多人在线时按全部发言者检索，而不是只按最后一位用户过滤
        const users = Array.from(new Set(uis.map(u => u.id)));
        const groups = gi ? [gi.id] : [];
        // 私聊/群聊检索的是同一份会话记忆，合并为一次查询（复用向量，避免重复嵌入）
        const memories = await this.getTopScoreMemoryList(text, users, groups);
        // 核心事实常驻：重要性达阈值的语义记忆（persona 之后、检索结果之前）
        const { CORE_FACT_NUMBER } = Config.memory;
        const coreFacts = this.getCoreFacts(CORE_FACT_NUMBER > 0 ? CORE_FACT_NUMBER : 3);
        if (memories.length === 0 && coreFacts.length === 0 && (!this.persona || this.persona === '无')) return '';
        let s = '';
        // 个人设定注入私聊、群聊设定注入群聊：放在长期记忆段顶部
        if (this.persona && this.persona !== '无') {
            s += `${ctx.isPrivate ? '个人设定' : '群聊设定'}: ${this.persona}\n`;
        }
        if (coreFacts.length > 0) {
            s += '核心事实:\n' + coreFacts
                .map((m, i) => `${i + 1}. [${m.id}] ${truncateText(m.content, MEMORY_RENDER_LIMIT)}`)
                .join('\n') + '\n';
        }
        // 检索结果去重：核心事实已常驻，不再重复出现在检索段
        const coreIds = new Set(coreFacts.map(m => m.id));
        const promptMemories = memories
            .filter(memory => !coreIds.has(memory.id))
            .map(memory => ({
                id: memory.id,
                content: truncateText(memory.content, MEMORY_RENDER_LIMIT)
            }));
        s += ctx.isPrivate
            ? this.buildMemory({
                isPrivate: true,
                id: ctx.endPoint.userId,
                name: seal.formatTmpl(ctx, '核心:骰子名字')
            }, promptMemories)
            : this.buildMemory({
                isPrivate: false,
                id: ctx.group!.groupId,
                name: ctx.group!.groupName
            }, promptMemories);
        return s;
    }

    generateMemoryId(): string {
        let id = generateId(), a = 0;
        while (Object.prototype.hasOwnProperty.call(this.memoryMap, id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                Logger.error(`生成记忆id失败，已尝试1000次，放弃`);
                throw new Error(`生成记忆id失败，已尝试1000次，放弃`);
            }
        }
        return id;
    }

    async addMemories(memories: MemoryItem[]) {
        const now = Math.floor(Date.now() / 1000);
        const memoriesToAdd: MemoryItem[] = [];
        for (const m of memories) {
            let merged = false;
            for (const om of this.memories) {
                if (om.compareWith(m)) {
                    Logger.info(`记忆已存在，id:${om.id}，进行合并`);
                    om.merge(m);
                    om.stale = false;
                    om.accessCount++;
                    om.lastAccessedAt = now;
                    merged = true;
                    break;
                }
            }
            if (!merged) memoriesToAdd.push(m);
        }

        if (memoriesToAdd.length === 0) {
            if (memories.length > 0) {
                this.invalidateContentIndex();
                bumpMemoryRevision();
            }
            return;
        }

        await Promise.all(memoriesToAdd.map(async m => await m.updateVector()));
        this.limitMemories(memoriesToAdd.length);
        memoriesToAdd.forEach(m => this.memoryMap[m.id] = m);
        this.invalidateContentIndex();
        bumpMemoryRevision();
    }

    /**
     * 删除记忆，删除完全符合条件的记忆
     * @param ids 记忆id列表
     * @param tags 标签列表
     * @param relatedMemories 相关记忆id列表
     * @param users 用户id列表
     * @param groups 群组id列表
     * @returns 
     */
    deleteMemories(ids: string[] = [], tags: string[] = [], relatedMemories: string[] = [], users: string[] = [], groups: string[] = []) {
        if (ids.length === 0 && tags.length === 0 && relatedMemories.length === 0 && users.length === 0 && groups.length === 0) return;
        const before = this.memories.length;

        if (ids.length > 0) {
            ids.forEach(id => {
                if (Object.prototype.hasOwnProperty.call(this.memoryMap, id)) {
                    const m = this.memoryMap[id];
                    if (
                        tags.every(t => m.tags.includes(t)) &&
                        relatedMemories.every(r => m.relatedMemories.includes(r)) &&
                        users.every(u => m.users.includes(u)) &&
                        groups.every(g => m.groups.includes(g))
                    ) delete this.memoryMap[id];
                }
            })
        } else {
            for (const id in this.memoryMap) {
                const m = this.memoryMap[id];
                if (
                    tags.every(t => m.tags.includes(t)) &&
                    relatedMemories.every(r => m.relatedMemories.includes(r)) &&
                    users.every(u => m.users.includes(u)) &&
                    groups.every(g => m.groups.includes(g))
                ) delete this.memoryMap[id];
            }
        }
        if (this.memories.length !== before) bumpMemoryRevision();
        if (this.memories.length !== before) this.invalidateContentIndex();
    }

    limitMemories(vacancy: number) {
        const { MEMORY_LIMIT } = Config.memory;
        const limit = MEMORY_LIMIT > vacancy ? MEMORY_LIMIT - vacancy : 0; // 预留空位用于存储最新记忆
        if (this.memories.length <= limit) return;
        this.memories
            .map((m) => {
                return {
                    id: m.id,
                    score: m.calculateScore([])
                }
            })
            .sort((a, b) => b.score - a.score) // 从大到小排序
            .slice(limit)
            .forEach(m => delete this.memoryMap?.[m.id]);
        this.invalidateContentIndex();
    }

    clearMemories() {
        this.memoryMap = {};
        this.contentIndex = null;
        bumpMemoryRevision();
    }

    private static lastEmbeddingWarnAt = 0;

    /** 嵌入检索降级提示：失败不阻断检索，回退关键词/分数；同类警告 60 秒内只提示一次 */
    private static warnEmbeddingFallback(reason: string) {
        const now = Date.now();
        if (now - MemoryService.lastEmbeddingWarnAt < 60_000) return;
        MemoryService.lastEmbeddingWarnAt = now;
        Logger.warning(`嵌入检索不可用(${reason})，已降级为关键词/分数检索`);
    }

    async search(query: string, options: searchOptions = {
        topK: 10,
        tags: [],
        relatedMemories: [],
        users: [],
        groups: [],
        method: 'score'
    }) {
        if (!this.memories.length) return [];
        const {
            topK = 10,
            tags = [],
            relatedMemories = [],
            users = [],
            groups = [],
            filterUsers = [],
            filterGroups = [],
            sessionId = (this as MemoryService & { sessionId?: string }).sessionId || '',
            method = 'score'
        } = options;

        // 向量查询；嵌入未配置/失败时不阻断检索，降级为关键词/分数检索
        let v: number[] = [];
        if (Config.model.EMBEDDING_MODEL_ENABLED && query) {
            const dimension = Model.getEmbeddingDimension();
            const model = dimension > 0 ? Model.getEmbeddingModel('text-embedding') : null;
            if (!model) {
                MemoryService.warnEmbeddingFallback('未找到可用的嵌入模型');
            } else {
                v = await model.callEmbedding(query);
                if (!v.length) {
                    MemoryService.warnEmbeddingFallback('查询向量为空');
                    v = [];
                } else if (v.length !== dimension) {
                    MemoryService.warnEmbeddingFallback(`查询向量维度不匹配，期望 ${dimension}，实际 ${v.length}`);
                    v = [];
                }
            }
        }

        // 候选集过滤：关联记忆/私有可见性/用户群组（宽松+严格）/标签/stale
        const candidates = this.memories.filter(m => {
            // 已标记过期（stale）的记忆不参与检索
            if (m.stale) return false;
            // 指定关联记忆时仅保留命中项
            if (relatedMemories.length > 0 && !relatedMemories.some(r => m.id === r || m.relatedMemories.includes(r))) return false;
            // 私有记忆仅创建会话可见
            if (m.visibility === 'private') {
                if (!sessionId || m.sessionId !== sessionId) return false;
            }
            // 宽松过滤：条目为空视为全局可见；非空且无交集则排除
            if (users.length > 0 && m.users.length > 0 && getCommonItem(m.users, users).length === 0) return false;
            if (groups.length > 0 && m.groups.length > 0 && getCommonItem(m.groups, groups).length === 0) return false;
            // 严格过滤：非空时须命中至少一个
            if (filterUsers.length > 0 && getCommonItem(m.users, filterUsers).length === 0) return false;
            if (filterGroups.length > 0 && getCommonItem(m.groups, filterGroups).length === 0) return false;
            // 查询标签：非空时须命中至少一个
            if (tags.length > 0 && getCommonItem(m.tags, tags).length === 0) return false;
            return true;
        });
        if (candidates.length === 0) return [];

        const queryTokens = Array.from(new Set((query || '').split(/[\s,，。.、;；:：!！?？()（）[\]【】]+/).filter(t => t.length > 0)));
        const queryGrams = buildCharNGrams(query || '');
        const simOf = (m: MemoryItem) => (v.length > 0 && m.vector.length > 0) ? m.calculateSimilarity(v) : -1;
        // 关键词命中分：查询标签命中优先，其次内容包含查询词，最后中文 n-gram 重合率
        const keywordScoreOf = (m: MemoryItem) => {
            let score = 0;
            if (tags.length > 0) score += getCommonItem(m.tags, tags).length / tags.length;
            if (queryTokens.length > 0) {
                score += queryTokens.filter(t => m.content.includes(t)).length / queryTokens.length * 0.5;
            }
            if (queryGrams.size > 0) {
                const contentGrams = buildCharNGrams(m.content);
                if (contentGrams.size > 0) {
                    let hit = 0;
                    for (const g of queryGrams) if (contentGrams.has(g)) hit++;
                    score += hit / queryGrams.size * 0.5;
                }
            }
            return score;
        };

        let results: MemoryItem[];
        if (v.length > 0 && (method === 'similarity' || method === 'score')) {
            // 向量检索：score 方法软化阈值（相似度达标 或 关键词命中 均可进入候选），
            // 再按综合分/相似度排序；关键词兜底补足 topK。
            const scored = candidates.map(m => ({ m, sim: simOf(m), kw: keywordScoreOf(m) }));
            const eligible = method === 'score'
                ? scored.filter(x => x.sim >= VECTOR_SIMILARITY || x.kw > 0)
                : scored.filter(x => x.sim >= VECTOR_SIMILARITY);
            const ranked = eligible
                .sort((a, b) => method === 'score' ? b.m.calculateScore(v) - a.m.calculateScore(v) : b.sim - a.sim)
                .slice(0, topK)
                .map(x => x.m);
            const fills = candidates
                .filter(m => !ranked.includes(m))
                .sort((a, b) => keywordScoreOf(b) - keywordScoreOf(a) || b.calculateScore([]) - a.calculateScore([]))
                .slice(0, Math.max(0, topK - ranked.length));
            results = [...ranked, ...fills];
        } else {
            // 无向量（嵌入未启用/失败）：按方法排序，similarity/score 回退到关键词+综合分
            results = candidates.sort((a, b) => {
                switch (method) {
                    case 'importance': return b.importance - a.importance;
                    case 'early': return a.createAt - b.createAt;
                    case 'late': return b.createAt - a.createAt;
                    case 'recent': return b.lastAccessedAt - a.lastAccessedAt;
                    case 'similarity':
                    case 'score':
                    default:
                        return keywordScoreOf(b) - keywordScoreOf(a) || b.calculateScore([]) - a.calculateScore([]);
                }
            }).slice(0, topK);
        }

        // 关联记忆一跳扩展：命中记忆的 relatedMemories 按关键词/综合分并入（不超过 topK 条）
        if (results.length > 0) {
            const resultIds = new Set(results.map(m => m.id));
            const extra: MemoryItem[] = [];
            for (const m of results) {
                for (const rid of m.relatedMemories) {
                    const r = this.memoryMap[rid];
                    if (r && !r.stale && !resultIds.has(rid)) {
                        extra.push(r);
                        resultIds.add(rid);
                    }
                }
            }
            if (extra.length > 0) {
                extra.sort((a, b) => keywordScoreOf(b) - keywordScoreOf(a) || b.calculateScore([]) - a.calculateScore([]));
                results = [...results, ...extra.slice(0, topK)];
            }
        }
        return results;
    }

    async accessMemories(s: string) {
        const now = Math.floor(Date.now() / 1000);
        const r = await this.search(s, {
            topK: 5,
            tags: [],
            relatedMemories: [],
            users: [],
            groups: [],
            method: 'similarity'
        });
        r.forEach(m => {
            m.lastAccessedAt = now;
            m.accessCount++;
        })
    }

    static async accessRelatedMemories(session: Session, s: string) {
        const agent = Agent.get(session.agentName);
        const task: Promise<void>[] = [];
        // bot记忆权重更新
        task.push(agent.sessionService.memory.accessMemories(s));
        // 会话自身记忆权重更新
        task.push(session.memory.accessMemories(s));
        // 群内用户的记忆权重更新
        if (session.sessionType === 'group') task.push(...session.context.users.map(u => agent.sessionService.getSession(u).memory.accessMemories(s)));
        await Promise.all(task);
    }

    static getItemsFromRelatedMemories(session: Session, item: 'tags' | 'users' | 'groups') {
        const agent = Agent.get(session.agentName);
        const items: string[] = [];
        // bot记忆
        items.push(...agent.sessionService.memory[item]);
        // 会话自身记忆
        items.push(...session.memory[item]);
        // 群内用户的记忆
        if (session.sessionType === 'group') session.context.users.forEach(u => items.push(...agent.sessionService.getSession(u).memory[item]));
        return Array.from(new Set(items));
    }

    async getTopScoreMemories(text: string = '', users: string[] = [], groups: string[] = []) {
        const { MEMORY_SHOW_NUMBER } = Config.memory;
        return await this.search(text, {
            topK: MEMORY_SHOW_NUMBER,
            tags: [],
            relatedMemories: [],
            users,
            groups,
            method: 'score'
        });
    }

    getLatestMemories(p: number = 1): MemoryItem[] {
        if (this.memories.length === 0) return [];
        if (p > Math.ceil(this.memories.length / 5)) p = Math.ceil(this.memories.length / 5);
        return this.memories
            .sort((a, b) => b.createAt - a.createAt)
            .slice((p - 1) * 5, p * 5);
    }

    buildMemoriesPrompt(sources: MemorySource[]): string {
        if (sources.length === 0) return '';
        const { MEMORY } = Config.memory;
        return MEMORY_TEMPLATE({
            "MEMORY": MEMORY,
            "sources": sources
        });
    }

    buildLatestMemoriesText(p: number = 1): string {
        const sources = [{
            source: '最新记忆',
            memories: this.getLatestMemories(p)
        }]
        return this.buildMemoriesPrompt(sources) + `\n当前页码: ${p}/${Math.ceil(this.memories.length / 5)}`;
    }
}

// 可以通过维护一组索引来优化搜索性能。
// 好麻烦，不想弄
// 目前数量级应该没什么优化的需求

/**
 * 旧存档读取器：仅按当前 MemoryItem 字段复活数据，不再解析旧的名称/列表字段。
 */
export class MemoryManager extends MemoryService {
    static validKeysMap: { [key in keyof MemoryManager]?: TypeDescriptor<MemoryManager[key]> } = {
        memoryMap: { array: MemoryItem },
        persona: 'string'
    }
    persona: string;

    constructor() {
        super();
        this.persona = '无';
    }

    reviveMemoryMap() {
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id] as any;
            if (!m || (!m.content && !m.text)) {
                delete this.memoryMap[id];
                continue;
            }
            const item = revive(MemoryItem, {
                id: m.id || id,
                sessionId: m.sessionId || (m.sessionInfo && m.sessionInfo.id) || '',
                type: m.type || 'text',
                visibility: m.visibility || 'public',
                createAt: m.createAt || m.createTime || 0,
                lastAccessedAt: m.lastAccessedAt || m.lastMentionTime || 0,
                accessCount: m.accessCount || 0,
                importance: m.importance != null ? m.importance : (m.weight || 0) / 10,
                content: m.content || m.text || '',
                vector: m.vector || [],
                tags: m.tags || m.keywords || [],
                relatedMemories: m.relatedMemories || [],
                users: Array.isArray(m.users) ? m.users : [],
                groups: Array.isArray(m.groups) ? m.groups : [],
                stale: !!m.stale,
            });
            this.memoryMap[id] = item;
        }
    }
}
