import Model from "../agent/model";
import { Config } from "../config/config";
import { logger } from "../logger";
import { cosineSimilarity, getCommonItem, revive, TypeDescriptor } from "../utils/utils";

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
     * @param t 查询标签列表
     * @param u 查询用户列表
     * @param g 查询群组列表
     * @returns 相似度分数（0-1）
     */
    calculateSimilarity(v: number[], t: string[], u: string[], g: string[]): number {
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
     * @param t 查询标签列表
     * @param u 查询用户列表
     * @param g 查询群组列表
     * @returns 相似度分数（0-1）
     */
    calculateScore(v: number[], t: string[], u: string[], g: string[]): number {
        const similarity = this.calculateSimilarity(v, t, u, g);
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