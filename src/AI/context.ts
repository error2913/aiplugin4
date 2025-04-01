import { ToolCall } from "../tool/tool";
import { ConfigManager } from "../config/config";
import { Image } from "./image";
import { createCtx, createMsg } from "../utils/utils_seal";
import { levenshteinDistance } from "../utils/utils_string";
import { AIManager } from "./AI";
import { log } from "../utils/utils";

export interface Message {
    role: string;
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;

    uid: string;
    name: string;
    timestamp: number;
    images: Image[];
    contentMap: { [key: string]: string };
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

    clearMessages(...roles: string[]) {
        if (roles.length === 0) {
            this.messages = [];
        } else {
            this.messages = this.messages.filter(message => !roles.includes(message.role));
        }
    }

    async addMessage(ctx: seal.MsgContext, s: string, images: Image[], role: 'user' | 'assistant', msgId: string) {
        const { showNumber, maxRounds } = ConfigManager.message;
        const messages = this.messages;

        //处理文本
        s = s
            .replace(/\[CQ:reply,id=-?\d+\]\[CQ:at,qq=\d+\]/g, '')
            .replace(/\[CQ:at,qq=(\d+)\]/g, (_, p1) => {
                const epId = ctx.endPoint.userId;
                const gid = ctx.group.groupId;
                const uid = `QQ:${p1}`;
                const mmsg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
                const mctx = createCtx(epId, mmsg);
                const name = mctx.player.name || '未知用户';

                return `<|@${name}${showNumber ? `(${uid.replace(/\D+/g, '')})` : ``}|>`;
            })
            .replace(/\[CQ:.*?\]/g, '')

        if (s === '') {
            return;
        }

        //更新上下文
        const name = role == 'user' ? ctx.player.name : seal.formatTmpl(ctx, "核心:骰子名字");
        const uid = role == 'user' ? ctx.player.userId : ctx.endPoint.userId;
        const length = messages.length;
        if (length !== 0 && messages[length - 1].name === name && !s.startsWith('<function_call>')) {
            messages[length - 1].timestamp = Math.floor(Date.now() / 1000);
            messages[length - 1].images.push(...images);
            if (!msgId) {
                const seg = role === 'assistant' ? '' : '\n';
                messages[length - 1].content += seg + s;
            } else {
                messages[length - 1].contentMap[msgId] = s;
            }
        } else {
            const message = {
                role: role,
                content: '',
                uid: uid,
                name: name,
                timestamp: Math.floor(Date.now() / 1000),
                images: images,
                contentMap: {}
            };
            if (!msgId) {
                message.content = s;
            } else {
                message.contentMap[msgId] = s;
            }
            messages.push(message);
        }

        //删除多余的上下文
        this.limitMessages(maxRounds);
    }

    async addToolCallsMessage(tool_calls: ToolCall[]) {
        const message = {
            role: 'assistant',
            content: '',
            tool_calls: tool_calls,
            uid: '',
            name: '',
            timestamp: Math.floor(Date.now() / 1000),
            images: [],
            contentMap: {}
        };
        this.messages.push(message);
    }

