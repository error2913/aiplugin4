import { ToolCall } from "../tool/tool";
import { ConfigManager } from "../config/config";
import { Image } from "./image";
import { createCtx, createMsg } from "../utils/utils_seal";
import { levenshteinDistance, MessageSegment } from "../utils/utils_string";
import { AI, AIManager, UserInfo } from "./AI";
import { logger } from "../logger";
import { transformMsgId } from "../utils/utils";
import { getGroupMemberInfo, getStrangerInfo } from "../utils/utils_ob11";

export interface MessageInfo {
    msgId: string;
    time: number; // 秒
    content: string;
}

export interface Message {
    role: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;

    uid: string;
    name: string;
    images: Image[];
    msgArray: MessageInfo[];
}

export class Context {
    static validKeys: (keyof Context)[] = ['messages', 'ignoreList', 'summaryCounter', 'autoNameMod'];
    messages: Message[];
    ignoreList: string[];
    summaryCounter: number; // 用于短期记忆自动总结计数
    autoNameMod: number; // 自动修改上下文里的名字，0:不自动修改，1:修改为昵称，2:修改为群名片

    lastReply: string;
    counter: number;
    timer: number;

    constructor() {
        this.messages = [];
        this.ignoreList = [];
        this.summaryCounter = 0;
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
    }

    reviveMessages() {
        this.messages = this.messages.map(message => {
            if (!message.hasOwnProperty('role')) return null;
            if (!message.hasOwnProperty('uid')) return null;
            if (!message.hasOwnProperty('name')) return null;
            if (!message.hasOwnProperty('images')) return null;
            if (!message.hasOwnProperty('msgArray')) return null;

            message.msgArray = message.msgArray.map(msgInfo => {
                if (!msgInfo.hasOwnProperty('msgId')) return null;
                if (!msgInfo.hasOwnProperty('time')) return null;
                if (!msgInfo.hasOwnProperty('content')) return null;

                return msgInfo;
            }).filter(msgInfo => msgInfo);

            return message;
        }).filter(message => message);
    }

    clearMessages(...roles: string[]) {
        if (roles.length === 0) {
            this.summaryCounter = 0;
            this.messages = [];
        } else {
            this.messages = this.messages.filter(message => {
                if (roles.includes(message.role)) {
                    this.summaryCounter--;
                    return false;
                }
                return true;
            });
        }
    }

    async addMessage(ctx: seal.MsgContext, msg: seal.Message, ai: AI, messageArray: MessageSegment[], images: Image[], role: 'user' | 'assistant', msgId: string = '') {
        const { showNumber, showMsgId, maxRounds } = ConfigManager.message;
        const { isShortMemory, shortMemorySummaryRound } = ConfigManager.memory;
        const messages = this.messages;

        //处理文本
        const s = messageArray.map(item => {
            switch (item.type) {
                case 'text': {
                    return item.data.text;
                }
                case 'at': {
                    const epId = ctx.endPoint.userId;
                    const gid = ctx.group.groupId;
                    const uid = `QQ:${item.data.qq || ''}`;
                    const mmsg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
                    const mctx = createCtx(epId, mmsg);
                    const name = mctx.player.name || '未知用户';

                    return `<|at:${name}${showNumber ? `(${uid.replace(/^.+:/, '')})` : ``}|>`;
                }
                case 'poke': {
                    const epId = ctx.endPoint.userId;
                    const gid = ctx.group.groupId;
                    const uid = `QQ:${item.data.qq || ''}`;
                    const mmsg = createMsg(gid === '' ? 'private' : 'group', uid, gid);
                    const mctx = createCtx(epId, mmsg);
                    const name = mctx.player.name || '未知用户';

                    return `<|poke:${name}${showNumber ? `(${uid.replace(/^.+:/, '')})` : ``}|>`;
                }
                case 'reply': {
                    return showMsgId ? `<|quote:${transformMsgId(item.data.id || '')}|>` : ``;
                }
                default: {
                    return '';
                }
            }
        }).join('');

        if (s === '') {
            return;
        }

        const uid = role == 'user' ? ctx.player.userId : ctx.endPoint.userId;

        // 自动更新上下文里的名字
        const exists = messages.some(message => message.uid === uid);
        if (!exists) {
            await this.updateName(ctx.endPoint.userId, ctx.group.groupId, uid);
        }

        // 检查清除上下文，1:清除所有上下文，2:清除assistant和tool上下文，3:清除user上下文
        const [clrmsgs, _] = seal.vars.intGet(ctx, "$gCLRMSGS");
        switch (clrmsgs) {
            case 1: {
                ai.context.clearMessages();
                seal.vars.intSet(ctx, "$gCLRMSGS", 0);
                logger.info('标志位为1，清除所有上下文');
                break;
            }
            case 2: {
                ai.context.clearMessages('assistant', 'tool');
                seal.vars.intSet(ctx, "$gCLRMSGS", 0);
                logger.info('标志位为2，清除assistant和tool上下文');
                break;
            }
            case 3: {
                ai.context.clearMessages('user');
                seal.vars.intSet(ctx, "$gCLRMSGS", 0);
                logger.info('标志位为3，清除user上下文');
                break;
            }
        }

        // 添加消息到上下文
        const name = role == 'user' ? ctx.player.name : seal.formatTmpl(ctx, "核心:骰子名字");
        const length = messages.length;
        if (length !== 0 && messages[length - 1].uid === uid && !/<[\|│｜]?function(?:_call)?>/.test(s)) {
            messages[length - 1].images.push(...images);
            messages[length - 1].msgArray.push({
                msgId: msgId,
                time: Math.floor(Date.now() / 1000),
                content: s
            });
        } else {
            const message: Message = {
                role: role,
                uid: uid,
                name: name,
                images: images,
                msgArray: [{
                    msgId: msgId,
                    time: Math.floor(Date.now() / 1000),
                    content: s
                }]
            };
            messages.push(message);

            // 更新短期记忆
            if (isShortMemory) {
                if (role === 'user') {
                    this.summaryCounter++;
                }
                if (this.summaryCounter >= shortMemorySummaryRound) {
                    this.summaryCounter = 0;
                    ai.memory.updateShortMemory(ctx, msg, ai);
                }
            }
        }

        //更新记忆权重
        ai.memory.updateMemoryWeight(ctx, ai.context, s, role);

        //删除多余的上下文
        this.limitMessages(maxRounds);
    }

