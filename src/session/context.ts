import Config from "../config/config";
import { getCtxAndMsg } from "../utils/seal";
import { levenshteinDistance } from "../utils/string";
import Logger from "../logger";
import { netExists, getFriendList, getGroupList, getGroupMemberInfo, getGroupMemberList, getStrangerInfo } from "../utils/ob11";
import { TypeDescriptor } from "../utils/utils";
import { AssistantMessage, AssistantMessageItem, Message, SystemUserMessageItem, ToolCallbackMessage, ToolCallsMessage, UserMessage, UserMessageItem } from "./types";
import Agent from "../agent/agent";
import { Session } from "./session";
import { ToolCall } from "../tool/types";
import { get } from "lodash-es";

export class Context {
    static validKeysMap: { [key in keyof Context]?: TypeDescriptor<Context[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        messages: { array: 'any' }
    }
    agentName: string;
    sessionId: string;
    messages: Message[];

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.messages = [];
    }

    get agent(): Agent { return Agent.get(this.agentName); }
    get session(): Session { return this.agent.sessionService.getSession(this.sessionId); }

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

    // 添加后检查压缩条件，并对过长user进行压缩 wip
    addUserMessage(text: string, userId: string, messageId: string) {
        const umi: UserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            userId,
            messageId
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (getMessageType(lastMessage) === 'user') (lastMessage as UserMessage).contentItems.push(umi);
        else this.messages.push({
            role: 'user',
            contentItems: [umi]
        });
        this.session.memory.accessMemories(text);
    }

    addAssistantMessage(text: string, messageId: string) {
        const ami: AssistantMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            messageId
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (getMessageType(lastMessage) === 'assistant') (lastMessage as AssistantMessage).contentItems.push(ami);
        else this.messages.push({
            role: 'assistant',
            contentItems: [ami]
        });
        this.session.memory.accessMemories(text);
        this.session.memory.summarize();
        this.limitMessages();
    }

    addSystemUserMessage(text: string, systemName: string) {
        const sumi: SystemUserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            systemName
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (getMessageType(lastMessage) === 'user') (lastMessage as UserMessage).contentItems.push(sumi);
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

    // 同理，进行压缩 wip
    addToolCallbackMessage(text: string, toolCallId: string) {
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

        Logger.warning(`未找到用户<${name}>`);
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

        Logger.warning(`未找到群聊<${groupName}>`);
        return null;
    }

    get users(): string[] {
        const userSet = new Set<string>();
        this.messages.forEach(m => {
            if (m.role === 'user') m.contentItems.forEach(umi => {
                if (getUserMessageItemType(umi) === 'user') userSet.add((umi as UserMessageItem).userId);
            });
        });
        return Array.from(userSet);
    }
}

function getMessageType(m: Message): 'user' | 'assistant' | 'tool_calls' | 'tool_callback' {
    if (m.role === 'user') return 'user';
    else if (m.role === 'assistant') {
        if (m.hasOwnProperty('toolCalls')) return 'tool_calls';
        else return 'assistant';
    }
    else if (m.role === 'tool') return 'tool_callback';
    else throw new Error('Unknown message type');
}

function getUserMessageItemType(umi: UserMessageItem | SystemUserMessageItem): 'user' | 'system' {
    if (umi.hasOwnProperty('userId')) return 'user';
    else if (umi.hasOwnProperty('systemName')) return 'system';
    else throw new Error('Unknown message type');
}