    async addToolMessage(tool_call_id: string, s: string) {
        const message = {
            role: 'tool',
            content: s,
            tool_call_id: tool_call_id,
            uid: '',
            name: '',
            timestamp: Math.floor(Date.now() / 1000),
            images: [],
            contentMap: {}
        };

        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i]?.tool_calls && this.messages[i].tool_calls.some(tool_call => tool_call.id === tool_call_id)) {
                this.messages.splice(i + 1, 0, message);
                return;
            }
        }

        console.error(`在添加时找不到对应的 tool_call_id: ${tool_call_id}`);
    }

    async addSystemUserMessage(name: string, s: string, images: Image[]) {
        const message = {
            role: 'user',
            content: s,
            uid: '',
            name: `_${name}`,
            timestamp: Math.floor(Date.now() / 1000),
            images: images,
            contentMap: {}
        };
        this.messages.push(message);
    }

    async limitMessages(maxRounds: number) {
        const messages = this.messages;
        let round = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user' && !messages[i].name.startsWith('_')) {
                round++;
            }
            if (round > maxRounds) {
                messages.splice(0, i);
                break;
            }
        }
    }

    async findUserId(ctx: seal.MsgContext, name: string, findInFriendList: boolean = false): Promise<string> {
        if (name.length > 4 && !isNaN(parseInt(name))) {
            return `QQ:${name}`;
        }

        const match = name.match(/^<([^>]+?)>(?:\(\d+\))?$|(.+?)\(\d+\)$/);
        if (match) {
            name = match[1] || match[2];
        }

        if (name === ctx.player.name) {
            return ctx.player.userId;
        }

        // 在上下文中查找用户
        const messages = this.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (name === messages[i].name) {
                return messages[i].uid;
            }
            if (name.length > 4) {
                const distance = levenshteinDistance(name, messages[i].name);
                if (distance <= 2) {
                    return messages[i].uid;
                }
            }
        }

        // 在群成员列表、好友列表中查找用户
        const ext = seal.ext.find('HTTP依赖');
        if (ext) {
            const epId = ctx.endPoint.userId;

            if (!ctx.isPrivate) {
                const gid = ctx.group.groupId;
                const data = await globalThis.http.getData(epId, `get_group_member_list?group_id=${gid.replace(/\D+/g, '')}`);
                for (let i = 0; i < data.length; i++) {
                    if (name === data[i].card || name === data[i].nickname) {
                        return `QQ:${data[i].user_id}`;
                    }
                }
            }

            if (findInFriendList) {
                const data = await globalThis.http.getData(epId, 'get_friend_list');
                for (let i = 0; i < data.length; i++) {
                    if (name === data[i].nickname || name === data[i].remark) {
                        return `QQ:${data[i].user_id}`;
                    }
                }
            }
        }

        if (name.length > 4) {
            const distance = levenshteinDistance(name, ctx.player.name);
            if (distance <= 2) {
                return ctx.player.userId;
            }
        }

        log(`未找到用户<${name}>`);
        return null;
    }

    async findGroupId(ctx: seal.MsgContext, groupName: string): Promise<string> {
        if (groupName.length > 5 && !isNaN(parseInt(groupName))) {
            return `QQ-Group:${groupName}`;
        }

        const match = groupName.match(/^<([^>]+?)>(?:\(\d+\))?$|(.+?)\(\d+\)$/);
        if (match) {
            groupName = match[1] || match[2];
        }

        if (groupName === ctx.group.groupName) {
            return ctx.group.groupId;
        }

        // 在上下文中用户的记忆中查找群聊
        const messages = this.messages;
        const userSet = new Set<string>();
        for (let i = messages.length - 1; i >= 0; i--) {
            const uid = messages[i].uid;
            if (userSet.has(uid) || messages[i].role !== 'user') {
                continue;
            }

            const name = messages[i].name;
            if (name.startsWith('_')) {
                continue;
            }

            const ai = AIManager.getAI(uid);
            const memoryList = ai.memory.memoryList;

            for (const memory of memoryList) {
                if (memory.group.groupName === groupName) {
                    return memory.group.groupId;
                }
                if (memory.group.groupName.length > 4) {
                    const distance = levenshteinDistance(groupName, memory.group.groupName);
                    if (distance <= 2) {
                        return memory.group.groupId;
                    }
                }
            }

            userSet.add(uid);
        }

        // 在群聊列表中查找用户
        const ext = seal.ext.find('HTTP依赖');
        if (ext) {
            const epId = ctx.endPoint.userId;
            const data = await globalThis.http.getData(epId, 'get_group_list');
            for (let i = 0; i < data.length; i++) {
                if (groupName === data[i].group_name) {
                    return `QQ-Group:${data[i].group_id}`;
                }
            }
        }

        if (groupName.length > 4) {
            const distance = levenshteinDistance(groupName, ctx.group.groupName);
            if (distance <= 2) {
                return ctx.group.groupId;
            }
        }

        log(`未找到群聊<${groupName}>`);
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
