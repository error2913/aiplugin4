// 记忆服务：MemoryItem 存取/检索/权重/短期记忆（含旧格式迁移）
import Agent from "../agent/agent";
import Config from "../config/config";
import type { Context } from "../context/context";
import Logger from "../logger";
import Model from "../model/model";
import Image from "../resource/image";
import { Session } from "../session/session";
import { GroupInfo, SessionInfo, UserInfo } from "../session/types";
import { generateId, revive, TypeDescriptor } from "../utils/utils";

import MemoryItem from "./memory_item";
import { MemorySource, searchOptions } from "./types";


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


    // ===== methods ported from legacy src/AI/memory.ts =====

    useShortMemory: boolean;
    shortMemoryList: string[];

    async updateShortMemory(_ctx: seal.MsgContext, _msg: seal.Message, _ai: any) {
        if (typeof (this as any).summarize === 'function') {
            await (this as any).summarize();
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
        if (ids.length === 0 && kws.length === 0) return;
        ids.forEach(id => delete this.memoryMap?.[id]);
        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                if (kws.some(kw => this.memoryMap[id].tags.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    async addMemory(_ctx: seal.MsgContext, session: Session, ul: UserInfo[], gl: GroupInfo[], kws: string[], images: Image[], text: string) {
        const id = this.generateMemoryId();
        const now = Math.floor(Date.now() / 1000);
        const m = new MemoryItem();
        m.id = id;
        m.sessionId = session.sessionId;
        m.content = text;
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
        const { MEMORY_LIMIT } = Config.memory;
        const limit = MEMORY_LIMIT > 0 ? MEMORY_LIMIT - 1 : 0;
        if (this.memories.length <= limit) return;
        this.memories
            .map(m => ({ id: m.id, score: m.decay * m.importance }))
            .sort((a, b) => b.score - a.score)
            .slice(limit)
            .forEach(item => delete this.memoryMap?.[item.id]);
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
            const match = m.content.match(/<\|img:([^|]+)\|>/);
            if (match && match[1].replace(/_\d+$/, '') === id) {
                const img = Image.get(match[1]);
                if (img) return { memory: m, image: img };
            }
        }
        return null;
    }

    findImage(id: string): Image | null {
        for (const m of this.memories) {
            if (m.content.includes('<|img:' + id + '|')) {
                return Image.get(id);
            }
        }
        return null;
    }

    async buildMemoryPrompt(ctx: seal.MsgContext, _context: Context, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
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
                id: ctx.group.groupId,
                name: ctx.group.groupName
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
                    score: m.calculateScore([], [], [], [])
                }
            })
            .sort((a, b) => b.score - a.score) // 从大到小排序
            .slice(limit)
            .forEach(m => delete this.memoryMap?.[m.id]);
    }

    clearMemories() {
        this.memoryMap = {};
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
        const { topK = 10, tags = [], relatedMemories = [], users = [], groups = [], method = 'score' } = options;

        const { DIMENSION } = Config.memory;
        let v: number[] = [];
        if (DIMENSION > 0 && query) {
            const model = Model.getEmbeddingModel('text-embedding');
            if (!model) {
                Logger.error('未找到可用的嵌入模型');
                return [];
            }
            v = await model.callEmbedding(query);
            if (!v.length) {
                Logger.error('查询向量为空');
                return [];
            }
            if (v.length !== DIMENSION) {
                Logger.error(`查询向量维度不匹配。期望: ${DIMENSION}, 实际: ${v.length}`);
                return [];
            }
            await Promise.all(this.memories.map(async m => {
                if (m.vector.length !== DIMENSION) {
                    Logger.info(`记忆向量维度不匹配，重新获取向量: ${m.id}`);
                    await m.updateVector();
                }
            }))
        }

        const { VECTOR_SIMILARITY } = Config.trigger;
        return this.memories
            .map(m => {
                // 未指定关联记忆时返回全部；指定时仅保留命中关联的记忆
                if (relatedMemories.length > 0 && !relatedMemories.some(r => m.id === r || m.relatedMemories.includes(r))) return null;
                return m;
            })
            .filter(m => m !== null)
            .filter(m => {
                // 向量相似度下限：仅对普通检索的 similarity/score 方法生效
                if (relatedMemories.length > 0) return true;
                if (v.length === 0 || (method !== 'similarity' && method !== 'score')) return true;
                return m.calculateSimilarity(v, tags, users, groups) >= VECTOR_SIMILARITY;
            })
            .sort((a, b) => {
                switch (method) {
                    case 'importance': return b.importance - a.importance;
                    case 'similarity': return b.calculateSimilarity(v, tags, users, groups) - a.calculateSimilarity(v, tags, users, groups);
                    case 'score': return b.calculateScore(v, tags, users, groups) - a.calculateScore(v, tags, users, groups);
                    case 'early': return a.createAt - b.createAt;
                    case 'late': return b.createAt - a.createAt;
                    case 'recent': return b.lastAccessedAt - a.lastAccessedAt;
                }
            })
            .slice(0, topK);
    }

    async accessMemories(s: string) {
        const now = Math.floor(Date.now() / 1000);
        (await this.search(s, {
            topK: 5,
            tags: [],
            relatedMemories: [],
            users: [],
            groups: [],
            method: 'similarity'
        })).forEach(m => {
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
