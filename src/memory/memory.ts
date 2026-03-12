import { Config } from "../config/config";
import { Context } from "../session/context";
import { cosineSimilarity, generateId, getCommonItem, revive, TypeDescriptor } from "../utils/utils";
import { logger } from "../logger";
import { fetchData, getEmbedding } from "../agent/service";
import { buildContent, getRoleSetting, parseBody } from "../utils/message";
import { Tool } from "../tool/tool";
import { fmtDate } from "../utils/string";
import Image from "../image/image";
import Model from "../agent/model";

export class MemoryItem {
    static validKeysMap: { [key in keyof MemoryItem]?: TypeDescriptor<MemoryItem[key]> } = {
        'id': 'string',
        'sessionId': 'string',
        'visibility': 'string',
        'createAt': 'number',
        'lastAccessedAt': 'number',
        'accessCount': 'number',
        'importance': 'number',
        'content': 'string',
        'vector': { array: 'number' },
        'tags': { array: 'string' },
        'relatedMemories': { array: 'string' },
        'users': { array: 'string' },
        'groups': { array: 'string' }
    };

    // 核心字段
    id: string; // 记忆ID
    sessionId: string; // 记忆来源会话ID
    visibility: 'public' | 'private'; // 记忆可见性

    // 淘汰策略相关
    createAt: number; // 创建时间 TTL
    lastAccessedAt: number; // 最后访问时间 LRU
    accessCount: number; // 访问次数 LFU
    importance: number; // 重要性0-1

    // 内容
    content: string; // 记忆内容
    vector: number[]; // 记忆向量
    tags: string[]; // 记忆标签列表
    relatedMemories: string[]; // 相关记忆ID列表
    users: string[]; // 记忆相关用户ID列表
    groups: string[]; // 记忆相关群组ID列表

    constructor() {
        this.id = '';
        this.sessionId = '';
        this.visibility = 'public';
        this.createAt = 0;
        this.lastAccessedAt = 0;
        this.accessCount = 0;
        this.importance = 0;
        this.content = '';
        this.vector = [];
        this.tags = [];
        this.relatedMemories = [];
        this.users = [];
        this.groups = [];
    }

    get copy(): MemoryItem {
        return revive(MemoryItem, JSON.parse(JSON.stringify(this)));
    }

    /**
     * 计算记忆的新鲜度衰减因子，越大表示越新鲜
     * @returns 衰减因子（1→0）
     */
    get decay() {
        const now = Math.floor(Date.now() / 1000);
        // 年龄（天）
        const age = (now - this.createAt) / (24 * 60 * 60);
        // 活跃时间（小时）
        const activity = (now - this.lastAccessedAt) / (60 * 60);
        // 年龄衰减: 半衰期7天
        const ageDecay = this.createAt === 0 ? 1 : Math.exp(-age / 7 * Math.LN2);
        // 活跃衰减: 半衰期4小时
        const activityDecay = this.lastAccessedAt === 0 ? 1 : Math.exp(-activity / 4 * Math.LN2);
        // 衰减因子
        return ageDecay * 0.7 + activityDecay * 0.3; // 一拍脑门决定的加权
    }

    get accessScore() {
        // 饱和函数，访问次数归一化
        const accessNorm = 1 - 1 / (this.accessCount + 1);
        return accessNorm * this.decay;
    }

    /**
     * 计算记忆与查询的相似度分数
     * @param v  查询向量
     * @param u 查询用户列表
     * @param g 查询群组列表
     * @param t 查询标签列表
     * @returns 相似度分数（0-1）
     */
    calculateSimilarity(v: number[], u: string[], g: string[], t: string[]): number {
        // 总权重 0-1
        const tw = (v.length ? 0.4 : 0) + (u.length ? 0.2 : 0) + (g.length ? 0.2 : 0) + (t.length ? 0.2 : 0);
        if (tw === 0) return 0;
        // 向量相似度分数（如果提供了向量v） 0-1
        const vs = (v && v.length > 0 && this.vector && this.vector.length > 0) ? (cosineSimilarity(v, this.vector) + 1) / 2 : 0;
        // 用户相似度分数 0-1
        const us = u.length ? getCommonItem(this.users, u).length / new Set([...this.users, ...u]).size : 0;
        // 群组相似度分数 0-1
        const gs = g.length ? getCommonItem(this.groups, g).length / new Set([...this.groups, ...g]).size : 0;
        // 标签匹配分数 0-1
        const ts = t.length ? getCommonItem(this.tags, t).length / new Set([...this.tags, ...t]).size : 0;
        // 综合相似度分数 0-1
        const avs = vs * 0.4 + us * 0.2 + gs * 0.2 + ts * 0.2;
        // 相似度增强因子 0-1
        return avs / tw;
    }

