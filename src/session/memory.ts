import { Config } from "../config/config";
import { Context } from "./context";
import { cosineSimilarity, generateId, getCommonGroup, getCommonKeyword, getCommonItem, revive, TypeDescriptor } from "../utils/utils";
import { logger } from "../logger";
import { fetchData, getEmbedding } from "../agent/service";
import { buildContent, getRoleSetting, parseBody } from "../utils/message";
import { ToolService } from "../tool/tool";
import { fmtDate } from "../utils/string";
import { Image } from "../image/image";

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
        const ageDecay = Math.exp(-age / 7 * Math.LN2);
        // 活跃衰减: 半衰期4小时
        const activityDecay = Math.exp(-activity / 4 * Math.LN2);
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

    async updateVector() {
        const { isMemoryVector, embeddingDimension } = Config.memory;
        if (isMemoryVector) {
            logger.info(`更新记忆向量: ${this.id}`);
            const vector = await getEmbedding(this.content);
            if (!vector.length) {
                logger.error('返回向量为空');
                return;
            }
            if (vector.length !== embeddingDimension) {
                logger.error(`向量维度不匹配。期望: ${embeddingDimension}, 实际: ${vector.length}`);
                return;
            }
            this.vector = vector;
        }
    }
}

export class MemoryService {
    static validKeysMap: { [key in keyof MemoryService]?: TypeDescriptor<MemoryService[key]> } = {
        memoryMap: { array: MemoryItem }
    };
    memoryMap: { [id: string]: MemoryItem };

    constructor() {
        this.memoryMap = {};
    }

    get memoryIdList() {
        return Object.keys(this.memoryMap);
    }

    get memoryList() {
        return Object.values(this.memoryMap);
    }

    get keywords() {
        const keywords = new Set<string>();
        this.memoryList.forEach(m => m.tags.forEach(kw => keywords.add(kw)));
        return Array.from(keywords);
    }

    async addMemory(sid: string, ul: string[], gl: string[], kws: string[], il: string[], content: string) {
        for (const id of this.memoryIdList) {
            const m = this.memoryMap[id];
            if (content === m.content && sid === m.sessionId && getCommonItem(ul, m.users).length > 0 && getCommonGroup(gl, m.groups).length > 0) {
                m.tags = Array.from(new Set([...m.tags, ...kws]));
                logger.info(`记忆已存在，id:${id}，合并关键词:${m.tags.join(',')}`);
                return;
            }
        }

        // 添加文本内插入的图片
        const imgIdSet = new Set(il);
        (await ImageService.extractExistingImagesToSave(content)).forEach(img => {
            if (imgIdSet.has(img.id)) return;
            imgIdSet.add(img.id);
            il.push(img.id);
        });

        let id = generateId(), a = 0;
        while (this.memoryMap.hasOwnProperty(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                logger.error(`生成记忆id失败，已尝试1000次，放弃`);
                return;
            }
        }

        const now = Math.floor(Date.now() / 1000);
        const m = new MemoryItem();
        m.id = id;
        m.sessionId = sid;
        m.createAt = now;
        m.lastAccessedAt = now;
        m.weight = 5;
        m.content = content;
        m.tags = kws;
        m.users = ul;
        m.groups = gl;
        m.imageIdList = il;

        await m.updateVector();
        this.limitMemory();
        this.memoryMap[id] = m;
    }

