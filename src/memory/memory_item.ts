// 记忆条目：向量/标签/用户群组/相似度与新鲜度计算
import Config from "../config/config";
import Logger from "../logger";
import Model from "../model/model";
import { cosineSimilarity, revive, TypeDescriptor } from "../utils/utils";

export default class MemoryItem {
    static validKeysMap: { [key in keyof MemoryItem]?: TypeDescriptor<MemoryItem[key]> } = {
        'id': 'string',
        'sessionId': 'string',
        'type': 'string',
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
    type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'other'; // 记忆类型
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
        this.type = 'text';
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
     * 计算记忆与查询的纯向量相似度（归一化到 0-1）
     * @param v 查询向量
     * @returns 相似度分数（0-1）
     */
    calculateSimilarity(v: number[]): number {
        if (!v || v.length === 0 || !this.vector || this.vector.length === 0) return 0;
        return (cosineSimilarity(v, this.vector) + 1) / 2;
    }

    /**
     * 计算记忆的最终分数
     * @param v 查询向量
     * @returns 综合分数（0-1）
     */
    calculateScore(v: number[]): number {
        const similarity = this.calculateSimilarity(v);
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
        if (!Config.model.EMBEDDING_MODEL_ENABLED) return;
        const DIMENSION = Model.getEmbeddingDimension();
        if (DIMENSION <= 0) {
            Logger.info(`未配置嵌入向量维度，跳过向量更新: ${this.id}`);
            return;
        }
        Logger.info(`更新记忆向量: ${this.id}`);
        const model = Model.getEmbeddingModel('text-embedding');
        if (!model) return Logger.error('未找到可用的嵌入模型');
        const vector = await model.callEmbedding(this.content);
        if (!vector.length) return Logger.error('返回向量为空');
        if (vector.length !== DIMENSION) return Logger.error(`向量维度不匹配。期望: ${DIMENSION}, 实际: ${vector.length}`);
        this.vector = vector;
    }
}
