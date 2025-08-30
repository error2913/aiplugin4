import Handlebars from "handlebars";
import { ConfigManager } from "../config/config";
import { AI, AIManager } from "./AI";
import { Context, Message } from "./context";
import { generateId } from "../utils/utils";
import { logger } from "../logger";
import { fetchData } from "../service";
import { parseBody } from "../utils/utils_message";
import { ToolManager } from "../tool/tool";

export interface MemoryInfo {
    id: string;
    isPrivate: boolean;
    player: {
        userId: string;
        name: string;
    }
    group: {
        groupId: string;
        groupName: string;
    }
    time: string;
    createTime: number; // 秒级时间戳
    lastMentionTime: number;
    keywords: string[];
    content: string;
    weight: number; // 记忆权重，0-10
}

export class Memory {
    persona: string;
    memoryMap: { [key: string]: MemoryInfo };
    useShortMemory: boolean;
    shortMemoryList: string[];

    constructor() {
        this.persona = '无';
        this.memoryMap = {};
        this.useShortMemory = false;
        this.shortMemoryList = [];
    }

    static reviver(value: any): Memory {
        const memory = new Memory();
        const validKeys = ['persona', 'memoryMap', 'useShortMemory', 'shortMemory'];

        for (const k in value) {
            if (validKeys.includes(k)) {
                memory[k] = value[k];
            }
        }

        return memory;
    }

