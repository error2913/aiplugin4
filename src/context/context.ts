// 会话上下文：消息增删/忽略名单/压缩与总结触发/用户群查找/图片查找
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import MemoryService from "../memory/memory";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import User from "../session/user";
import { ToolCall } from "../tool/types";
import { getFriendList, getGroupList, getGroupMemberInfo, getGroupMemberList, getStrangerInfo, netExists } from "../utils/ob11";
import { levenshteinDistance } from "../utils/string";
import { TypeDescriptor } from "../utils/utils";

import Message from "./message";
import { AssistantMessage, AssistantMessageItem, MessageType, SystemUserMessageItem, ToolCallbackMessage, ToolCallsMessage, UserMessage, UserMessageItem } from "./types";


export class Context {
    static validKeysMap: { [key in keyof Context]?: TypeDescriptor<Context[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        messages: { array: 'any' },
        ignoreList: { array: 'string' },
        autoNameMod: 'number',
        summaryCounter: 'number'
    }
    agentName: string;
    sessionId: string;
    messages: MessageType[];
    ignoreList: string[];
    lastReply: string;
    counter: number;
    timer: number | null;
    autoNameMod: number;
    summaryCounter: number;

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.messages = [];
        this.ignoreList = [];
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
        this.autoNameMod = 0;
        this.summaryCounter = 0;
    }

    get agent(): Agent { return Agent.get(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }
    get users(): string[] {
        const userSet = new Set<string>();
        for (const m of this.messages) {
            if (Message.getMessageType(m) !== 'user') continue;
            for (const umi of (m as UserMessage).contentItems) {
                if (Message.getUserMessageItemType(umi) !== 'user') continue;
                userSet.add((umi as UserMessageItem).userId);
            }

        }
        return Array.from(userSet);
    }

    clearMessages(...roles: Array<'user' | 'assistant' | 'tool'>) {
        if (roles.length === 0) {
            this.summaryCounter = 0;
            this.messages = [];
            return;
        }
        this.messages = this.messages.filter(m => !roles.includes(m.role as any));
    }

    reviveMessages() {
        this.messages = this.messages.map(m => {
            if (!m || typeof m.role !== 'string') return null;
            if (Array.isArray((m as any).contentItems)) {
                (m as any).contentItems = (m as any).contentItems.filter((i: any) => i && typeof i.text === 'string');
            }
            return m;
        }).filter(m => m !== null);
    }

    /** 文本超过压缩阈值时交给压缩智能体，返回压缩结果；未超阈值或失败时返回原文 */
    private async compressIfLong(text: string): Promise<string> {
        const { COMPRESS_THRESHOLD } = Config.message;
        if (text.length <= COMPRESS_THRESHOLD) return text;
        try {
            const compressed = await Agent.get('compress_agent').chat(text);
            return compressed || text;
        } catch (e) {
            Logger.warning('压缩消息失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
            return text;
        }
    }

    // 用户消息入库：单条超长或连续多条合并后超阈值时，交给压缩智能体压缩后存入上下文
    async addUserMessage(ctx: seal.MsgContext, text: string, userId: string, messageId: string) {
        // 自动改名：按 autoNameMod 设置，在用户首次出现时更新上下文中的名字
        if (this.autoNameMod > 0) {
            try {
                await this.updateName(ctx.endPoint.userId, ctx.group ? ctx.group.groupId : '', userId);
            } catch (e) {
                Logger.warning('自动改名失败: ' + (e instanceof Error ? e.message : String(e)));
            }
        }
        text = await this.compressIfLong(text);
        const umi: UserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            userId,
            messageId
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) {
            const userMsg = lastMessage as UserMessage;
            userMsg.contentItems.push(umi);
            // 连续多条 user 消息合并后总长超阈值 → 合并压缩，替换为该条压缩结果
            const merged = userMsg.contentItems.map(item => item.text).join('\\f');
            const compressed = await this.compressIfLong(merged);
            if (compressed !== merged) {
                userMsg.contentItems = [{ text: compressed, time: umi.time, userId: umi.userId, messageId: umi.messageId }];
            }
        } else {
            this.messages.push({
                role: 'user',
                contentItems: [umi]
            });
        }
        // 关联记忆权重更新：bot 记忆 + 知识库 + 会话记忆 + 群内用户记忆
        try {
            await MemoryService.accessRelatedMemories(this.session, text);
        } catch (e) {
            Logger.warning('记忆更新失败: ' + (e instanceof Error ? e.message : String(e)));
        }
    }

    addAssistantMessage(text: string, messageId: string) {
        const ami: AssistantMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            messageId
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'assistant' && Array.isArray((lastMessage as AssistantMessage).contentItems)) (lastMessage as AssistantMessage).contentItems.push(ami);
        else this.messages.push({
            role: 'assistant',
            contentItems: [ami]
        });
        MemoryService.accessRelatedMemories(this.session, text);
        // 按配置的间隔轮数触发短期记忆总结
        this.summaryCounter++;
        if (this.summaryCounter >= Config.memory.SUMMARY_INTERVAL) {
            this.summaryCounter = 0;
            this.session.memory.summarize();
        }
        this.limitMessages();
    }

