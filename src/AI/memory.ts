import { ConfigManager } from "../utils/configUtils";
import { levenshteinDistance } from "../utils/utils";
import { AIManager } from "./AI";
import { Context } from "./context";

export class Memory {
    system: string;
    memories: { [key: string]: string[] };

    constructor() {
        if (Math.random() < 0.5) {
            this.system = '好人';
        } else {
            this.system = '坏人';
        }
        this.memories = {};
    }

    static reviver(value: any): Memory {
        const memory = new Memory();
        const validKeys = ['system', 'memories'];

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

        this.system = s;
    }

    getMemoryLength(): number {
        let length = 0;
        for (const k in this.memories) {
            length += this.memories[k].length;
        }
        return length;
    }

    addMemory(k: string, s: string) {
        const { extraMemory } = ConfigManager.getMemoryConfig();

        k = k ? k.trim() : '私聊';

        if (!this.memories.hasOwnProperty(k)) {
            this.memories[k] = [];
        }

        s = s.slice(0, 100);

        // 相似内容则替换
        if (s.length > 4 && levenshteinDistance(s, this.memories[k][this.memories[k].length - 1]) < 5) {
            this.memories[k][this.memories[k].length - 1] = s;
        } else {
            this.memories[k].push(s);
        }

        // 超过上限时，从最长的记忆处弹出
        while (this.getMemoryLength() > extraMemory) {
            let maxLength = 0;
            let maxKey = '';
            for (const k in this.memories) {
                if (this.memories[k].length > maxLength) {
                    maxLength = this.memories[k].length;
                    maxKey = k;
                }
            }

            this.memories[maxKey].shift();
            if (this.memories[maxKey].length === 0) {
                delete this.memories[maxKey];
            }
        }
    }

    getPrivateMemoryPrompt(): string {
        let s = `\n- 设定记忆:${this.system}`;
        for (const k in this.memories) {
            if (this.memories[k].length === 0) {
                delete this.memories[k];
                continue;
            }

            s += `\n- 在<${k}>中的记忆:${this.memories[k].join('、')}`;
        }
        return s;
    }

    getMemoryPrompt(ctx: seal.MsgContext, context: Context): string {
        let s = '';
        if (ctx.isPrivate) {
            s += this.getPrivateMemoryPrompt();
        } else {
            const arr = [];
            for (const message of context.messages) {
                if (!arr.includes(message.uid) && message.role === 'user') {
                    const name = message.name;
                    const uid = message.uid;
                    const ai = AIManager.getAI(uid);
                    const text = ai.memory.getPrivateMemoryPrompt();
                    if (text) {
                        s += `\n关于<${name}>:${text}`;
                    }
                    arr.push(uid);
                }
            }
        }

        return s;
    }

    clearMemory() {
        this.memories = {};
    }
}