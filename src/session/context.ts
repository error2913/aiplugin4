import { Config } from "../config/config";
import { Image, ImageService } from "../image";
import { getCtxAndMsg } from "../utils/seal";
import { levenshteinDistance } from "../utils/string";
import { logger } from "../logger";
import { netExists, getFriendList, getGroupList, getGroupMemberInfo, getGroupMemberList, getStrangerInfo } from "../utils/ob11";
import { TypeDescriptor } from "../utils/utils";
import { MessageItem } from "./types";

export class Context {
    static validKeysMap: { [key in keyof Context]?: TypeDescriptor<Context[key]> } = {
        messages: { array: 'any' }
    }
    messages: MessageItem[];

    constructor() {
        this.messages = [];
    }

    clearMessages(role?: 'user' | 'assistant') {
        switch (role) {
            case 'user': {
                this.messages = this.messages.filter(m => !m.hasOwnProperty('userId'));
                break;
            }
            case 'assistant': {
                this.messages = this.messages.filter(m => m.hasOwnProperty('userId'));
                break;
            }
            default: {
                this.messages = [];
                break;
            }
        }
    }

    // 添加后检查压缩条件，并对过长user进行压缩
    addUserMessage() {

    }

    addAssistantMessage() {

    }

    addSystemUserMessage() {

    }

    addToolCallsMessage() {

    }

    // 同理，进行压缩
    addToolCallbackMessage() {

    }

    async addMessage(ctx: seal.MsgContext, msg: seal.Message, ai: AI, content: string, images: Image[], role: 'user' | 'assistant', msgId: string = '') {
        const { isShortMemory, shortMemorySummaryRound } = Config.memory;
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
                messageId: msgId,
                time: now,
                text: content
            });
        } else {
            const message: Message = {
                role: role,
                uid: uid,
                name: name,
                images: images,
                msgArray: [{
                    messageId: msgId,
                    time: now,
                    text: content
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
                messageId: '',
                time: now,
                text: s
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
                messageId: '',
                time: now,
                text: s
            }]
        };
        this.messages.push(message);
    }

    limitMessages() {
        const { maxRounds } = Config.message;
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

    get users(): string[] {
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
}
