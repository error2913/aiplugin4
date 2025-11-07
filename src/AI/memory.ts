import Handlebars from "handlebars";
import { ConfigManager } from "../config/config";
import { AI, AIManager } from "./AI";
import { Context, GroupInfo, SessionInfo, UserInfo } from "./context";
import { cosineSimilarity, generateId, hasCommonGroup, hasCommonKeyword, hasCommonUser, revive } from "../utils/utils";
import { logger } from "../logger";
import { fetchData, getEmbedding } from "../service";
import { buildContent, parseBody } from "../utils/utils_message";
import { ToolManager } from "../tool/tool";
import { fmtDate } from "../utils/utils_string";
import { Image, ImageManager } from "./image";

export interface searchOptions {
    topK: number;
    userList: UserInfo[];
    groupList: GroupInfo[];
    keywords: string[];
    includeImages: boolean;
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
            sessionId: '',
            isPrivate: false,
            sessionName: '',
        };
        this.userList = [];
        this.groupList = [];
        this.createTime = 0;
        this.lastMentionTime = 0;
        this.keywords = [];
        this.weight = 0;
        this.images = [];
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
            }
        }
    }

    async addMemory(ctx: seal.MsgContext, ai: AI, ul: UserInfo[], gl: GroupInfo[], kws: string[], text: string) {
        let id = generateId(), a = 0;
        while (this.memoryMap.hasOwnProperty(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                logger.error(`生成记忆id失败，已尝试1000次，放弃`);
                return;
            }
        }

        for (const id of Object.keys(this.memoryMap)) {
            const m = this.memoryMap[id];
            if (text === m.text && m.sessionInfo.sessionId === ai.id && hasCommonUser(ul, m.userList) && hasCommonGroup(gl, m.groupList)) {
                m.keywords = Array.from(new Set([...m.keywords, ...kws]));
                logger.info(`记忆已存在，id:${id}，合并关键词:${m.keywords.join(',')}`);
                return;
            }
        }

        const now = Math.floor(Date.now() / 1000);
        const m = new Memory();
        m.id = id;
        m.text = text;
        m.sessionInfo = {
            sessionId: ai.id,
            isPrivate: ctx.isPrivate,
            sessionName: ctx.isPrivate ? ctx.player.name : ctx.group.groupName,
        };
        m.userList = ul;
        m.groupList = gl;
        m.createTime = now;
        m.lastMentionTime = now;
        m.keywords = kws;
        m.weight = 5;
        m.images = await ImageManager.extractExistingImages(ai, text);

        const { isMemoryVector, embeddingDimension } = ConfigManager.memory;
        if (isMemoryVector) {
            const vector = await getEmbedding(text);
            if (!vector.length) {
                logger.error('向量为空');
                return null;
            }
            if (vector.length !== embeddingDimension) {
                logger.error(`向量维度不匹配。期望: ${embeddingDimension}, 实际: ${vector.length}`);
                return null;
            }
            m.vector = vector;
        }

        this.memoryMap[id] = m;

        this.limitMemory();
    }

    delMemory(idList: string[] = [], kws: string[] = []) {
        if (idList.length === 0 && kws.length === 0) {
            return;
        }

        idList.forEach(id => {
            delete this.memoryMap?.[id];
        })

        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                const m = this.memoryMap[id];
                if (kws.some(kw => m.keywords.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    limitMemory() {
        const { memoryLimit } = ConfigManager.memory;
        const now = Math.floor(Date.now() / 1000);
        const memoryList = Object.values(this.memoryMap);

        const forgetIdList = memoryList
            .map((m) => {
                const d = 24 * 60 * 60;
                // 基础新鲜度衰减（按天计算）
                const ageDecay = Math.log10((now - m.createTime) / d + 1);
                // 活跃度衰减因子（最近接触按小时衰减）
                const activityDecay = Math.max(1, (now - m.lastMentionTime) / 3600);
                // 权重转换（0-10 → 1.0-3.0 指数曲线）
                const importance = Math.pow(1.1161, m.weight);
                return {
                    id: m.id,
                    fgtWeight: (ageDecay * activityDecay) / importance
                }
            })
            .sort((a, b) => b.fgtWeight - a.fgtWeight)
            .slice(0, memoryList.length - memoryLimit)
            .map(item => item.id);

        this.delMemory(forgetIdList);
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
        const { roleSettingNames, roleSettingTemplate, isPrefix, showNumber, showMsgId, showTime } = ConfigManager.message;
        const { shortMemorySummaryRound, memoryUrl, memoryApiKey, memoryBodyTemplate, memoryPromptTemplate } = ConfigManager.memory;

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
            const [roleName, exists] = seal.vars.strGet(ctx, "$gSYSPROMPT");
            let roleIndex = 0;
            if (exists && roleName !== '' && roleSettingNames.includes(roleName)) {
                roleIndex = roleSettingNames.indexOf(roleName);
                if (roleIndex < 0 || roleIndex >= roleSettingTemplate.length) {
                    roleIndex = 0;
                }
            } else {
                const [roleIndex2, exists2] = seal.vars.intGet(ctx, "$gSYSPROMPT");
                if (exists2 && roleIndex2 >= 0 && roleIndex2 < roleSettingTemplate.length) {
                    roleIndex = roleIndex2;
                }
            }
            const prompt = Handlebars.compile(memoryPromptTemplate[0])({
                "角色设定": roleSettingTemplate[roleIndex],
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
                        keywords: string[],
                        content: string
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

    // 语义搜索
    async search(query: string, options: searchOptions = {
        topK: 10,
        userList: [],
        groupList: [],
        keywords: [],
        includeImages: false,
    }) {
        const { isMemoryVector, embeddingDimension } = ConfigManager.memory;
        const filteredMemoryList = Object.values(this.memoryMap)
            .filter(item =>
                (!options.userList.length || hasCommonUser(item.userList, options.userList)) &&
                (!options.groupList.length || hasCommonGroup(item.groupList, options.groupList)) &&
                (!options.keywords.length || hasCommonKeyword(item.keywords, options.keywords)) &&
                (!options.includeImages || item.images.length > 0)
            );
        if (!filteredMemoryList.length) {
            return [];
        }

        if (isMemoryVector && query) {
            try {
                const queryVector = await getEmbedding(query);
                if (!queryVector.length) {
                    logger.error('查询向量为空');
                    return [];
                }
                for (const m of filteredMemoryList) {
                    if (m.vector.length !== embeddingDimension) {
                        logger.info(`记忆向量维度不匹配，重新获取向量: ${m.id}`);
                        m.vector = await getEmbedding(m.text);
                    }
                }
                return filteredMemoryList
                    .sort((a, b) => {
                        const aScore = cosineSimilarity(queryVector, a.vector);
                        const bScore = cosineSimilarity(queryVector, b.vector);
                        return bScore - aScore;
                    })
                    .slice(0, options.topK);
            } catch (e) {
                logger.error(`语义搜索失败: ${e.message}`);
            }
        }
        return filteredMemoryList
            .map(item => {
                const mi: Memory = JSON.parse(JSON.stringify(item));
                if (item.keywords.some(kw => query.includes(kw))) {
                    mi.weight += 10; //提权
                }
                return mi;
            })
            .sort((a, b) => b.weight - a.weight);
    }

    updateSingleMemoryWeight(s: string, role: 'user' | 'assistant') {
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

    updateMemoryWeight(ctx: seal.MsgContext, context: Context, s: string, role: 'user' | 'assistant') {
        const ai = AIManager.getAI(ctx.endPoint.userId);
        ai.memory.updateSingleMemoryWeight(s, role);
        this.updateSingleMemoryWeight(s, role);

        if (!ctx.isPrivate) {
            // 群内用户的记忆权重更新
            const arr = [];
            for (const message of context.messages) {
                const uid = message.uid;
                if (arr.includes(uid) || message.role !== 'user') {
                    continue;
                }

                const name = message.name;
                if (name.startsWith('_')) {
                    continue;
                }

                const ai = AIManager.getAI(uid);
                ai.memory.updateSingleMemoryWeight(s, role);

                arr.push(uid);
            }
        }
    }

    async buildMemory(sessionInfo: SessionInfo, lastMsg: string): Promise<string> {
        const { showNumber } = ConfigManager.message;
        const { memoryShowNumber, memoryShowTemplate, memorySingleShowTemplate } = ConfigManager.memory;
        const memoryList = Object.values(this.memoryMap);

        if (memoryList.length === 0 && this.persona === '无') {
            return '';
        }

        let memoryContent = '';
        if (memoryList.length === 0) {
            memoryContent += '无';
        } else {
            const searchResult = await this.search(lastMsg, {
                topK: memoryShowNumber,
                userList: [],
                groupList: [],
                keywords: [],
                includeImages: false,
            });

            memoryContent += searchResult
                .map((m, i) => {
                    const data = {
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "记忆时间": fmtDate(m.createTime),
                        "个人记忆": sessionInfo.isPrivate,
                        "私聊": m.sessionInfo.isPrivate,
                        "展示号码": showNumber,
                        "群聊名称": m.sessionInfo.sessionName,
                        "群聊号码": m.sessionInfo.sessionId,
                        "相关用户": m.userList.map(u => u.name + (showNumber ? `(${u.userId.replace(/^.+:/, '')})` : '')).join(';'),
                        "相关群聊": m.groupList.map(g => g.groupName + (showNumber ? `(${g.groupId.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.keywords.join(';'),
                        "记忆内容": m.text
                    }

                    const template = Handlebars.compile(memorySingleShowTemplate[0]);
                    return template(data);
                }).join('\n');
        }

        const data = {
            "私聊": sessionInfo.isPrivate,
            "展示号码": showNumber,
            "用户名称": sessionInfo.sessionName,
            "用户号码": sessionInfo.sessionId.replace(/^.+:/, ''),
            "群聊名称": sessionInfo.sessionName,
            "群聊号码": sessionInfo.sessionId.replace(/^.+:/, ''),
            "设定": this.persona,
            "记忆列表": memoryContent
        }

        const template = Handlebars.compile(memoryShowTemplate[0]);
        return template(data) + '\n';
    }

    async buildMemoryPrompt(ctx: seal.MsgContext, context: Context): Promise<string> {
        const userMessages = context.messages.filter(msg => msg.role === 'user' && !msg.name.startsWith('_'));
        const lastMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1].msgArray.map(m => m.content).join('') : '';

        const ai = AIManager.getAI(ctx.endPoint.userId);
        let s = await ai.memory.buildMemory({
            isPrivate: true,
            sessionName: seal.formatTmpl(ctx, "核心:骰子名字"),
            sessionId: ctx.endPoint.userId
        }, lastMsg);

        if (ctx.isPrivate) {
            return this.buildMemory({
                isPrivate: true,
                sessionName: ctx.player.name,
                sessionId: ctx.player.userId
            }, lastMsg);
        } else {
            // 群聊记忆
            s += await this.buildMemory({
                isPrivate: false,
                sessionName: ctx.group.groupName,
                sessionId: ctx.group.groupId
            }, lastMsg);

            // 群内用户的个人记忆
            const arr = [];
            for (const message of userMessages) {
                const name = message.name;
                const uid = message.uid;
                if (arr.includes(uid)) {
                    continue;
                }

                const ai = AIManager.getAI(uid);
                s += ai.memory.buildMemory({
                    isPrivate: true,
                    sessionName: name,
                    sessionId: uid
                }, lastMsg);

                arr.push(uid);
            }

            return s;
        }
    }

    findImage(id: string): Image | null {
        for (const m of Object.values(this.memoryMap)) {
            const image = m.images.find(item => item.id === id);
            if (image) {
                return image;
            }
        }
        return null;
    }
}