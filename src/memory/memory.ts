// 记忆服务：MemoryItem 存取/检索/权重/短期记忆（含旧格式迁移）
import Agent from "../agent/agent";
import Config from "../config/config";
import type { Context } from "../context/context";
import Logger from "../logger";
import Model from "../model/model";
import Image from "../resource/image";
import { Session } from "../session/session";
import { GroupInfo, SessionInfo, UserInfo } from "../session/types";
import { stripInternalTags } from "../utils/string";
import { generateId, getCommonItem, revive, TypeDescriptor } from "../utils/utils";

import MemoryItem from "./memory_item";
import { MemorySource, searchOptions } from "./types";

// 向量记忆检索的相似度下限（低于该值的记忆不返回），内置硬编码
const VECTOR_SIMILARITY = 0.8;

export default class MemoryService {
    static validKeysMap: { [key in keyof MemoryService]?: TypeDescriptor<MemoryService[key]> } = {
        memoryMap: { array: MemoryItem },
        persona: 'string',
        useShortMemory: 'boolean',
        shortMemoryList: { array: 'string' }
    };
    memoryMap: { [id: string]: MemoryItem };
    persona: string;

    constructor() {
        this.memoryMap = {};
        this.persona = '无';
        this.useShortMemory = false;
        this.shortMemoryList = [];
        this.summaries = [];
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
    }

