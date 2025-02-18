import { ConfigManager } from "../config/config";
import { AIManager } from "./AI";
import { Context } from "./context";

export interface MemoryInfo {
    isPrivate: boolean;
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

    addMemory(gid: string, gn: string, content: string) {
        const { memoryLimit } = ConfigManager.tool;

        content = content.slice(0, 100);

        this.memoryList.push({
            isPrivate: gn ? false : true,
            group: {
                groupId: gid,
                groupName: gn
            },
            time: new Date().toLocaleString(),
            content: content
        });

        this.memoryList.splice(0, this.memoryList.length - memoryLimit);
    }

    getPlayerMemoryPrompt(): string {
        let s = `\n- 设定:${this.persona}`;
        s += `\n- 记忆:\n`;
        s += this.memoryList.map((item, i) => {
            return `${i + 1}. (${item.time}) ${item.isPrivate ? `来自私聊` : `来自群聊<${item.group.groupName}>`}: ${item.content}`;
        }).join('\n');
        return s;
    }

    getMemoryPrompt(ctx: seal.MsgContext, context: Context): string {
        if (ctx.isPrivate) {
            return this.getPlayerMemoryPrompt();
        } else {
            let s = '';
            const arr = [];
            for (const message of context.messages) {
                if (!arr.includes(message.uid) && message.role === 'user') {
                    const name = message.name;
                    const uid = message.uid;
                    const ai = AIManager.getAI(uid);
                    const text = ai.memory.getPlayerMemoryPrompt();
                    if (text) {
                        s += `\n关于<${name}>:${text}`;
                    }
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