    addMemory(ctx: seal.MsgContext, kws: string[], content: string) {
        let id = generateId(), a = 0;
        while (this.memoryMap.hasOwnProperty(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                logger.error(`生成记忆id失败，已尝试1000次，放弃`);
                return;
            }
        }

        this.memoryMap[id] = {
            id,
            isPrivate: ctx.isPrivate,
            player: {
                userId: ctx.player.userId,
                name: ctx.player.name
            },
            group: {
                groupId: ctx.group.groupId,
                groupName: ctx.group.groupName
            },
            time: new Date().toLocaleString(),
            createTime: Math.floor(Date.now() / 1000),
            lastMentionTime: Math.floor(Date.now() / 1000),
            keywords: kws || [],
            content: content || '',
            weight: 0
        };

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
                const mi = this.memoryMap[id];
                if (kws.some(kw => mi.keywords.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    clearMemory() {
        this.memoryMap = {};
    }

    clearShortMemory() {
        this.shortMemoryList = [];
    }

    limitMemory() {
        const { memoryLimit } = ConfigManager.memory;
        const now = Math.floor(Date.now() / 1000);
        const d = 24 * 60 * 60;
        const memoryList = Object.values(this.memoryMap);

        const forgetIdList = memoryList
            .map((item) => {
                // 基础新鲜度衰减（按天计算）
                const ageDecay = Math.log10((now - item.createTime) / d + 1);
                // 活跃度衰减因子（最近接触按小时衰减）
                const activityDecay = Math.max(1, (now - item.lastMentionTime) / 3600);
                // 权重转换（0-10 → 1.0-3.0 指数曲线）
                const importance = Math.pow(1.1161, item.weight);
                return {
                    id: item.id,
                    fgtWeight: (ageDecay * activityDecay) / importance
                }
            })
            .sort((a, b) => b.fgtWeight - a.fgtWeight)
            .slice(0, memoryList.length - memoryLimit)
            .map(item => item.id);

        this.delMemory(forgetIdList);
    }

    limitShortMemory() {
        const { shortMemoryLimit } = ConfigManager.memory;
        if (this.shortMemoryList.length > shortMemoryLimit) {
            this.shortMemoryList.splice(0, this.shortMemoryList.length - shortMemoryLimit);
        }
    }

    async updateShortMemory(ctx: seal.MsgContext, msg: seal.Message, ai: AI, sumMessages: Message[]) {
        if (!this.useShortMemory) {
            return;
        }

        const { url: chatUrl, apiKey: chatApiKey } = ConfigManager.request;
        const { roleSettingTemplate, isPrefix, showNumber, showMsgId } = ConfigManager.message;
        const { memoryUrl, memoryApiKey, memoryBodyTemplate, memoryPromptTemplate } = ConfigManager.memory;

        let url = chatUrl;
        let apiKey = chatApiKey;
        if (memoryUrl.trim()) {
            url = memoryUrl;
            apiKey = memoryApiKey;
        }

        try {
            let [roleSettingIndex, _] = seal.vars.intGet(ctx, "$gSYSPROMPT");
            if (roleSettingIndex < 0 || roleSettingIndex >= roleSettingTemplate.length) {
                roleSettingIndex = 0;
            }
            const prompt = Handlebars.compile(memoryPromptTemplate[0])({
                "角色设定": roleSettingTemplate[roleSettingIndex],
                "平台": ctx.endPoint.platform,
                "私聊": ctx.isPrivate,
                "展示号码": showNumber,
                "用户名称": ctx.player.name,
                "用户号码": ctx.player.userId.replace(/^.+:/, ''),
                "群聊名称": ctx.group.groupName,
                "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
                "添加前缀": isPrefix,
                "展示消息ID": showMsgId,
                "对话内容": isPrefix ? sumMessages.map(message => {
                    if (message.role === 'assistant' && message?.tool_calls && message?.tool_calls.length > 0) {
                        return `\n[function_call]: ${message.tool_calls.map((tool_call, index) => `${index + 1}. ${JSON.stringify(tool_call.function, null, 2)}`).join('\n')}`;
                    }
                    const prefix = (isPrefix && message.name) ? (
                        message.name.startsWith('_') ?
                            `<|${message.name}|>` :
                            `<|from:${message.name}${showNumber ? `(${message.uid.replace(/^.+:/, '')})` : ``}|>`
                    ) : '';
                    const content = message.msgIdArray.map((msgId, index) => (showMsgId && msgId ? `<|msg_id:${msgId}|>` : '') + message.contentArray[index]).join('\f');

                    return `[${message.role}]: ${prefix}${content}`;
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

    updateSingleMemoryWeight(s: string, role: 'user' | 'assistant') {
        const increase = role === 'user' ? 1 : 0.1;
        const decrease = role === 'user' ? 0.1 : 0;
        const now = Math.floor(Date.now() / 1000);

        for (const id in this.memoryMap) {
            const mi = this.memoryMap[id];
            if (mi.keywords.some(kw => s.includes(kw))) {
                mi.weight = Math.max(10, mi.weight + increase);
                mi.lastMentionTime = now;
            } else {
                mi.weight = Math.min(0, mi.weight - decrease);
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

    buildMemory(isPrivate: boolean, un: string, uid: string, gn: string, gid: string, lastMsg: string = ''): string {
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
            memoryContent += memoryList
                .map(item => {
                    const mi: MemoryInfo = JSON.parse(JSON.stringify(item));
                    if (item.keywords.some(kw => lastMsg.includes(kw))) {
                        mi.weight += 10;
                    }
                    return mi;
                })
                .sort((a, b) => b.weight - a.weight)
                .slice(0, memoryShowNumber)
                .map((item, i) => {
                    const data = {
                        "序号": i + 1,
                        "记忆ID": item.id,
                        "记忆时间": item.time,
                        "个人记忆": uid, //有uid代表这是个人记忆
                        "私聊": item.isPrivate,
                        "展示号码": showNumber,
                        "群聊名称": item.group.groupName,
                        "群聊号码": item.group.groupId.replace(/^.+:/, ''),
                        "关键词": item.keywords.join(';'),
                        "记忆内容": item.content
                    }

                    const template = Handlebars.compile(memorySingleShowTemplate[0]);
                    return template(data);
                }).join('\n');
        }

        const data = {
            "私聊": isPrivate,
            "展示号码": showNumber,
            "用户名称": un,
            "用户号码": uid.replace(/^.+:/, ''),
            "群聊名称": gn,
            "群聊号码": gid.replace(/^.+:/, ''),
            "设定": this.persona,
            "记忆列表": memoryContent
        }

        const template = Handlebars.compile(memoryShowTemplate[0]);
        return template(data) + '\n';
    }

    buildMemoryPrompt(ctx: seal.MsgContext, context: Context): string {
        const userMessages = context.messages.filter(msg => msg.role === 'user' && !msg.name.startsWith('_'));
        const lastMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1].contentArray.join('') : '';

        const ai = AIManager.getAI(ctx.endPoint.userId);
        let s = ai.memory.buildMemory(true, seal.formatTmpl(ctx, "核心:骰子名字"), ctx.endPoint.userId, '', '', lastMsg);

        if (ctx.isPrivate) {
            return this.buildMemory(true, ctx.player.name, ctx.player.userId, '', '');
        } else {
            // 群聊记忆
            s += this.buildMemory(false, '', '', ctx.group.groupName, ctx.group.groupId);

            // 群内用户的个人记忆
            const arr = [];
            for (const message of userMessages) {
                const name = message.name;
                const uid = message.uid;
                if (arr.includes(uid)) {
                    continue;
                }

                const ai = AIManager.getAI(uid);
                s += ai.memory.buildMemory(true, name, uid, '', '');

                arr.push(uid);
            }

            return s;
        }
    }
}