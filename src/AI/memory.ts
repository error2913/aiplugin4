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
        const { showNumber } = ConfigManager.message;
        
        let s = `\n- 设定:${this.persona}\n- 记忆:\n`;

        if (this.memoryList.length === 0) {
            s += '无';
        } else {
            s += this.memoryList.map((item, i) => {
                const source = item.isPrivate ?
                    `私聊` :
                    `群聊<${item.group.groupName}>${showNumber ? `(${item.group.groupId.replace(/\D+/g, '')})` : ``}`;

                return `${i + 1}. 时间:${item.time}
    来源:${source}
    内容:${item.content}`;
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
                return `${i + 1}. 时间:${item.time}
    内容:${item.content}`;
            }).join('\n');
        }

        return s;
    }

    buildMemoryPrompt(ctx: seal.MsgContext, context: Context): string {
        const { showNumber } = ConfigManager.message;

        if (ctx.isPrivate) {
            return this.buildPersonMemoryPrompt();
        } else {
            // 群聊记忆
            const gid = ctx.group.groupId;
            let s = `\n- 关于群聊:<${ctx.group.groupName}>${showNumber ? `(${gid.replace(/\D+/g, '')})` : ``}:`;
            s += this.buildGroupMemoryPrompt();

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

                s += `\n\n关于<${name}>${showNumber ? `(${uid.replace(/\D+/g, '')})` : ``}:`;
                s += ai.memory.buildPersonMemoryPrompt();

                arr.push(uid);
            }

            return s;
        }
    }

    clearMemory() {
        this.memoryList = [];
    }
}