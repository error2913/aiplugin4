import { ConfigManager } from "../config/configManager";
import { AI, AIManager, GroupInfo, SessionInfo, UserInfo } from "./AI";
import { Context } from "./context";
import { cosineSimilarity, generateId, getCommonGroup, getCommonKeyword, getCommonUser, revive } from "../utils/utils";
import { logger } from "../logger";
import { fetchData, getEmbedding } from "../service";
import { buildContent, getRoleSetting, parseBody } from "../utils/utils_message";
import { ToolManager } from "../tool/tool";
import { fmtDate } from "../utils/utils_string";
import { Image, ImageManager } from "./image";

export interface searchOptions {
    topK: number;
    userList: UserInfo[];
    groupList: GroupInfo[];
    keywords: string[];
    includeImages: boolean;
    method: 'weight' | 'similarity' | 'score' | 'early' | 'late' | 'recent';
}

export class Memory {
    static validKeys: (keyof Memory)[] = ['id', 'vector', 'text', 'sessionInfo', 'userList', 'groupList', 'createTime', 'lastMentionTime', 'keywords', 'weight', 'images'];
    id: string; // 记忆ID
    vector: number[]; // 记忆向量
    text: string; // 记忆内容
    sessionInfo: SessionInfo;
    userList: UserInfo[];
    groupList: GroupInfo[];
    createTime: number; // 秒级时间戳
    lastMentionTime: number;
    keywords: string[];
    weight: number; // 记忆权重，0-10
    images: Image[];

    constructor() {
        this.id = '';
        this.vector = [];
        this.text = '';
        this.sessionInfo = {
            id: '',
            isPrivate: false,
            name: '',
        };
        this.userList = [];
        this.groupList = [];
        this.createTime = 0;
        this.lastMentionTime = 0;
        this.keywords = [];
        this.weight = 0;
        this.images = [];
    }

    get copy(): Memory {
        const m = new Memory();
        m.id = this.id;
        m.vector = [...this.vector];
        m.text = this.text;
        m.sessionInfo = JSON.parse(JSON.stringify(this.sessionInfo));
        m.userList = JSON.parse(JSON.stringify(this.userList));
        m.groupList = JSON.parse(JSON.stringify(this.groupList));
        m.createTime = this.createTime;
        m.lastMentionTime = this.lastMentionTime;
        m.keywords = [...this.keywords];
        m.weight = this.weight;
        m.images = [...this.images];
        return m;
    }

    /**
     * 计算记忆的新鲜度衰减因子，越大表示越新鲜
     * @returns 衰减因子（1→0）
     */
    get decay() {
        const now = Math.floor(Date.now() / 1000);
        const ageInDays = (now - this.createTime) / (24 * 60 * 60);
        const activityInHours = (now - this.lastMentionTime) / (60 * 60);
        // 基础新鲜度: exp(-ageInDays / 7)
        const ageDecay = Math.exp(-ageInDays / 7);
        // 活跃度: exp(-activityInHours / 4)
        const activityDecay = Math.exp(-activityInHours / 4);
        // 衰减因子，取年龄衰减和活跃度衰减的较大值
        return Math.max(ageDecay, activityDecay);
    }

    /**
     * 计算记忆与查询的相似度分数
     * @param v  查询向量
     * @param ul 查询用户列表
     * @param gl 查询群组列表
     * @param kws 查询关键词列表
     * @returns 相似度分数（0-1）
     */
    calculateSimilarity(v: number[], ul: UserInfo[], gl: GroupInfo[], kws: string[]): number {
        // 总权重 0-1
        const totalWeight = (v.length ? 0.4 : 0) + (ul.length ? 0.2 : 0) + (gl.length ? 0.2 : 0) + (kws.length ? 0.2 : 0);
        if (totalWeight === 0) return 0;
        // 向量相似度分数（如果提供了向量v） 0-1
        const vectorSimilarity = (v && v.length > 0 && this.vector && this.vector.length > 0) ? (cosineSimilarity(v, this.vector) + 1) / 2 : 0;
        // 用户相似度分数 0-1
        const commonUser = getCommonUser(this.userList, ul);
        const userSimilarity = (ul && ul.length > 0) ? commonUser.length / (this.userList.length + ul.length - commonUser.length) : 0;
        // 群组相似度分数 0-1
        const commonGroup = getCommonGroup(this.groupList, gl);
        const groupSimilarity = (gl && gl.length > 0) ? commonGroup.length / (this.groupList.length + gl.length - commonGroup.length) : 0;
        // 关键词匹配分数 0-1
        const commonKeyword = getCommonKeyword(this.keywords, kws);
        const keywordSimilarity = (kws && kws.length > 0) ? commonKeyword.length / kws.length : 0;
        // 综合相似度分数 0-1
        const avgSimilarity = vectorSimilarity * 0.4 + userSimilarity * 0.2 + groupSimilarity * 0.2 + keywordSimilarity * 0.2;
        // 相似度增强因子 0-1
        return avgSimilarity / totalWeight;
    }