    async addToolCallsMessage(tool_calls: ToolCall[]) {
        const message: Message = {
            role: 'assistant',
            tool_calls: tool_calls,
            uid: '',
            name: '',
            images: [],
            msgArray: []
        };
        this.messages.push(message);
    }

    async addToolMessage(tool_call_id: string, s: string, images: Image[]) {
        const message: Message = {
            role: 'tool',
            tool_call_id: tool_call_id,
            uid: '',
            name: '',
            images: images,
            msgArray: [{
                msgId: '',
                time: Math.floor(Date.now() / 1000),
                content: s
            }]
        };

        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i]?.tool_calls && this.messages[i].tool_calls.some(tool_call => tool_call.id === tool_call_id)) {
                this.messages.splice(i + 1, 0, message);
                return;
            }
        }

        logger.error(`在添加时找不到对应的 tool_call_id: ${tool_call_id}`);
    }

    async addSystemUserMessage(name: string, s: string, images: Image[]) {
        const message: Message = {
            role: 'user',
            uid: '',
            name: `_${name}`,
            images: images,
            msgArray: [{
                msgId: '',
                time: Math.floor(Date.now() / 1000),
                content: s
            }]
        };
        this.messages.push(message);
    }

    limitMessages(maxRounds: number) {
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

    async findUserId(ctx: seal.MsgContext, name: string | number, findInFriendList: boolean = false): Promise<string> {
        name = String(name);

        if (!name) {
            return null;
        }

        if (name.length > 4 && !isNaN(parseInt(name))) {
            const uid = `QQ:${name}`;
            return this.ignoreList.includes(uid) ? null : uid;
        }

        const match = name.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
        if (match) {
            name = match[1] || match[2];
        }

        if (name === ctx.player.name) {
            const uid = ctx.player.userId;
            return this.ignoreList.includes(uid) ? null : uid;
        }

        if (name === seal.formatTmpl(ctx, "核心:骰子名字")) {
            return ctx.endPoint.userId;
        }

        // 在上下文中查找用户
        const messages = this.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (name === messages[i].name) {
                const uid = messages[i].uid;
                return this.ignoreList.includes(uid) ? null : uid;
            }
            if (name.length > 4) {
                const distance = levenshteinDistance(name, messages[i].name);
                if (distance <= 2) {
                    const uid = messages[i].uid;
                    return this.ignoreList.includes(uid) ? null : uid;
                }
            }
        }

        // 在群成员列表、好友列表中查找用户
        const net = globalThis.net || globalThis.http;
        if (net) {
            const epId = ctx.endPoint.userId;

            if (!ctx.isPrivate) {
                const gid = ctx.group.groupId;
                const data = await net.callApi(epId, `get_group_member_list?group_id=${gid.replace(/^.+:/, '')}`);
                for (let i = 0; i < data.length; i++) {
                    if (name === data[i].card || name === data[i].nickname) {
                        const uid = `QQ:${data[i].user_id}`;
                        return this.ignoreList.includes(uid) ? null : uid;
                    }
                }
            }

            if (findInFriendList) {
                const data = await net.callApi(epId, 'get_friend_list');
                for (let i = 0; i < data.length; i++) {
                    if (name === data[i].nickname || name === data[i].remark) {
                        const uid = `QQ:${data[i].user_id}`;
                        return this.ignoreList.includes(uid) ? null : uid;
                    }
                }
            }
        }

        if (name.length > 4) {
            const distance = levenshteinDistance(name, ctx.player.name);
            if (distance <= 2) {
                const uid = ctx.player.userId;
                return this.ignoreList.includes(uid) ? null : uid;
            }
        }

        logger.warning(`未找到用户<${name}>`);
        return null;
    }

    async findGroupId(ctx: seal.MsgContext, groupName: string | number): Promise<string> {
        groupName = String(groupName);

        if (!groupName) {
            return null;
        }

        if (groupName.length > 5 && !isNaN(parseInt(groupName))) {
            return `QQ-Group:${groupName}`;
        }

        const match = groupName.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
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
            const memoryList = Object.values(ai.memory.memoryMap);

            for (const m of memoryList) {
                if (m.sessionInfo.isPrivate && m.sessionInfo.name === groupName) {
                    return m.sessionInfo.id;
                }
                if (m.sessionInfo.isPrivate && m.sessionInfo.name.length > 4) {
                    const distance = levenshteinDistance(groupName, m.sessionInfo.name);
                    if (distance <= 2) {
                        return m.sessionInfo.id;
                    }
                }
            }

            userSet.add(uid);
        }

        // 在群聊列表中查找用户
        const net = globalThis.net || globalThis.http;
        if (net) {
            const epId = ctx.endPoint.userId;
            const data = await net.callApi(epId, 'get_group_list');
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

        logger.warning(`未找到群聊<${groupName}>`);
        return null;
    }

    get userInfoList(): UserInfo[] {
        const userMap: { [key: string]: UserInfo } = {};
        this.messages.forEach(message => {
            if (message.role === 'user' && message.name && message.uid && !message.name.startsWith('_')) {
                userMap[message.uid] = {
                    isPrivate: true,
                    id: message.uid,
                    name: message.name
                };
            }
        });
        return Object.values(userMap);
    }

    async setName(epId: string, gid: string, uid: string, mod: 'nickname' | 'card') {
        let name = '';
        switch (mod) {
            case 'nickname': {
                const strangerInfo = await getStrangerInfo(epId, uid.replace(/^.+:/, ''));
                if (!strangerInfo || !strangerInfo.nickname) {
                    logger.warning(`未找到用户<${uid}>的昵称`);
                    break;
                }
                name = strangerInfo.nickname;
                break;
            }
            case 'card': {
                if (!gid) {
                    break;
                }
                const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), uid.replace(/^.+:/, ''));
                if (!memberInfo) {
                    logger.warning(`获取用户<${uid}>的群成员信息失败，尝试使用昵称`);
                    this.setName(epId, gid, uid, 'nickname');
                    break;
                }
                name = memberInfo.card;
                if (!name) {
                    name = memberInfo.nickname;
                }
                if (!name) {
                    this.setName(epId, gid, uid, 'nickname');
                    break;
                }
                break;
            }
        }
        if (!name) {
            logger.warning(`用户<${uid}>未设置昵称或群名片`);
            return;
        }
        const msg = createMsg(gid ? 'group' : 'private', uid, gid);
        const ctx = createCtx(epId, msg);
        ctx.player.name = name;
        this.messages.forEach(message => {
            if (message.uid === uid) {
                message.name = name;
            }
        });
    }

    async updateName(epId: string, gid: string, uid: string) {
        switch (this.autoNameMod) {
            case 1: {
                await this.setName(epId, gid, uid, 'nickname');
                break;
            }
            case 2: {
                await this.setName(epId, gid, uid, 'card');
                break;
            }
        }
    }

    findImage(id: string, ai: AI): Image | null {
        // 从上下文中查找图片
        const messages = this.messages;
        const userSet = new Set<string>();
        for (let i = messages.length - 1; i >= 0; i--) {
            const image = messages[i].images.find(item => item.id === id);
            if (image) {
                return image;
            }

            const uid = messages[i].uid;
            if (userSet.has(uid) || messages[i].role !== 'user') {
                continue;
            }
            const name = messages[i].name;
            if (name.startsWith('_')) {
                continue;
            }

            const ai2 = AIManager.getAI(uid);
            const image2 = ai2.memory.findImage(id);
            if (image2) {
                return image2;
            }
        }

        // 从自己记忆中查找图片
        const image = ai.memory.findImage(id);
        if (image) {
            return image;
        }

        const { localImagePaths } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
            if (path.trim() === '') {
                return acc;
            }
            try {
                const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
                if (!name) {
                    throw new Error(`本地图片路径格式错误:${path}`);
                }

                acc[name] = path;
            } catch (e) {
                logger.error(e);
            }
            return acc;
        }, {});

        if (localImages.hasOwnProperty(id)) {
            return new Image(localImages[id]);
        }

        const savedImage = ai.imageManager.savedImages.find(img => img.id === id);
        if (savedImage) {
            const filePath = seal.base64ToImage(savedImage.base64);
            savedImage.file = filePath;
            return savedImage;
        }

        return null;
    }
}