    /**
     * 计算记忆的最终分数
     * @param v  查询向量
     * @param u 查询用户列表
     * @param g 查询群组列表
     * @param t 查询标签列表
     * @returns 相似度分数（0-1）
     */
    calculateScore(v: number[], u: string[], g: string[], t: string[]): number {
        const similarity = this.calculateSimilarity(v, u, g, t);
        return this.importance * 0.2 + this.accessScore * 0.2 + similarity * 0.6;
    }

    compareWith(m: MemoryItem): boolean {
        return this.content === m.content && this.sessionId === m.sessionId;
    }

    merge(m: MemoryItem) {
        this.importance = m.importance;
        this.tags = Array.from(new Set([...this.tags, ...m.tags]));
        this.relatedMemories = Array.from(new Set([...this.relatedMemories, ...m.relatedMemories]));
        this.users = Array.from(new Set([...this.users, ...m.users]));
        this.groups = Array.from(new Set([...this.groups, ...m.groups]));
    }

    async updateVector() {
        const { DIMENSION } = Config.memory;
        logger.info(`更新记忆向量: ${this.id}`);
        const model = Model.getEmbeddingModel('text-embedding');
        const vector = await model.callEmbedding(this.content);
        if (!vector.length) return logger.error('返回向量为空');
        if (vector.length !== DIMENSION) return logger.error(`向量维度不匹配。期望: ${DIMENSION}, 实际: ${vector.length}`);
        this.vector = vector;
    }
}

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
                logger.error(`生成记忆id失败，已尝试1000次，放弃`);
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
                    logger.info(`记忆已存在，id:${om.id}，进行合并`);
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
        this.limitMemory(memoriesToAdd.length);
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

    limitMemory(vacancy: number) {
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

    clearMemory() {
        this.memoryMap = {};
    }

    async search(query: string, options: searchOptions = {
        topK: 10,
        userIdList: [],
        groupIdList: [],
        tags: [],
        includeImages: false,
        method: 'score'
    }) {
        if (!this.memories.length) return [];
        const { userIdList: ul, groupIdList: gl, tags: kws, includeImages, method } = options;

        const { isMemoryVector, embeddingDimension } = Config.memory;
        let qv: number[] = [];
        if (isMemoryVector && query) {
            qv = await getEmbedding(query);
            if (!qv.length) {
                logger.error('查询向量为空');
                return [];
            }
            await Promise.all(this.memories.map(async m => {
                if (m.vector.length !== embeddingDimension) {
                    logger.info(`记忆向量维度不匹配，重新获取向量: ${m.id}`);
                    await m.updateVector();
                }
            }))
        }

        return this.memories
            .map(m => {
                if (includeImages && m.imageIdList.length === 0) return null;
                const mc = m.copy;
                if (mc.tags.some(kw => query.includes(kw))) mc.weight += 10; //提权
                return mc;
            })
            .filter(m => m)
            .sort((a, b) => {
                switch (method) {
                    case 'weight': return b.weight - a.weight;
                    case 'similarity': return b.calculateSimilarity(qv, ul, gl, kws) - a.calculateSimilarity(qv, ul, gl, kws);
                    case 'score': return b.calculateScore(qv, ul, gl, kws) - a.calculateScore(qv, ul, gl, kws);
                    case 'early': return a.createAt - b.createAt;
                    case 'late': return b.createAt - a.createAt;
                    case 'recent': return b.lastAccessedAt - a.lastAccessedAt;
                }
            })
            .slice(0, options.topK || 10);
    }

    updateMemoryWeight(s: string, role: 'user' | 'assistant') {
        const increase = role === 'user' ? 1 : 0.1;
        const decrease = role === 'user' ? 0.1 : 0;
        const now = Math.floor(Date.now() / 1000);

        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            if (m.tags.some(kw => s.includes(kw))) {
                m.weight = Math.max(10, m.weight + increase);
                m.lastAccessedAt = now;
            } else {
                m.weight = Math.min(0, m.weight - decrease);
            }
        }
    }

    // wip
    updateRelatedMemoryWeight(ctx: seal.MsgContext, context: Context, s: string, role: 'user' | 'assistant') {
        // bot记忆权重更新
        AIManager.getAI(ctx.endPoint.userId).memory.updateMemoryWeight(s, role);
        // 知识库记忆权重更新
        knowledgeService.updateMemoryWeight(s, role);
        // 会话自身记忆权重更新
        this.updateMemoryWeight(s, role);
        // 群内用户的记忆权重更新
        if (!ctx.isPrivate) context.userInfoList.forEach(ui => AIManager.getAI(ui.id).memory.updateMemoryWeight(s, role));
    }

    async getTopScoreMemoryList(text: string = '', uid: string = '', gid: string = '') {
        const { memoryShowNumber } = Config.memory;
        return await this.search(text, {
            topK: memoryShowNumber,
            userIdList: uid ? [uid] : [],
            groupIdList: gid ? [gid] : [],
            tags: [],
            includeImages: false,
            method: 'score'
        });
    }

    getLatestMemoryListText(sid: string, p: number = 1): string {
        if (this.memories.length === 0) return '';
        if (p > Math.ceil(this.memories.length / 5)) p = Math.ceil(this.memories.length / 5);
        const latestMemoryList = this.memories
            .sort((a, b) => b.createAt - a.createAt)
            .slice((p - 1) * 5, p * 5);
        return this.buildMemory(sid, latestMemoryList) + `\n当前页码: ${p}/${Math.ceil(this.memories.length / 5)}`;
    }

    // wip 和默认配置一起改
    buildMemory(sid: string, ml: MemoryItem[]): string {
        if (ml.length === 0) return '';
        const { showNumber } = Config.message;
        const { memoryShowTemplate, memorySingleShowTemplate } = Config.memory;

        let memoryContent = '';
        if (ml.length === 0) {
            memoryContent = '无';
        } else {
            memoryContent = ml
                .map((m, i) => {
                    return memorySingleShowTemplate({
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "记忆时间": fmtDate(m.createAt),
                        "个人记忆": si.isPrivate,
                        "私聊": m.sessionInfo.isPrivate,
                        "展示号码": showNumber,
                        "群聊名称": m.sessionInfo.name,
                        "群聊号码": m.sessionInfo.id,
                        "相关用户": m.userList.map(u => u.name + (showNumber ? `(${u.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "相关群聊": m.groupList.map(g => g.name + (showNumber ? `(${g.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.tags.join(';'),
                        "记忆内容": m.content
                    });
                }).join('\n');
        }

        return memoryShowTemplate({
            "私聊": si.isPrivate,
            "展示号码": showNumber,
            "用户名称": si.name,
            "用户号码": si.id.replace(/^.+:/, ''),
            "群聊名称": si.name,
            "群聊号码": si.id.replace(/^.+:/, ''),
            "设定": this.persona,
            "记忆列表": memoryContent
        }) + '\n';
    }

    // wip
    async buildMemoryPrompt(ctx: seal.MsgContext, context: Context, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        const ai = AIManager.getAI(ctx.endPoint.userId);
        let s = ai.memory.buildMemory({
            isPrivate: true,
            id: ctx.endPoint.userId,
            name: seal.formatTmpl(ctx, "核心:骰子名字")
        }, await ai.memory.getTopScoreMemoryList(text, ui, gi));

        if (ctx.isPrivate) {
            return this.buildMemory({
                isPrivate: true,
                id: ctx.player.userId,
                name: ctx.player.name
            }, await ai.memory.getTopScoreMemoryList(text, ui, gi));
        } else {
            // 群聊记忆
            s += this.buildMemory({
                isPrivate: false,
                id: ctx.group.groupId,
                name: ctx.group.groupName
            }, await ai.memory.getTopScoreMemoryList(text, ui, gi));

            // 群内用户的个人记忆
            const set = new Set<string>();
            for (const ui of context.userInfoList) {
                const name = ui.name;
                const uid = ui.id;
                if (set.has(uid)) continue;
                set.add(uid);

                const ai = AIManager.getAI(uid);
                s += ai.memory.buildMemory({
                    isPrivate: true,
                    id: uid,
                    name: name
                }, await ai.memory.getTopScoreMemoryList(text, ui, gi));
            }

            return s;
        }
    }

    includedImage(id: string): boolean {
        for (const m of this.memories) {
            const image = m.imageIdList.find(i => i === id);
            if (image) {
                m.weight += 0.2;
                return true;
            }
        }
        return false;
    }

    findMemoryByImageIdPrefix(id: string): MemoryItem | null {
        for (const m of this.memories) {
            const image = m.imageIdList.find(img => img.replace(/_\d+$/, "") === id);
            if (image) {
                m.weight += 0.2;
                return m;
            }
        }
        return null;
    }
}

// 可以通过维护一组索引来优化搜索性能。
// 好麻烦，不想弄
// 目前数量级应该没什么优化的需求