    /**
     * 计算记忆的最终分数
     * @param v  查询向量
     * @param ul 查询用户列表
     * @param gl 查询群组列表
     * @param kws 查询关键词列表
     * @returns 相似度分数（0-1）
     */
    calculateScore(v: number[], ul: UserInfo[], gl: GroupInfo[], kws: string[]): number {
        return this.weight * 0.03 + this.calculateSimilarity(v, ul, gl, kws) * 0.7;
    }

    async updateVector() {
        const { isMemoryVector, embeddingDimension } = ConfigManager.memory;
        if (isMemoryVector) {
            logger.info(`更新记忆向量: ${this.id}`);
            const vector = await getEmbedding(this.text);
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

export class MemoryManager {
    static validKeys: (keyof MemoryManager)[] = ['persona', 'memoryMap', 'useShortMemory', 'shortMemoryList'];
    persona: string;
    memoryMap: { [id: string]: Memory };
    useShortMemory: boolean;
    shortMemoryList: string[];

    constructor() {
        this.persona = '无';
        this.memoryMap = {};
        this.useShortMemory = false;
        this.shortMemoryList = [];
    }

    reviveMemoryMap() {
        for (const id in this.memoryMap) {
            this.memoryMap[id] = revive(Memory, this.memoryMap[id]);
            if (!this.memoryMap[id].text) {
                delete this.memoryMap[id];
                continue;
            }
            if (!this.memoryMap[id].hasOwnProperty('images')) this.memoryMap[id].images = [];
            this.memoryMap[id].images = this.memoryMap[id].images.map(image => revive(Image, image));
        }
    }

    get memoryIds() {
        return Object.keys(this.memoryMap);
    }

    get memoryList() {
        return Object.values(this.memoryMap);
    }

    get keywords() {
        const keywords = new Set<string>();
        this.memoryList.forEach(m => m.keywords.forEach(kw => keywords.add(kw)));
        return Array.from(keywords);
    }

    async addMemory(ctx: seal.MsgContext, ai: AI, ul: UserInfo[], gl: GroupInfo[], kws: string[], images: Image[], text: string) {
        let id = generateId(), a = 0;
        while (this.memoryMap.hasOwnProperty(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                logger.error(`生成记忆id失败，已尝试1000次，放弃`);
                return;
            }
        }

        for (const id of this.memoryIds) {
            const m = this.memoryMap[id];
            if (text === m.text && m.sessionInfo.id === ai.id && getCommonUser(ul, m.userList).length > 0 && getCommonGroup(gl, m.groupList).length > 0) {
                m.keywords = Array.from(new Set([...m.keywords, ...kws]));
                logger.info(`记忆已存在，id:${id}，合并关键词:${m.keywords.join(',')}`);
                return;
            }
        }

        // 添加文本内插入的图片
        const imgIdSet = new Set(images.map(img => img.id));
        (await ImageManager.extractExistingImagesToSave(ctx, ai, text)).forEach(img => {
            if (imgIdSet.has(img.id)) return;
            imgIdSet.add(img.id);
            images.push(img);
        });

        const now = Math.floor(Date.now() / 1000);
        const m = new Memory();
        m.id = id;
        m.text = text;
        m.sessionInfo = {
            id: ai.id,
            isPrivate: ctx.isPrivate,
            name: ctx.isPrivate ? ctx.player.name : ctx.group.groupName,
        };
        m.userList = ul;
        m.groupList = gl;
        m.createTime = now;
        m.lastMentionTime = now;
        m.keywords = kws;
        m.weight = 5;
        m.images = images;
        await m.updateVector();
        this.limitMemory();
        this.memoryMap[id] = m;
    }

    deleteMemory(ids: string[] = [], kws: string[] = []) {
        if (ids.length === 0 && kws.length === 0) return;

        ids.forEach(id => delete this.memoryMap?.[id])

        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                if (kws.some(kw => this.memoryMap[id].keywords.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    limitMemory() {
        const { memoryLimit } = ConfigManager.memory;
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

    limitShortMemory() {
        const { shortMemoryLimit } = ConfigManager.memory;
        if (this.shortMemoryList.length > shortMemoryLimit) {
            this.shortMemoryList.splice(0, this.shortMemoryList.length - shortMemoryLimit);
        }
    }

    clearShortMemory() {
        this.shortMemoryList = [];
    }

    async updateShortMemory(ctx: seal.MsgContext, msg: seal.Message, ai: AI) {
        if (!this.useShortMemory) {
            return;
        }

        const { url: chatUrl, apiKey: chatApiKey } = ConfigManager.request;
        const { isPrefix, showNumber, showMsgId, showTime } = ConfigManager.message;
        const { shortMemorySummaryRound, memoryUrl, memoryApiKey, memoryBodyTemplate, memoryPromptTemplate } = ConfigManager.memory;

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
                    ToolManager.toolMap["add_memory"].solve(ctx, msg, ai, m);
                });
            }
        } catch (e) {
            logger.error(`更新短期记忆失败: ${e.message}`);
        }
    }

    async search(query: string, options: searchOptions = {
        topK: 10,
        userList: [],
        groupList: [],
        keywords: [],
        includeImages: false,
        method: 'score'
    }) {
        if (!this.memoryList.length) return [];
        const { userList: ul, groupList: gl, keywords: kws, includeImages, method } = options;

        const { isMemoryVector, embeddingDimension } = ConfigManager.memory;
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
                if (includeImages && m.images.length === 0) return null;
                const mc = m.copy;
                if (mc.keywords.some(kw => query.includes(kw))) mc.weight += 10; //提权
                return mc;
            })
            .filter(m => m)
            .sort((a, b) => {
                switch (method) {
                    case 'weight': return b.weight - a.weight;
                    case 'similarity': return b.calculateSimilarity(qv, ul, gl, kws) - a.calculateSimilarity(qv, ul, gl, kws);
                    case 'score': return b.calculateScore(qv, ul, gl, kws) - a.calculateScore(qv, ul, gl, kws);
                    case 'early': return a.createTime - b.createTime;
                    case 'late': return b.createTime - a.createTime;
                    case 'recent': return b.lastMentionTime - a.lastMentionTime;
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
            if (m.keywords.some(kw => s.includes(kw))) {
                m.weight = Math.max(10, m.weight + increase);
                m.lastMentionTime = now;
            } else {
                m.weight = Math.min(0, m.weight - decrease);
            }
        }
    }

    updateRelatedMemoryWeight(ctx: seal.MsgContext, context: Context, s: string, role: 'user' | 'assistant') {
        // bot记忆权重更新
        AIManager.getAI(ctx.endPoint.userId).memory.updateMemoryWeight(s, role);
        // 知识库记忆权重更新
        knowledgeMM.updateMemoryWeight(s, role);
        // 会话自身记忆权重更新
        this.updateMemoryWeight(s, role);
        // 群内用户的记忆权重更新
        if (!ctx.isPrivate) context.userInfoList.forEach(ui => AIManager.getAI(ui.id).memory.updateMemoryWeight(s, role));
    }

    async getTopMemoryList(text: string = '', ui: UserInfo = null, gi: GroupInfo = null) {
        const { memoryShowNumber } = ConfigManager.memory;
        return await this.search(text, {
            topK: memoryShowNumber,
            userList: ui ? [ui] : [],
            groupList: gi ? [gi] : [],
            keywords: [],
            includeImages: false,
            method: 'score'
        });
    }

    buildMemory(sessionInfo: SessionInfo, memoryList: Memory[]): string {
        if (this.persona === '无' && memoryList.length === 0) return '';
        const { showNumber } = ConfigManager.message;
        const { memoryShowTemplate, memorySingleShowTemplate } = ConfigManager.memory;

        let memoryContent = '';
        if (memoryList.length === 0) {
            memoryContent = '无';
        } else {
            memoryContent = memoryList
                .map((m, i) => {
                    return memorySingleShowTemplate({
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "记忆时间": fmtDate(m.createTime),
                        "个人记忆": sessionInfo.isPrivate,
                        "私聊": m.sessionInfo.isPrivate,
                        "展示号码": showNumber,
                        "群聊名称": m.sessionInfo.name,
                        "群聊号码": m.sessionInfo.id,
                        "相关用户": m.userList.map(u => u.name + (showNumber ? `(${u.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "相关群聊": m.groupList.map(g => g.name + (showNumber ? `(${g.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.keywords.join(';'),
                        "记忆内容": m.text
                    });
                }).join('\n');
        }

        return memoryShowTemplate({
            "私聊": sessionInfo.isPrivate,
            "展示号码": showNumber,
            "用户名称": sessionInfo.name,
            "用户号码": sessionInfo.id.replace(/^.+:/, ''),
            "群聊名称": sessionInfo.name,
            "群聊号码": sessionInfo.id.replace(/^.+:/, ''),
            "设定": this.persona,
            "记忆列表": memoryContent
        }) + '\n';
    }

    async buildMemoryPrompt(ctx: seal.MsgContext, context: Context, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        const ai = AIManager.getAI(ctx.endPoint.userId);
        let s = ai.memory.buildMemory({
            isPrivate: true,
            id: ctx.endPoint.userId,
            name: seal.formatTmpl(ctx, "核心:骰子名字")
        }, await ai.memory.getTopMemoryList(text, ui, gi));

        if (ctx.isPrivate) {
            return this.buildMemory({
                isPrivate: true,
                id: ctx.player.userId,
                name: ctx.player.name
            }, await ai.memory.getTopMemoryList(text, ui, gi));
        } else {
            // 群聊记忆
            s += this.buildMemory({
                isPrivate: false,
                id: ctx.group.groupId,
                name: ctx.group.groupName
            }, await ai.memory.getTopMemoryList(text, ui, gi));

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
                }, await ai.memory.getTopMemoryList(text, ui, gi));
            }

            return s;
        }
    }

    findImage(id: string): Image | null {
        for (const m of this.memoryList) {
            const image = m.images.find(img => img.id === id);
            if (image) {
                m.weight += 0.2;
                return image;
            }
        }
        return null;
    }

    findMemoryAndImageByImageIdPrefix(id: string): { memory: Memory, image: Image } | null {
        for (const m of this.memoryList) {
            const image = m.images.find(img => img.id.replace(/_\d+$/, "") === id);
            if (image) {
                m.weight += 0.2;
                return { memory: m, image };
            }
        }
        return null;
    }
}

export class KnowledgeMemoryManager extends MemoryManager {
    constructor() {
        super();
    }

    init() {
        this.memoryMap = JSON.parse(ConfigManager.ext.storageGet('knowledgeMemoryMap') || '{}');
        this.reviveMemoryMap();
    }

    save() {
        ConfigManager.ext.storageSet('knowledgeMemoryMap', JSON.stringify(this.memoryMap));
    }

    async updateKnowledgeMemory(roleIndex: number) {
        const { knowledgeMemoryStringList } = ConfigManager.memory;
        if (roleIndex < 0 || roleIndex >= knowledgeMemoryStringList.length) return;
        const s = knowledgeMemoryStringList[roleIndex];
        if (!s) return;

        const memoryMap: { [id: string]: Memory } = {}
        const segs = s.split(/\n-{3,}\n/);
        for (const seg of segs) {
            if (!seg.trim()) continue;

            const lines = seg.split('\n');
            if (lines.length === 0) continue;

            const m = new Memory();
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
                        m.keywords = value.split(/[,，]/).map(kw => kw.trim()).filter(kw => kw);
                        break;
                    }
                    case '图片': {
                        const { localImagePathMap } = ConfigManager.image;

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
                        m.text = lines.slice(i).join('\n').trim().replace(/^内容[:：]/, '');
                        break;
                    }
                    default: continue;
                }
            }

            if (!m.id && !m.text) continue;

            memoryMap[m.id] = m;
        }

        const now = Math.floor(Date.now() / 1000);
        await Promise.all(Object.values(memoryMap).map(async m => {
            if (this.memoryMap.hasOwnProperty(m.id)) {
                const m2 = this.memoryMap[m.id];
                m.vector = m2.vector;
                if (m2.text !== m.text) await m.updateVector();
                m.createTime = m2.createTime;
                m.lastMentionTime = m2.lastMentionTime;
                m.weight = m2.weight;
            } else {
                await m.updateVector();
                m.createTime = now;
                m.lastMentionTime = now;
                m.weight = 5;
            }
        }))

        this.memoryMap = memoryMap;
        this.save();
    }

    buildKnowledgeMemory(memoryList: Memory[]) {
        const { showNumber } = ConfigManager.message;
        const { knowledgeMemorySingleShowTemplate } = ConfigManager.memory;
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
                        "关键词": m.keywords.join(';'),
                        "记忆内容": m.text
                    });
                }).join('\n');
        }

        return prompt;
    }

    async buildKnowledgeMemoryPrompt(roleIndex: number, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        await this.updateKnowledgeMemory(roleIndex);
        if (this.memoryIds.length === 0) return '';

        const { knowledgeMemoryShowNumber } = ConfigManager.memory;
        const memoryList = await this.search(text, {
            topK: knowledgeMemoryShowNumber,
            userList: ui ? [ui] : [],
            groupList: gi ? [gi] : [],
            keywords: [],
            includeImages: false,
            method: 'score'
        });

        return this.buildKnowledgeMemory(memoryList);
    }
}

export const knowledgeMM = new KnowledgeMemoryManager();

// 可以通过维护一组索引来优化搜索性能。
// 好麻烦，不想弄
// 目前数量级应该没什么优化的需求