    /** 4.14.0：把历史 <|...|> 渲染标签迁移为新格式 [xxx]；4.14.4 起同时剥离内部上下文标签（幂等，首次对话时调用） */
    migrateLegacyTags() {
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            if (m && typeof m.content === 'string') m.content = stripInternalTags(m.content);
        }
        if (Array.isArray(this.shortMemoryList)) {
            this.shortMemoryList = this.shortMemoryList.map(s => stripInternalTags(s));
        }
        if (Array.isArray(this.summaries)) {
            this.summaries = this.summaries.map(s => stripInternalTags(s));
        }
        if (typeof this.persona === 'string') this.persona = stripInternalTags(this.persona);
    }


    // ===== methods ported from legacy src/AI/memory.ts =====

    useShortMemory: boolean;
    shortMemoryList: string[];
    summaries: string[];

    async updateShortMemory(_ctx: seal.MsgContext, _msg: seal.Message, _ai: any) {
        // 短期记忆总结入口；仅 SessionMemoryService 实现，基类不实现
        const summarize = (this as MemoryService & { summarize?: () => Promise<void> }).summarize;
        if (typeof summarize === 'function') {
            await summarize.call(this);
        }
    }

    limitShortMemory() {
        const { SHORT_MEMORY_LIMIT } = Config.memory as any;
        const limit = SHORT_MEMORY_LIMIT > 0 ? SHORT_MEMORY_LIMIT : 10;
        if (this.shortMemoryList.length > limit) {
            this.shortMemoryList.splice(0, this.shortMemoryList.length - limit);
        }
    }

    clearShortMemory() {
        this.shortMemoryList = [];
    }

    clearMemory() {
        this.memoryMap = {};
    }

    deleteMemory(ids: string[] = [], kws: string[] = []) {
        // 按 id 精确删除（复用 deleteMemories 的严格匹配路径）
        if (ids.length > 0) this.deleteMemories(ids);
        // 按关键词宽松删除：命中任一关键词即删除
        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                if (kws.some(kw => this.memoryMap[id].tags.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    async addMemory(_ctx: seal.MsgContext | null, session: Session, ul: UserInfo[], gl: GroupInfo[], kws: string[], images: Image[], text: string) {
        const id = this.generateMemoryId();
        const now = Math.floor(Date.now() / 1000);
        const m = new MemoryItem();
        m.id = id;
        m.sessionId = session.sessionId;
        // 防注入：记忆内容中的内部上下文标签（from/msg_id/system/time）直接剥离
        m.content = stripInternalTags(text);
        m.createAt = now;
        m.lastAccessedAt = now;
        m.tags = kws;
        m.users = ul.map(u => u.id);
        m.groups = gl.map(g => g.id);
        m.importance = 0.5;
        images.forEach(img => {
            if (!img.imageId) img.imageId = generateId();
            Image.save(img);
        });
        await m.updateVector();
        this.limitMemory();
        this.memoryMap[id] = m;
    }

    limitMemory() {
        // 单条写入入口：预留 1 个空位给待写入的新记忆
        this.limitMemories(1);
    }

    buildMemory(si: SessionInfo, ml: MemoryItem[]): string {
        if (ml.length === 0) return '';
        const listText = ml.map((m, i) =>
            (i + 1) + '. [' + m.id + '] ' + m.content
        ).join('\n');
        return '私聊:' + si.isPrivate + '\n群聊名称:' + si.name + '\n记忆列表:\n' + listText;
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

    async buildMemoryPrompt(ctx: seal.MsgContext, _context: Context, text: string, ui: UserInfo | null, gi: GroupInfo | null): Promise<string> {
        let s = '';
        const users = ui ? [ui.id] : [];
        const groups = gi ? [gi.id] : [];
        s += this.buildMemory({
            isPrivate: true,
            id: ctx.endPoint.userId,
            name: seal.formatTmpl(ctx, '核心:骰子名字')
        }, await this.getTopScoreMemoryList(text, users, groups));

        if (!ctx.isPrivate) {
            s += this.buildMemory({
                isPrivate: false,
                id: ctx.group!.groupId,
                name: ctx.group!.groupName
            }, await this.getTopScoreMemoryList(text, users, groups));
        }
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
            for (const om of this.memories) {
                if (om.compareWith(m)) {
                    Logger.info(`记忆已存在，id:${om.id}，进行合并`);
                    om.merge(m);
                    om.accessCount++;
                    om.lastAccessedAt = now;
                    continue;
                }
            }
            memoriesToAdd.push(m);
        }

        if (memoriesToAdd.length === 0) return;

        await Promise.all(memoriesToAdd.map(async m => await m.updateVector()));
        this.limitMemories(memoriesToAdd.length);
        memoriesToAdd.forEach(m => this.memoryMap[m.id] = m);
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
    }

    clearMemories() {
        this.memoryMap = {};
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
            sessionId = '',
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

        // 候选集过滤：关联记忆/私有可见性/用户群组（宽松+严格）/标签
        const candidates = this.memories.filter(m => {
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
        const simOf = (m: MemoryItem) => (v.length > 0 && m.vector.length > 0) ? m.calculateSimilarity(v) : -1;
        // 关键词命中分：查询标签命中优先，其次内容包含查询词
        const keywordScoreOf = (m: MemoryItem) => {
            let score = 0;
            if (tags.length > 0) score += getCommonItem(m.tags, tags).length / tags.length;
            if (queryTokens.length > 0) {
                score += queryTokens.filter(t => m.content.includes(t)).length / queryTokens.length * 0.5;
            }
            return score;
        };

        let results: MemoryItem[];
        if (v.length > 0 && (method === 'similarity' || method === 'score')) {
            // 向量过滤：仅保留纯向量相似度达标的条目，再按相似度/综合分排序
            const vectorHits = candidates
                .filter(m => m.vector.length > 0 && simOf(m) >= VECTOR_SIMILARITY)
                .sort((a, b) => method === 'score' ? b.calculateScore(v) - a.calculateScore(v) : simOf(b) - simOf(a));
            // 关键词兜底补足 topK：向量未命中时按关键词分填充
            const fills = candidates
                .filter(m => !vectorHits.includes(m))
                .sort((a, b) => keywordScoreOf(b) - keywordScoreOf(a) || b.calculateScore([]) - a.calculateScore([]))
                .slice(0, Math.max(0, topK - vectorHits.length));
            results = [...vectorHits.slice(0, topK), ...fills];
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
        // 知识库记忆权重更新
        task.push(agent.sessionService.knowledge.accessMemories(s));
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
        // 知识库记忆
        items.push(...agent.sessionService.knowledge[item]);
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
        const { MEMORY_TEMPLATE } = Config.prompt;
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
 * 兼容旧存储格式（src/AI/memory.ts 中的 MemoryManager）的过渡类。
 * 负责把历史 AI_* 存档里的旧 Memory 字段迁移成新 MemoryItem，
 * 迁移完成后可删除。
 */
export class MemoryManager extends MemoryService {
    static validKeysMap: { [key in keyof MemoryManager]?: TypeDescriptor<MemoryManager[key]> } = {
        memoryMap: { array: MemoryItem },
        persona: 'string',
        useShortMemory: 'boolean',
        shortMemoryList: { array: 'string' }
    }
    persona: string;
    useShortMemory: boolean;
    shortMemoryList: string[];

    constructor() {
        super();
        this.persona = '无';
        this.useShortMemory = false;
        this.shortMemoryList = [];
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
                users: m.users || (m.userList || []).map((u: any) => u.id),
                groups: m.groups || (m.groupList || []).map((g: any) => g.id)
            });
            this.memoryMap[id] = item;
        }
    }
}
