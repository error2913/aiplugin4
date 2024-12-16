import { ConfigManager } from "../utils/configUtils";
import { getNameById, levenshteinDistance } from "../utils/utils";
import { AIManager } from "./AIManager";

export interface Message {
    role: string;
    content: string;
    uid: string;
    name: string;
    timestamp: number;
}

export class Context {
    messages: Message[];
    lastReply: string;
    counter: number;
    timer: number;
    interrupt: {
        act: number,
        timestamp: number
    }
    memories: {
        system: string[],
        [key: string]: string[]
    }

    constructor() {
        this.messages = [];
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
        this.interrupt = {
            act: 0,
            timestamp: 0
        }
        this.memories = {
            system: []
        };
    }

    static parse(data: any): Context {
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            data = {};
        }

        const context = new Context();

        if (data.hasOwnProperty('messages') && Array.isArray(data.messages)) {
            for (const message of data.messages) {
                if (
                    message.hasOwnProperty('role') && typeof message.role === 'string' &&
                    message.hasOwnProperty('content') && typeof message.content === 'string' &&
                    message.hasOwnProperty('uid') && typeof message.uid === 'string' &&
                    message.hasOwnProperty('name') && typeof message.name === 'string' &&
                    message.hasOwnProperty('timestamp') && typeof message.timestamp === 'number'
                ) {
                    context.messages.push({
                        role: message.role,
                        content: message.content,
                        uid: message.uid,
                        name: message.name,
                        timestamp: message.timestamp
                    });
                }
            }
        }

        if (data.hasOwnProperty('lastReply') && typeof data.lastReply === 'string') {
            context.lastReply = data.lastReply;
        }

        if (data.hasOwnProperty('counter') && typeof data.counter === 'number') {
            context.counter = data.counter;
        }

        if (data.hasOwnProperty('timer') && typeof data.timer === 'number') {
            context.timer = data.timer;
        }

        if (data.hasOwnProperty('interrupt') && typeof data.interrupt === 'object' && !Array.isArray(data.interrupt)) {
            if (data.interrupt.hasOwnProperty('act') && typeof data.interrupt.act === 'number') {
                context.interrupt.act = data.interrupt.act;
            }
            if (data.interrupt.hasOwnProperty('timestamp') && typeof data.interrupt.timestamp === 'number') {
                context.interrupt.timestamp = data.interrupt.timestamp;
            }
        }

        if (data.hasOwnProperty('memories') && typeof data.memories === 'object' && !Array.isArray(data.memories)) {
            for (const k in data.memories) {
                if (data.memories.hasOwnProperty(k) && Array.isArray(data.memories[k])) {
                    context.memories[k] = data.memories[k];
                }
            }
        }

        return context;
    }

    async iteration(ctx: seal.MsgContext, s: string, role: 'user' | 'assistant') {
        const messages = this.messages;

        const { maxRounds, ctxCacheTime } = ConfigManager.getStorageConfig();

        // 从尾部开始检查是否超过缓存时间，超过则清理掉
        const timestamp = Math.floor(Date.now() / 1000);
        for (let i = messages.length - 1; i >= 0; i--) {
            if (timestamp - messages[i].timestamp > ctxCacheTime) {
                messages.splice(0, i + 1);
                break;
            }
        }

        //处理文本
        if (role === 'assistant') {
            s = s
                .replace(/\[图:.*?\]/g, '')
                .replace(/\[语音:.*?\]/g, '')
                .replace(/\[视频:.*?\]/g, '')
        }
        s = s
            .replace(/\[CQ:reply,id=-?\d+\]\[CQ:at,qq=\d+\]/g, '')
            .replace(/\[CQ:at,qq=(\d+)\]/g, (_, p1) => {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group.groupId;
                const uid = `QQ:${p1}`;
                const dice_name = seal.formatTmpl(ctx, "核心:骰子名字");
                return `<@${getNameById(epId, gid, uid, dice_name)}>`;
            })
            .replace(/\[CQ:.*?\]/g, '')

        //更新上下文
        const name = role == 'user' ? ctx.player.name : seal.formatTmpl(ctx, "核心:骰子名字");
        const uid = role == 'user' ? ctx.player.userId : ctx.endPoint.userId;
        const rounds = messages.length;
        if (rounds !== 0 && messages[rounds - 1].name === name) {
            this.messages[rounds - 1].content += ' ' + s;
        } else {
            const message = {
                role: role,
                content: s,
                uid: uid,
                name: name,
                timestamp: timestamp
            };
            messages.push(message);
        }

        //删除多余的上下文
        if (rounds > maxRounds) {
            this.messages = messages.slice(-maxRounds);
        }
    }

    setSystemMemory(s: string) {
        this.memories.system = [s];
    }

    getMemoryLength(): number {
        let length = 0;
        for (const k in this.memories) {
            if (k === 'system') {
                continue;
            }
            length += this.memories[k].length;
        }
        return length;
    }

    addMemory(k: string, s: string) {
        const { extraMemory } = ConfigManager.getMemoryConfig();

        if (!k) {
            k = '私聊';
        }

        if (!this.memories.hasOwnProperty(k)) {
            this.memories[k] = [];
        }

        s = s.slice(0, 100);
        this.memories[k].push(s);

        // 超过上限时，从最长的记忆处弹出
        let length = this.getMemoryLength();
        while (length > extraMemory) {
            let maxLength = 0;
            let maxKey = '';
            for (const k in this.memories) {
                if (k ==='system') {
                    continue;
                }
                if (this.memories[k].length > maxLength) {
                    maxLength = this.memories[k].length;
                    maxKey = k;
                }
            }

            this.memories[maxKey].shift();
            if (this.memories[maxKey].length === 0) {
                delete this.memories[maxKey];
            }

            length = this.getMemoryLength();
        }
    }

    getPrivateMemoryPrompt(): string {
        let s = '';
        for (const key in this.memories) {
            if (this.memories[key].length === 0) {
                continue;
            }
            if (key === 'system') {
                s += `\n- 设定记忆:${this.memories.system.join('、')}`;
            } else {
                s += `\n- 在<${key}>中的记忆:${this.memories[key].join('、')}`;
            }
        }
        return s;
    }

    getMemoryPrompt(ctx: seal.MsgContext): string {
        let s = '';
        if (ctx.isPrivate) {
            s += this.getPrivateMemoryPrompt();
        } else {
            const arr = [];
            for (const message of this.messages) {
                if (!arr.includes(message.uid) && message.role === 'user') {
                    const name = message.name;
                    const uid = message.uid;
                    const ai = AIManager.getAI(uid);
                    const text = ai.context.getPrivateMemoryPrompt();
                    if (text) {
                        s += `\n有关<${name}>:${text}`;
                    }
                    arr.push(uid);
                }
            }
        }

        return s;
    }

    clearMemory() {
        this.memories = {
            system: []
        };
    }

    findUid(name: string): string {
        const messages = this.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (name === messages[i].name) {
                return messages[i].uid;
            }

            if (name.length > 5) {
                const distance = levenshteinDistance(name, messages[i].name);
                if (distance <= 2) {
                    return messages[i].uid;
                }
            }
        }
        return null;
    }

    getNames(): string[] {
        const names = [];
        for (const message of this.messages) {
            if (message.role === 'user' && message.name && !names.includes(message.name)) {
                names.push(message.name);
            }
        }
        return names;
    }
}
