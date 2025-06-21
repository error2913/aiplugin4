import Handlebars from "handlebars";
import { ConfigManager } from "../config/config";
import { AIManager } from "./AI";
import { Context } from "./context";
import { generateId } from "../utils/utils";
import { logger } from "./logger";

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

    constructor() {
        this.persona = '无';
        this.memoryMap = {};
    }

    static reviver(value: any): Memory {
        const memory = new Memory();
        const validKeys = ['persona', 'memoryMap'];

        for (const k in value) {
            if (validKeys.includes(k)) {
                memory[k] = value[k];
            }
        }

        return memory;
    }

    addMemory(ctx: seal.MsgContext, kw: string[], content: string) {
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
            keywords: kw,
            content: content,
            weight: 0
        };

        this.limitMemory();
    }

    delMemory(idList: string[] = [], kw: string[] = []) {
        if (idList.length === 0 && kw.length === 0) {
            return;
        }

        idList.forEach(id => {
            delete this.memoryMap?.[id];
        })

        if (kw.length > 0) {
            for (const id in this.memoryMap) {
                const mi = this.memoryMap[id];
                if (kw.some(kw => mi.keywords.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
    }

    clearMemory() {
        this.memoryMap = {};
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