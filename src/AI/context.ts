import { ToolCall } from "../tool/tool";
import { ConfigManager } from "../config/configManager";
import { Image, ImageManager } from "./image";
import { getCtxAndMsg } from "../utils/utils_seal";
import { levenshteinDistance } from "../utils/utils_string";
import { AI, AIManager, GroupInfo, UserInfo } from "./AI";
import { logger } from "../logger";
import { netExists, getFriendList, getGroupList, getGroupMemberInfo, getGroupMemberList, getStrangerInfo } from "../utils/utils_ob11";
import { revive } from "../utils/utils";
import { sendContextCompressRequest } from "../service";
import { buildRequestMessages } from "../utils/utils_message";

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
    compressingContext: boolean;

    constructor() {
        this.messages = [];
        this.ignoreList = [];
        this.summaryCounter = 0;
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
        this.compressingContext = false;
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

            message.images = message.images.map(image => revive(Image, image));

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

    async addMessage(ctx: seal.MsgContext, msg: seal.Message, ai: AI, content: string, images: Image[], role: 'user' | 'assistant', msgId: string = '') {
        const { isShortMemory, shortMemorySummaryRound } = ConfigManager.memory;
        const messages = this.messages;

        const now = Math.floor(Date.now() / 1000);
        const uid = role == 'user' ? ctx.player.userId : ctx.endPoint.userId;

        // 自动更新上下文里的名字，发言时间一小时内不更新
        if (!messages.some(message => message.uid === uid && message.msgArray.some(msgInfo => msgInfo.time >= now - 3600))) {
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
        if (length !== 0 && messages[length - 1].uid === uid && !/<[\|│｜]?function(?:_call)?>/.test(content)) {
            messages[length - 1].images.push(...images);
            messages[length - 1].msgArray.push({
                msgId: msgId,
                time: now,
                content: content
            });
        } else {
            const message: Message = {
                role: role,
                uid: uid,
                name: name,
                images: images,
                msgArray: [{
                    msgId: msgId,
                    time: now,
                    content: content
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
        ai.memory.updateRelatedMemoryWeight(ctx, ai.context, content, role);

        // 压缩早期上下文
        await this.compressMessagesIfNeeded(ctx);

        //删除多余的上下文
        this.limitMessages();
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
        const now = Math.floor(Date.now() / 1000);
        const message: Message = {
            role: 'tool',
            tool_call_id: tool_call_id,
            uid: '',
            name: '',
            images: images,
            msgArray: [{
                msgId: '',
                time: now,
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
        const now = Math.floor(Date.now() / 1000);
        const message: Message = {
            role: 'user',
            uid: '',
            name: `_${name}`,
            images: images,
            msgArray: [{
                msgId: '',
                time: now,
                content: s
            }]
        };
        this.messages.push(message);
    }

    limitMessages() {
        const { maxRounds } = ConfigManager.message;
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

    async compressMessagesIfNeeded(ctx: seal.MsgContext) {
        const { isContextCompress, contextCompressLength, contextCompressPromptTemplate, maxRounds, isPrefix, showNumber, showMsgId, showTime } = ConfigManager.message;
        const { localImagePathMap, receiveImage, condition } = ConfigManager.image;
        const messages = this.messages;
        if (!isContextCompress) return;
        if (this.compressingContext) return;
        if (maxRounds <= 0 || contextCompressLength <= 0) return;

        const round = messages.filter(message => message.role === 'user' && !message.name.startsWith('_')).length;
        if (round < maxRounds) return;

        let compressCount = Math.min(contextCompressLength, messages.length - 1);
        if (compressCount <= 0) return;

        // 避免切断 tool_call，向前移动
        while (compressCount > 0) {
            const left = messages[compressCount - 1];
            const right = messages[compressCount];
            const leftIsTool = left?.role === 'tool';
            const rightIsTool = right?.role === 'tool';
            const leftIsToolCall = left?.role === 'assistant' && left?.tool_calls && left.tool_calls.length > 0;
            if (!(leftIsTool || rightIsTool || leftIsToolCall)) {
                break;
            }
            compressCount--;
        }
        if (compressCount <= 0 || compressCount >= messages.length) return;

        const compressMessages = messages.slice(0, compressCount);
        const requestMessages = buildRequestMessages(compressMessages);
        if (requestMessages.length === 0) return;

        const sandableImagesPrompt: string = Object.keys(localImagePathMap)
            .map((id, index) => `${index + 1}. ${id}`)
            .join('\n');

        this.compressingContext = true;
        try {
            const prompt = contextCompressPromptTemplate({
                "平台": ctx.endPoint.platform,
                "私聊": ctx.isPrivate,
                "展示号码": showNumber,
                "用户名称": ctx.player.name,
                "用户号码": ctx.player.userId.replace(/^.+:/, ''),
                "群聊名称": ctx.group.groupName,
                "群聊号码": ctx.group.groupId.replace(/^.+:/, ''),
                "添加前缀": isPrefix,
                "展示消息ID": showMsgId,
                "展示时间": showTime,
                "接收图片": receiveImage,
                "图片条件不为零": condition !== '0',
                "可发送图片不为空": sandableImagesPrompt,
                "可发送图片列表": sandableImagesPrompt
            });
            logger.info(`上下文压缩prompt:\n`, prompt);

            const summary = (await sendContextCompressRequest([
                { role: 'system', content: prompt },
                ...requestMessages
            ])).trim();
            if (!summary) {
                logger.warning(`上下文压缩返回为空，跳过本次压缩`);
                return;
            }

            const now = Math.floor(Date.now() / 1000);
            const summaryMessage: Message = {
                role: 'user',
                uid: '',
                name: '_历史上下文摘要',
                images: [],
                msgArray: [{
                    msgId: '',
                    time: now,
                    content: `以下为历史对话摘要:\n${summary}`
                }]
            };

            messages.splice(0, compressCount, summaryMessage);
            logger.info(`上下文压缩完成，压缩条数:${compressCount}，压缩后条数:${messages.length}`);
        } catch (e) {
            logger.error(`上下文压缩失败: ${e.message}`);
        } finally {
            this.compressingContext = false;
        }
    }

    async findUserInfo(ctx: seal.MsgContext, name: string | number, findInFriendList: boolean = false): Promise<UserInfo> {
        name = String(name);
        if (!name) return null;

        if (name.length > 4 && !isNaN(parseInt(name))) {
            const uid = `QQ:${name}`;
            if (this.ignoreList.includes(uid)) return null;
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, uid, ''));
            return { isPrivate: true, id: uid, name: ctx.player.name || '未知用户' };
        }

        const match = name.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
        if (match) name = match[1] || match[2];

        if (name === ctx.player.name) {
            const uid = ctx.player.userId;
            if (this.ignoreList.includes(uid)) return null;
            return { isPrivate: true, id: uid, name };
        }

        if (name === seal.formatTmpl(ctx, "核心:骰子名字")) return { isPrivate: true, id: ctx.endPoint.userId, name: seal.formatTmpl(ctx, "核心:骰子名字") };

        // 在上下文中查找用户
        const messages = this.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (name === messages[i].name) {
                const uid = messages[i].uid;
                if (this.ignoreList.includes(uid)) return null;
                return { isPrivate: true, id: uid, name };
            }
            if (name.length > 4) {
                const distance = levenshteinDistance(name, messages[i].name);
                if (distance <= 2) {
                    const uid = messages[i].uid;
                    if (this.ignoreList.includes(uid)) return null;
                    return { isPrivate: true, id: uid, name };
                }
            }
        }

        // 在群成员列表、好友列表中查找用户
        if (netExists()) {
            const epId = ctx.endPoint.userId;
            const gid = ctx.group.groupId;

            if (!ctx.isPrivate) {
                const groupMemberList = await getGroupMemberList(epId, gid.replace(/^.+:/, ''));
                if (groupMemberList && Array.isArray(groupMemberList)) {
                    const user_id = groupMemberList.find(item => item.card === name || item.nickname === name)?.user_id;
                    if (user_id) {
                        const uid = `QQ:${user_id}`;
                        if (this.ignoreList.includes(uid)) return null;
                        return { isPrivate: true, id: uid, name };
                    }
                }
            }

            if (findInFriendList) {
                const friendList = await getFriendList(epId);
                if (friendList && Array.isArray(friendList)) {
                    const user_id = friendList.find(item => item.nickname === name || item.remark === name)?.user_id;
                    if (user_id) {
                        const uid = `QQ:${user_id}`;
                        if (this.ignoreList.includes(uid)) return null;
                        return { isPrivate: true, id: uid, name };
                    }
                }
            }
        }

        if (name.length > 4) {
            const distance = levenshteinDistance(name, ctx.player.name);
            if (distance <= 2) {
                const uid = ctx.player.userId;
                if (this.ignoreList.includes(uid)) return null;
                return { isPrivate: true, id: uid, name: ctx.player.name };
            }
        }

        logger.warning(`未找到用户<${name}>`);
        return null;
    }

    async findGroupInfo(ctx: seal.MsgContext, groupName: string | number): Promise<GroupInfo> {
        groupName = String(groupName);
        if (!groupName) return null;

        if (groupName.length > 5 && !isNaN(parseInt(groupName))) {
            const gid = `QQ-Group:${groupName}`;
            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gid));
            return { isPrivate: false, id: gid, name: ctx.group.groupName || '未知群聊' };
        }

        const match = groupName.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
        if (match) groupName = match[1] || match[2];

        if (groupName === ctx.group.groupName) return { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };

        // 在上下文中用户的记忆中查找群聊
        const messages = this.messages;
        const userSet = new Set<string>();
        for (let i = messages.length - 1; i >= 0; i--) {
            const uid = messages[i].uid;
            if (userSet.has(uid) || messages[i].role !== 'user') continue;
            const name = messages[i].name;
            if (name.startsWith('_')) continue;

            for (const m of AIManager.getAI(uid).memory.memoryList) {
                if (m.sessionInfo.isPrivate && m.sessionInfo.name === groupName) return { isPrivate: false, id: m.sessionInfo.id, name: m.sessionInfo.name };
                if (m.sessionInfo.isPrivate && m.sessionInfo.name.length > 4) {
                    const distance = levenshteinDistance(groupName, m.sessionInfo.name);
                    if (distance <= 2) return { isPrivate: false, id: m.sessionInfo.id, name: m.sessionInfo.name };
                }
            }

            userSet.add(uid);
        }

        // 在群聊列表中查找用户
        if (netExists()) {
            const epId = ctx.endPoint.userId;
            const groupList = await getGroupList(epId);
            if (groupList && Array.isArray(groupList)) {
                const group_id = groupList.find(item => item.group_name === groupName)?.group_id;
                if (group_id) return { isPrivate: false, id: `QQ-Group:${group_id}`, name: groupName };
            }
        }

        if (groupName.length > 4) {
            const distance = levenshteinDistance(groupName, ctx.group.groupName);
            if (distance <= 2) return { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
        }

        logger.warning(`未找到群聊<${groupName}>`);
        return null;
    }

    async findImage(ctx: seal.MsgContext, id: string): Promise<Image | null> {
        // 从用户头像中查找图片
        if (/^user_avatar[:：]/.test(id)) {
            const ui = await this.findUserInfo(ctx, id.replace(/^user_avatar[:：]/, ''));
            if (ui) return ImageManager.getUserAvatar(ui.id);
        }
        // 从群聊头像中查找图片
        if (/^group_avatar[:：]/.test(id)) {
            const gi = await this.findGroupInfo(ctx, id.replace(/^group_avatar[:：]/, ''));
            if (gi) return ImageManager.getGroupAvatar(gi.id);
        }

        // 从上下文中查找图片
        const messages = this.messages;
        const userSet = new Set<string>();
        for (let i = messages.length - 1; i >= 0; i--) {
            const image = messages[i].images.find(item => item.id === id);
            if (image) return image;

            const uid = messages[i].uid;
            if (userSet.has(uid) || messages[i].role !== 'user') continue;
            const name = messages[i].name;
            if (name.startsWith('_')) continue;

            const image2 = AIManager.getAI(uid).memory.findImage(id);
            if (image2) return image2;
        }

        if (!ctx.isPrivate) {
            const image = AIManager.getAI(ctx.group.groupId).memory.findImage(id);
            if (image) return image;
        }

        // 从自己记忆中查找图片
        const image = AIManager.getAI(ctx.endPoint.userId).memory.findImage(id);
        if (image) return image;

        // 从本地图片库中查找图片
        const { localImagePathMap } = ConfigManager.image;
        if (localImagePathMap.hasOwnProperty(id)) {
            const image = new Image();
            image.file = localImagePathMap[id];
            return image;
        }

        logger.warning(`未找到图片<${id}>`);
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
                if (!gid) break;
                const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), uid.replace(/^.+:/, ''));
                if (!memberInfo) {
                    logger.warning(`获取用户<${uid}>的群成员信息失败，尝试使用昵称`);
                    this.setName(epId, gid, uid, 'nickname');
                    break;
                }
                name = memberInfo.card || memberInfo.nickname;
                if (!name) {
                    this.setName(epId, gid, uid, 'nickname');
                    return;
                }
                break;
            }
        }
        if (!name) {
            logger.warning(`用户<${uid}>未设置昵称或群名片`);
            return;
        }
        const { ctx } = getCtxAndMsg(epId, uid, gid);
        ctx.player.name = name;
        this.messages.forEach(message => message.name = message.uid === uid ? name : message.name);
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
}
