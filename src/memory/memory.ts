import Config from "../config/config";
import { generateId, TypeDescriptor } from "../utils/utils";
import Logger from "../logger";
import Model from "../model/model";
import { MemorySource, searchOptions } from "./types";
import Agent from "../agent/agent";
import { Session } from "../session/session";
import MemoryItem from "./memory_item";

export default class MemoryService {
    static validKeysMap: { [key in keyof MemoryService]?: TypeDescriptor<MemoryService[key]> } = {
        memoryMap: { array: MemoryItem }
    };
    memoryMap: { [id: string]: MemoryItem };

    constructor() {
        this.memoryMap = {};
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

    generateMemoryId(): string {
        let id = generateId(), a = 0;
        while (this.memoryMap.hasOwnProperty(id)) {
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
                if (this.memoryMap.hasOwnProperty(id)) {
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

        return this.memories
            .map(m => {
                if (relatedMemories.length > 0 && relatedMemories.some(r => m.id === r || m.relatedMemories.includes(r))) return m;
                return null;
            })
            .filter(m => m !== null)
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
        task.push(agent.sessionService.memory.accessMemory(s));
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