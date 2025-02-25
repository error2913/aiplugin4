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
        if (Math.random() < 0.5) {
            this.persona = '好人';
        } else {
            this.persona = '坏人';
        }
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

    setSystemMemory(s: string) {
        if (!s) {
            if (Math.random() < 0.5) {
                s = '好人';
            } else {
                s = '坏人';
            }
        }

        this.persona = s;
    }

    addMemory(ctx: seal.MsgContext, content: string) {
        const { memoryLimit } = ConfigManager.tool;

        content = content.slice(0, 100);

        this.memoryList.push({
            isPrivate: ctx.group.groupName ? false : true,
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

    buildPersonMemoryPrompt(): string {
        let s = `\n- 设定:${this.persona}\n- 记忆:\n`;

        if (this.memoryList.length === 0) {
            s += '无';
        } else {
            s += this.memoryList.map((item, i) => {
                return `${i + 1}. (${item.time}) ${item.isPrivate ? `来自私聊` : `来自群聊<${item.group.groupName}>`}: ${item.content}`;
            }).join('\n');
        }

        return s;
    }

    buildGroupMemoryPrompt(): string {
        let s = `\n- 记忆:\n`;

        if (this.memoryList.length === 0) {
            s += '无'; 
        } else {
            s += this.memoryList.map((item, i) => {
                return `${i + 1}. (${item.time}) ${item.content}`;
            }).join('\n');
        }

        return s;
    }

    buildMemoryPrompt(ctx: seal.MsgContext, context: Context): string {
        const { showQQ } = ConfigManager.message;

        if (ctx.isPrivate) {
            return this.buildPersonMemoryPrompt();
        } else {
            // 群聊记忆
            let s = `\n- 关于群聊:<${ctx.group.groupName}>:`;
            s += this.buildGroupMemoryPrompt();

            // 群内用户的个人记忆
            const arr = [];
            for (const message of context.messages) {
                if (!arr.includes(message.uid) && message.role === 'user') {
                    const uid = message.uid;
                    const name = message.name;

                    // 过滤掉系统消息
                    if (name.startsWith('_')) {
                        continue;
                    }

                    const ai = AIManager.getAI(uid);

                    s += `\n\n关于<${name}>${showQQ ? `(${uid.replace(/\D+/g, '')})` : ``}:`;
                    s += ai.memory.buildPersonMemoryPrompt();

                    arr.push(uid);
                }
            }

            return s;
        }
    }

    clearMemory() {
        this.memoryList = [];
    }
}