    addSystemUserMessage(text: string, systemName: string) {
        const sumi: SystemUserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            systemName
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) (lastMessage as UserMessage).contentItems.push(sumi);
        else this.messages.push({
            role: 'user',
            contentItems: [sumi]
        });
        this.session.memory.accessMemories(text);
    }

    addToolCallsMessage(toolCalls: ToolCall[]) {
        const tcm: ToolCallsMessage = {
            role: 'assistant',
            toolCalls
        }
        this.messages.push(tcm);
    }

    // 工具回调消息：过长的结果同样交给压缩智能体压缩后再存入上下文
    // 独立于用户消息压缩阈值；web_search 压缩时附带搜索目标，帮助保留与问题相关的信息
    async addToolCallbackMessage(text: string, toolCallId: string, toolName?: string, searchTarget?: string) {
        const { TOOL_RESPONSE_COMPRESS_MIN_LENGTH } = Config.tool;
        if (TOOL_RESPONSE_COMPRESS_MIN_LENGTH > 0 && text.length > TOOL_RESPONSE_COMPRESS_MIN_LENGTH) {
            try {
                let prompt = text;
                if (toolName === 'web_search' && searchTarget) {
                    prompt = `搜索目标:${searchTarget}\n\n工具返回结果:\n${text}`;
                }
                const compressed = await Agent.get('compress_agent').chat(prompt);
                if (compressed) text = compressed;
            } catch (e) {
                Logger.warning('压缩工具回调失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
            }
        }
        const tcbm: ToolCallbackMessage = {
            role: 'tool',
            text,
            toolCallId
        }
        this.messages.push(tcbm);
    }

    limitMessages() {
        const { MAX_ROUNDS } = Config.message;
        const messages = this.messages;
        let round = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') round++;
            if (round > MAX_ROUNDS) {
                messages.splice(0, i);
                break;
            }
        }
    }

    async findUserId(ctx: seal.MsgContext, name: string | number, findInFriendList: boolean = false): Promise<string> {
        const session = this.session;
        const returnUserId = (userId: string) => session.checkIgnoredUserId(userId) ? '' : userId;

        name = String(name);
        if (!name) return '';

        if (name.length > 4 && !isNaN(parseInt(name))) return returnUserId(`QQ:${name}`);

        const match = name.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
        if (match) name = match[1] || match[2];

        if (name === ctx.player!.name) return returnUserId(ctx.player!.userId);
        if (name === seal.formatTmpl(ctx, "核心:骰子名字")) return returnUserId(ctx.endPoint.userId);

        // 在上下文和记忆中查找用户
        const users = Array.from(new Set([...this.users, ...MemoryService.getItemsFromRelatedMemories(this.session, 'users')]));
        for (const userId of users) {
            const u = User.get(userId);
            if (name === u.userName) return returnUserId(u.userId);
            if (name.length > 4 && levenshteinDistance(name, u.userName) <= 2) return returnUserId(u.userId);
        }

        // 在群成员列表、好友列表中查找用户
        if (netExists()) {
            const epId = ctx.endPoint.userId;

            if (!ctx.isPrivate) {
                const gid = ctx.group!.groupId;
                const groupMemberList = await getGroupMemberList(epId, gid.replace(/^.+:/, ''));
                if (groupMemberList && Array.isArray(groupMemberList)) {
                    const user_id = groupMemberList.find(item => item.card === name || item.nickname === name)?.user_id;
                    if (user_id) return returnUserId(`QQ:${user_id}`);
                }
            }

            if (findInFriendList) {
                const friendList = await getFriendList(epId);
                if (friendList && Array.isArray(friendList)) {
                    const user_id = friendList.find(item => item.nickname === name || item.remark === name)?.user_id;
                    if (user_id) return returnUserId(`QQ:${user_id}`);
                }
            }
        }

        if (name.length > 4 && levenshteinDistance(name, ctx.player!.name) <= 2) return returnUserId(ctx.player!.userId);

        Logger.warning(`未找到用户<${name}>`);
        return '';
    }
    get userInfoList(): { isPrivate: true, id: string, name: string }[] {
        const userMap: { [key: string]: { isPrivate: true, id: string, name: string } } = {};
        for (const m of this.messages) {
            if (m.role !== 'user' || !(m as any).contentItems) continue;
            for (const item of (m as any).contentItems) {
                if (!item.userId) continue;
                if (!userMap[item.userId]) {
                    const u = User.get(item.userId);
                    userMap[item.userId] = {
                        isPrivate: true,
                        id: item.userId,
                        name: u.userName || item.userId
                    };
                }
            }
        }
        return Object.values(userMap);
    }

    async setName(epId: string, gid: string, uid: string, mod: 'nickname' | 'card') {
        let name = '';
        switch (mod) {
            case 'nickname': {
                const strangerInfo = await getStrangerInfo(epId, uid.replace(/^.+:/, ''));
                if (!strangerInfo || !strangerInfo.nickname) {
                    Logger.warning(`未找到用户<${uid}>的昵称`);
                    break;
                }
                name = strangerInfo.nickname;
                break;
            }
            case 'card': {
                if (!gid) break;
                const memberInfo = await getGroupMemberInfo(epId, gid.replace(/^.+:/, ''), uid.replace(/^.+:/, ''));
                if (!memberInfo) {
                    Logger.warning(`获取用户<${uid}>的群成员信息失败，尝试使用昵称`);
                    await this.setName(epId, gid, uid, 'nickname');
                    return;
                }
                name = memberInfo.card || memberInfo.nickname;
                if (!name) {
                    await this.setName(epId, gid, uid, 'nickname');
                    return;
                }
                break;
            }
        }
        if (!name) {
            Logger.warning(`用户<${uid}>未设置昵称或群名片`);
            return;
        }
        const u = User.get(uid);
        u.userName = name;
        User.save(u);
    }
    async findGroupId(ctx: seal.MsgContext, groupName: string | number): Promise<string> {
        groupName = String(groupName);
        if (!groupName) return '';

        if (groupName.length > 5 && !isNaN(parseInt(groupName))) return `QQ-Group:${groupName}`;

        const match = groupName.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
        if (match) groupName = match[1] || match[2];

        if (!ctx.isPrivate && ctx.group && groupName === ctx.group.groupName) return ctx.group.groupId;

        // 在记忆中查找群聊
        for (const groupId of MemoryService.getItemsFromRelatedMemories(this.session, 'groups')) {
            const g = Group.get(groupId);
            if (g.groupName === groupName) return groupId;
            if (g.groupName.length > 4 && levenshteinDistance(groupName, g.groupName) <= 2) return groupId;
        }

        // 在群聊列表中查找用户
        if (netExists()) {
            const epId = ctx.endPoint.userId;
            const groupList = await getGroupList(epId);
            if (groupList && Array.isArray(groupList)) {
                const group_id = groupList.find(item => item.group_name === groupName)?.group_id;
                if (group_id) return `QQ-Group:${group_id}`;
            }
        }

        if (!ctx.isPrivate && ctx.group && groupName.length > 4 && levenshteinDistance(groupName, ctx.group.groupName) <= 2) return ctx.group.groupId;

        Logger.warning(`未找到群聊<${groupName}>`);
        return '';
    }
    async findUser(ctx: seal.MsgContext, name: string | number, findInFriendList: boolean = false): Promise<User | null> {
        const userId = await this.findUserId(ctx, name, findInFriendList);
        if (!userId) return null;
        return User.get(userId);
    }
    async findImage(ctx: seal.MsgContext, id: string): Promise<Image | null> {
        if (/^user_avatar[:?]/.test(id)) {
            const ui = await this.findUser(ctx, id.replace(/^user_avatar[:?]/, ''));
            if (ui) return Image.getUserAvatar(ui.userId);
        }
        if (/^group_avatar[:?]/.test(id)) {
            const gi = await this.findGroup(ctx, id.replace(/^group_avatar[:?]/, ''));
            if (gi) return Image.getGroupAvatar(gi.groupId);
        }
        const img = Image.get(id);
        if (img) return img;
        const { LOCAL_IMAGE_PATH_MAP } = Config.image as any;
        if (LOCAL_IMAGE_PATH_MAP && Object.prototype.hasOwnProperty.call(LOCAL_IMAGE_PATH_MAP, id)) {
            return Image.createLocalImage(id, LOCAL_IMAGE_PATH_MAP[id]);
        }
        return this.session.memory.findImage(id);
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

    async findGroup(ctx: seal.MsgContext, groupName: string | number): Promise<Group | null> {
        const groupId = await this.findGroupId(ctx, groupName);
        if (!groupId) return null;
        return Group.get(groupId);
    }
}
