import Handlebars from "handlebars";
import { ConfigManager } from "../config/config";
import { AIManager } from "./AI";
import { Context } from "./context";

export interface MemoryInfo {
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
    content: string;
}

export class Memory {
    persona: string;
    memoryList: MemoryInfo[];

    constructor() {
        this.persona = '无';
        this.memoryList = [];
    }

    static reviver(value: any): Memory {
        const memory = new Memory();
        const validKeys = ['persona', 'memoryList'];

        for (const k in value) {
            if (validKeys.includes(k)) {
                memory[k] = value[k];
            }
        }

        return memory;
    }

    addMemory(ctx: seal.MsgContext, content: string) {
        const { memoryLimit } = ConfigManager.tool;

        content = content.slice(0, 100);

        this.memoryList.push({
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
            content: content
        });

        this.memoryList.splice(0, this.memoryList.length - memoryLimit);
    }

    delMemory(indexList: number[]) {
        indexList.sort((a, b) => b - a);
        for (const index of indexList) {
            this.memoryList.splice(index - 1, 1);
        }
    }

    /**
     * 
     * @param ctx 
     * @param name 构建个人记忆时传入
     * @param uid 构建个人记忆时传入
     * @returns 
     */
    buildMemory(ctx: seal.MsgContext, name: string = '', uid: string = ''): string {
        const { showNumber } = ConfigManager.message;
        const { memoryShowTemplate, memorySingleShowTemplate } = ConfigManager.tool;

        let memoryContent = '';
        if (this.memoryList.length === 0) {
            memoryContent += '无';
        } else {
            memoryContent += this.memoryList.map((item, i) => {
                const data = {
                    "序号": i + 1,
                    "记忆时间": item.time,
                    "个人记忆": uid, //有uid代表这是个人记忆
                    "私聊": item.isPrivate,
                    "展示号码": showNumber,
                    "群聊名称": item.group.groupName,
                    "群聊号码": item.group.groupId.replace(/^.+:/, ''),
                    "记忆内容": item.content
                }
                
                const template = Handlebars.compile(memorySingleShowTemplate[0]);
                return template(data);
            }).join('\n');
        }

        const data = {
            "私聊": ctx.isPrivate,
            "展示号码": showNumber,
            "用户名称": name,
            "用户号码": uid.replace(/^.+:/, ''),
            "群聊名称": ctx.group.groupName,
            "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
            "设定": this.persona,
            "记忆列表": memoryContent
        }

        const template = Handlebars.compile(memoryShowTemplate[0]);
        return template(data);
    }

    buildMemoryPrompt(ctx: seal.MsgContext, context: Context): string {
        if (ctx.isPrivate) {
            return this.buildMemory(ctx, ctx.player.name, ctx.player.userId);
        } else {
            // 群聊记忆
            let s = this.buildMemory(ctx);

            // 群内用户的个人记忆
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

                s += ai.memory.buildMemory(ctx, name, uid);

                arr.push(uid);
            }

            return s;
        }
    }

    clearMemory() {
        this.memoryList = [];
    }
}