    deleteMemory(ml: string[] = [], kws: string[] = []) {
        if (ml.length === 0 && kws.length === 0) return;

        ml.forEach(id => delete this.memoryMap?.[id])

        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                if (kws.some(kw => this.memoryMap[id].tags.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    limitMemory() {
        const { memoryLimit } = Config.memory;
        const limit = memoryLimit > 0 ? memoryLimit - 1 : 0; // 预留1个位置用于存储最新记忆
        if (this.memoryList.length <= limit) return;
        this.memoryList.map((m) => {
            return {
                id: m.id,
                score: m.decay * m.weight
            }
        })
            .sort((a, b) => b.score - a.score) // 从大到小排序
            .slice(limit)
            .forEach(item => delete this.memoryMap?.[item.id]);
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
        if (!this.memoryList.length) return [];
        const { userIdList: ul, groupIdList: gl, tags: kws, includeImages, method } = options;

        const { isMemoryVector, embeddingDimension } = Config.memory;
        let qv: number[] = [];
        if (isMemoryVector && query) {
            qv = await getEmbedding(query);
            if (!qv.length) {
                logger.error('查询向量为空');
                return [];
            }
            await Promise.all(this.memoryList.map(async m => {
                if (m.vector.length !== embeddingDimension) {
                    logger.info(`记忆向量维度不匹配，重新获取向量: ${m.id}`);
                    await m.updateVector();
                }
            }))
        }

        return this.memoryList
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
        if (this.memoryList.length === 0) return '';
        if (p > Math.ceil(this.memoryList.length / 5)) p = Math.ceil(this.memoryList.length / 5);
        const latestMemoryList = this.memoryList
            .sort((a, b) => b.createAt - a.createAt)
            .slice((p - 1) * 5, p * 5);
        return this.buildMemory(sid, latestMemoryList) + `\n当前页码: ${p}/${Math.ceil(this.memoryList.length / 5)}`;
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
        for (const m of this.memoryList) {
            const image = m.imageIdList.find(i => i === id);
            if (image) {
                m.weight += 0.2;
                return true;
            }
        }
        return false;
    }

    findMemoryByImageIdPrefix(id: string): MemoryItem | null {
        for (const m of this.memoryList) {
            const image = m.imageIdList.find(img => img.replace(/_\d+$/, "") === id);
            if (image) {
                m.weight += 0.2;
                return m;
            }
        }
        return null;
    }
}

export class SessionMemoryService extends MemoryService {
    static validKeysMap: { [key in keyof SessionMemoryService]?: TypeDescriptor<SessionMemoryService[key]> } = {
        memoryMap: { array: MemoryItem },
        summaryStatus: 'boolean',
        summaryList: { array: 'string' }
    };
    summaryStatus: boolean;
    summaryList: string[];

    constructor() {
        super();
        this.summaryStatus = false;
        this.summaryList = [];
    }

    limitSummary() {
        const { SummaryLimit } = Config.memory;
        if (this.summaryList.length > SummaryLimit) {
            this.summaryList.splice(0, this.summaryList.length - SummaryLimit);
        }
    }

    clearSummary() {
        this.summaryList = [];
    }

    // wip
    async updateSummary(ctx: seal.MsgContext, msg: seal.Message, ai: AI) {
        if (!this.summaryStatus) return;

        const { url: chatUrl, apiKey: chatApiKey } = Config.request;
        const { isPrefix, showNumber, showMsgId, showTime } = Config.message;
        const { shortMemorySummaryRound, memoryUrl, memoryApiKey, memoryBodyTemplate, memoryPromptTemplate } = Config.memory;

        const { roleSetting } = getRoleSetting(ctx);

        const messages = ai.context.messages;
        let sumMessages = messages.slice();
        let round = 0;
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'user' && !messages[i].name.startsWith('_')) {
                round++;
            }
            if (round > shortMemorySummaryRound) {
                sumMessages = messages.slice(0, i); // 只保留最近的shortMemorySummaryRound轮对话
                break;
            }
        }

        if (sumMessages.length === 0) {
            return;
        }

        let url = chatUrl;
        let apiKey = chatApiKey;
        if (memoryUrl.trim()) {
            url = memoryUrl;
            apiKey = memoryApiKey;
        }

        try {
            const prompt = memoryPromptTemplate({
                "角色设定": roleSetting,
                "平台": ctx.endPoint.platform,
                "私聊": ctx.isPrivate,
                "展示号码": showNumber,
                "用户名称": ctx.player.name,
                "用户号码": ctx.player.userId.replace(/^.+:/, ''),
                "群聊名称": ctx.group.groupName,
                "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
                "添加前缀": isPrefix,
                "展示消息ID": showMsgId,
                "展示时间": showTime,
                "对话内容": isPrefix ? sumMessages.map(message => {
                    if (message.role === 'assistant' && message?.tool_calls && message?.tool_calls.length > 0) {
                        return `\n[function_call]: ${message.tool_calls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
                    }

                    return `[${message.role}]: ${buildContent(message)}`;
                }).join('\n') : JSON.stringify(sumMessages)
            })

            logger.info(`记忆总结prompt:\n`, prompt);

            const messages = [
                {
                    role: "system",
                    content: prompt
                }
            ]
            const bodyObject = parseBody(memoryBodyTemplate, messages, [], "none");

            const time = Date.now();
            const data = await fetchData(url, apiKey, bodyObject);

            if (data.choices && data.choices.length > 0) {
                AIManager.updateUsage(data.model, data.usage);

                const message = data.choices[0].message;
                const finish_reason = data.choices[0].finish_reason;

                if (message.hasOwnProperty('reasoning_content')) {
                    logger.info(`思维链内容:`, message.reasoning_content);
                }

                const reply = message.content || '';
                logger.info(`响应内容:`, reply, '\nlatency:', Date.now() - time, 'ms', '\nfinish_reason:', finish_reason);

                const memoryData = JSON.parse(reply) as {
                    content: string,
                    memories: {
                        memory_type: 'private' | 'group',
                        name: string,
                        text: string,
                        keywords?: string[],
                        userList?: string[],
                        groupList?: string[],
                    }[]
                };


                this.shortMemoryList.push(memoryData.content);
                this.limitShortMemory();

                memoryData.memories.forEach(m => {
                    ToolService.toolMap["add_memory"].solve(ctx, msg, ai, m);
                });
            }
        } catch (e) {
            logger.error(`更新短期记忆失败: ${e.message}`);
        }
    }
}

export class KnowledgeService extends MemoryService {
    constructor() {
        super();
    }

    init() {
        const data = JSON.parse(Config.ext.storageGet('knowledge') || '{}');
        const ms = revive(MemoryService, data);
        this.memoryMap = ms.memoryMap;
    }

    save() {
        Config.ext.storageSet('knowledge', JSON.stringify(this.memoryMap));
    }

    // wip 和配置一起改
    async updateKnowledgeMemory(roleIndex: number) {
        const { knowledgeMemoryStringList } = Config.memory;
        if (roleIndex < 0 || roleIndex >= knowledgeMemoryStringList.length) return;
        const s = knowledgeMemoryStringList[roleIndex];
        if (!s) return;

        const memoryMap: { [id: string]: MemoryItem } = {}
        const segs = s.split(/\n-{3,}\n/);
        for (const seg of segs) {
            if (!seg.trim()) continue;

            const lines = seg.split('\n');
            if (lines.length === 0) continue;

            const m = new MemoryItem();
            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(/^\s*?(ID|用户|群聊|关键词|图片|内容)\s*?[:：](.*)/);
                if (!match) {
                    continue;
                }
                const type = match[1];
                const value = match[2].trim();
                switch (type) {
                    case 'ID': {
                        m.id = value;
                        break;
                    }
                    case '用户': {
                        m.userList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = value.replace(/[:：].*$/, '').trim();
                            const id = segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: true, id, name };
                        }).filter(ui => ui) as UserInfo[];
                        break;
                    }
                    case '群聊': {
                        m.groupList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = value.replace(/[:：].*$/, '').trim();
                            const id = segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: false, id, name };
                        }).filter(ui => ui) as GroupInfo[];
                        break;
                    }
                    case '关键词': {
                        m.tags = value.split(/[,，]/).map(kw => kw.trim()).filter(kw => kw);
                        break;
                    }
                    case '图片': {
                        const { localImagePathMap } = Config.image;

                        m.images = value.split(/[,，]/).map(id => id.trim()).map(id => {
                            if (localImagePathMap.hasOwnProperty(id)) {
                                const image = new Image();
                                image.file = localImagePathMap[id];
                                return image;
                            }
                            logger.error(`图片${id}不存在`);
                            return null;
                        }).filter(img => img);
                        break;
                    }
                    case '内容': {
                        m.content = lines.slice(i).join('\n').trim().replace(/^内容[:：]/, '');
                        break;
                    }
                    default: continue;
                }
            }

            if (!m.id && !m.content) continue;

            memoryMap[m.id] = m;
        }

        const now = Math.floor(Date.now() / 1000);
        await Promise.all(Object.values(memoryMap).map(async m => {
            if (this.memoryMap.hasOwnProperty(m.id)) {
                const m2 = this.memoryMap[m.id];
                m.vector = m2.vector;
                if (m2.content !== m.content) await m.updateVector();
                m.createAt = m2.createAt;
                m.lastAccessedAt = m2.lastAccessedAt;
                m.weight = m2.weight;
            } else {
                await m.updateVector();
                m.createAt = now;
                m.lastAccessedAt = now;
                m.weight = 5;
            }
        }))

        this.memoryMap = memoryMap;
        this.save();
    }

    // wip
    buildKnowledgeMemory(memoryList: MemoryItem[]) {
        const { showNumber } = Config.message;
        const { knowledgeMemorySingleShowTemplate } = Config.memory;
        if (memoryList.length === 0) return '';

        let prompt = '';
        if (memoryList.length === 0) {
            prompt = '无';
        } else {
            prompt = memoryList
                .map((m, i) => {
                    return knowledgeMemorySingleShowTemplate({
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "用户列表": m.userList.map(u => u.name + (showNumber ? `(${u.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "群聊列表": m.groupList.map(g => g.name + (showNumber ? `(${g.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.tags.join(';'),
                        "记忆内容": m.content
                    });
                }).join('\n');
        }

        return prompt;
    }

    // wip
    async buildKnowledgeMemoryPrompt(roleIndex: number, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        await this.updateKnowledgeMemory(roleIndex);
        if (this.memoryIdList.length === 0) return '';

        const { knowledgeMemoryShowNumber } = Config.memory;
        const memoryList = await this.search(text, {
            topK: knowledgeMemoryShowNumber,
            userIdList: ui ? [ui] : [],
            groupIdList: gi ? [gi] : [],
            tags: [],
            includeImages: false,
            method: 'score'
        });

        return this.buildKnowledgeMemory(memoryList);
    }
}

export const knowledgeService = new KnowledgeService();

// 可以通过维护一组索引来优化搜索性能。
// 好麻烦，不想弄
// 目前数量级应该没什么优化的需求