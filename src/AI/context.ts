import { ToolCall } from "../tools/tool";
import { ConfigManager } from "../config/config";
import { Image } from "./image";
import { getNameById } from "../utils/utils_seal";
import { levenshteinDistance } from "../utils/utils_string";

export interface Message {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;

    uid: string;
    name: string;
    timestamp: number;
    images: Image[];
}

export class Context {
    messages: Message[];
    lastReply: string;
    counter: number;
    timer: number;

    constructor() {
        this.messages = [];
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
    }

    static reviver(value: any): Context {
        const context = new Context();
        const validKeys = ['messages'];

        for (const k of validKeys) {
            if (value.hasOwnProperty(k)) {
                context[k] = value[k];
            }
        }

        return context;
    }

    async iteration(ctx: seal.MsgContext, s: string, images: Image[], role: 'user' | 'assistant') {
        const messages = this.messages;

        // 如果是assistant，且最后一条消息是tool_calls，则不处理，防止在处理tool_calls时插入user消息
        if (role === 'user' && messages.length !== 0 && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1]?.tool_calls) {
            return;
        }

        const { showQQ, maxRounds } = ConfigManager.message;

        //处理文本
        s = s
            .replace(/\[CQ:reply,id=-?\d+\]\[CQ:at,qq=\d+\]/g, '')
            .replace(/\[CQ:at,qq=(\d+)\]/g, (_, p1) => {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group.groupId;
                const uid = `QQ:${p1}`;
                const dice_name = seal.formatTmpl(ctx, "核心:骰子名字");
                const name = getNameById(epId, gid, uid, dice_name);

                // 防止重名问题
                if (showQQ) {
                    const index = messages.findIndex(item => item.name === name && item.uid !== uid);
                    if (index !== -1) {
                        return `<@${uid.replace(/\D+/g, '')}）`;
                    }
                }

                return `<@${name}>`;
            })
            .replace(/\[CQ:.*?\]/g, '')

        if (s === '') {
            return;
        }

        //更新上下文
        const name = role == 'user' ? ctx.player.name : seal.formatTmpl(ctx, "核心:骰子名字");
        const uid = role == 'user' ? ctx.player.userId : ctx.endPoint.userId;
        const length = messages.length;
        if (length !== 0 && messages[length - 1].name === name) {
            messages[length - 1].content += ' ' + s;
            messages[length - 1].timestamp = Math.floor(Date.now() / 1000);
            messages[length - 1].images.push(...images);
        } else {
            const message = {
                role: role,
                content: s,
                uid: uid,
                name: name,
                timestamp: Math.floor(Date.now() / 1000),
                images: images
            };
            messages.push(message);
        }

        //删除多余的上下文
        this.limitMessages(maxRounds);
    }

    async toolCallsIteration(tool_calls: ToolCall[]) {
        const message = {
            role: 'assistant',
            content: '',
            tool_calls: tool_calls,
            uid: '',
            name: '',
            timestamp: Math.floor(Date.now() / 1000),
            images: []
        };
        this.messages.push(message);
    }

    async toolIteration(tool_call_id: string, s: string) {
        const message = {
            role: 'tool',
            content: s,
            tool_call_id: tool_call_id,
            uid: '',
            name: '',
            timestamp: Math.floor(Date.now() / 1000),
            images: []
        };
        this.messages.push(message);
    }

    async systemUserIteration(name: string, s: string) {
        const message = {
            role: 'user',
            content: s,
            uid: '',
            name: name,
            timestamp: Math.floor(Date.now() / 1000),
            images: []
        };
        this.messages.push(message);
    }

    async limitMessages(maxRounds: number) {
        const messages = this.messages;
        let round = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                round++;
            }
            if (round > maxRounds) {
                messages.splice(0, i);
                break;
            }
        }
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

        const raw_uid = name.replace(/\D+/g, '');
        return raw_uid ? `QQ:${raw_uid}` : null;
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

    findImage(id: string): Image {
        const messages = this.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            const image = messages[i].images.find(item => item.id === id);
            if (image) {
                return image;
            }
        }
        return null;
    }
}
