// 会话上下文：消息增删/忽略名单/压缩与总结触发/按 ID 获取目标/图片查找
import Agent from "../agent/agent";
import Config from "../config/config";
import Logger from "../logger";
import { MemoryManager } from "../memory/manager";
import Image from "../resource/image";
import Group from "../session/group";
import { Session } from "../session/session";
import User from "../session/user";
import { ToolCall, ToolContentPart } from "../tool/types";
import { callOb11Api } from "../utils/ob11";
import { stripInternalTags } from "../utils/string";
import { normalizeGroupId, normalizeUserId } from "../utils/target_id";
import { TypeDescriptor, withTimeout } from "../utils/utils";

import Message from "./message";
import { AssistantMessage, AssistantMessageItem, MessageType, SystemUserMessageItem, ToolCallbackMessage, ToolCallsMessage, UserMessage, UserMessageItem } from "./types";

const log = Logger.withTag('context');

// 群内用户会话的记忆权重（accessCount/lastAccessedAt）节流持久化：每会话 5 分钟内最多写一次，
// 避免每条消息都对所有历史发言者全量序列化。当前会话由对话收尾统一保存。
const lastUserMemorySaveAt: { [sessionId: string]: number } = {};
const USER_MEMORY_SAVE_INTERVAL_MS = 5 * 60 * 1000;

function flushGroupUserMemories(session: Session): void {
    if (session.sessionType !== 'group') return;
    const now = Date.now();
    const agent = session.agent;
    for (const uid of session.context.users) {
        const us = agent.sessionService.getSession(uid);
        const last = lastUserMemorySaveAt[uid] || 0;
        if (now - last > USER_MEMORY_SAVE_INTERVAL_MS) {
            us.save();
            // 保存成功后再记录时间，避免保存失败仍被节流跳过
            lastUserMemorySaveAt[uid] = now;
        }
    }
}

export class Context {
    static validKeysMap: { [key in keyof Context]?: TypeDescriptor<Context[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        messages: { array: 'any' },
        ignoreList: { array: 'string' },
        autoNameMod: 'number',
        summaryCounter: 'number',
        lastSummarizedIndex: 'number'
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
    /** 总结记忆增量游标：只总结该索引之后的消息（limitMessages 裁剪时同步回退） */
    lastSummarizedIndex: number;

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
        this.lastSummarizedIndex = 0;
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
            this.lastSummarizedIndex = 0;
            this.messages = [];
            return;
        }

        // 同步修正总结游标：删除游标前的消息会使游标前移；游标本身被删则回到 0 重新总结
        const removedBefore = this.messages
            .slice(0, this.lastSummarizedIndex)
            .filter(m => roles.includes(m.role as any)).length;
        const cursorRemoved = this.lastSummarizedIndex < this.messages.length
            && roles.includes(this.messages[this.lastSummarizedIndex].role as any);

        this.messages = this.messages.filter(m => !roles.includes(m.role as any));

        if (cursorRemoved) {
            this.lastSummarizedIndex = 0;
        } else {
            this.lastSummarizedIndex = Math.max(0, this.lastSummarizedIndex - removedBefore);
        }
    }

    reviveMessages() {
        this.messages = this.messages.map(m => {
            if (!m || typeof m.role !== 'string') return null;
            if (Array.isArray((m as any).contentItems)) {
                (m as any).contentItems = (m as any).contentItems.filter((i: any) => i && typeof i.text === 'string');
            }
            // 清理历史遗留的空 tool_calls（如旧版本异常写入的 []），避免空数组进入请求体
            if ((m as any).role === 'assistant') {
                const toolCalls = (m as any).toolCalls || (m as any).tool_calls;
                if (Array.isArray(toolCalls) && toolCalls.length === 0) {
                    delete (m as any).toolCalls;
                    delete (m as any).tool_calls;
                }
            }
            return m;
        }).filter(m => m !== null);
    }

    /** 文本超过压缩阈值时交给压缩智能体，返回压缩结果；未超阈值或失败时返回原文 */
    static async compressIfLong(text: string): Promise<string> {
        const { COMPRESS_THRESHOLD } = Config.message;
        if (text.length <= COMPRESS_THRESHOLD) return text;
        try {
            const compressed = await Agent.get('compress_agent').chat(text);
            return compressed || text;
        } catch (e) {
            log.warning('压缩消息失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
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
                log.warning('自动改名失败: ' + (e instanceof Error ? e.message : String(e)));
            }
        }
        text = await Context.compressIfLong(text);
        // 防注入：压缩智能体可能回带标签，入库前再兜底剥离一次（主入口在 transformArrayToContent）
        text = stripInternalTags(text);
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
            // 分隔符与 buildContent 渲染保持一致（真实 \f），避免压缩前后表示差异误判重复压缩
            const merged = userMsg.contentItems.map(item => item.text).join('\f');
            const compressed = await Context.compressIfLong(merged);
            if (compressed !== merged) {
                userMsg.contentItems = [{ text: compressed, time: umi.time, userId: umi.userId, messageId: umi.messageId }];
            }
        } else {
            this.messages.push({
                role: 'user',
                contentItems: [umi]
            });
        }
        // 群内用户会话的权重更新节流持久化（避免每条消息全量写盘）
        flushGroupUserMemories(this.session);
    }

    addAssistantMessage(text: string, messageId: string, reasoningContent?: string) {
        // 防泄露：兜底剥离内部上下文标签（正常回复在 handleReply 已剥离）
        text = stripInternalTags(text);
        const ami: AssistantMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            messageId,
            ...(reasoningContent !== undefined ? { reasoningContent } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'assistant' && Array.isArray((lastMessage as AssistantMessage).contentItems)) (lastMessage as AssistantMessage).contentItems.push(ami);
        else this.messages.push({
            role: 'assistant',
            contentItems: [ami]
        });
        flushGroupUserMemories(this.session);
        // 按配置的间隔轮数触发对话记忆抽取与巩固（Hindsight-like Retain + Consolidation）
        this.summaryCounter++;
        if (this.summaryCounter >= Config.memory.SUMMARY_INTERVAL) {
            this.summaryCounter = 0;
            MemoryManager.retainConversation(this.session).catch(e => {
                log.warning('记忆抽取/巩固失败: ' + (e instanceof Error ? e.message : String(e)));
            });
        }
        this.limitMessages();
    }

    addSystemUserMessage(text: string, systemName: string) {
        text = stripInternalTags(text);
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

    }

    addToolCallsMessage(toolCalls: ToolCall[], reasoningContent?: string) {
        // 防御：空数组不应入库，避免后续请求体携带 "tool_calls":[] 被后端拒绝
        if (!toolCalls || toolCalls.length === 0) {
            log.warning('addToolCallsMessage 收到空数组，已忽略');
            return;
        }
        const tcm: ToolCallsMessage = {
            role: 'assistant',
            toolCalls,
            ...(reasoningContent !== undefined ? { reasoningContent } : {})
        }
        this.messages.push(tcm);
    }

    // 工具回调消息：过长的结果同样交给压缩智能体压缩后再存入上下文
    // 独立于用户消息压缩阈值；web_search 压缩时附带搜索目标，帮助保留与问题相关的信息
    async addToolCallbackMessage(text: string, toolCallId: string, toolName?: string, searchTarget?: string, contentParts?: ToolContentPart[]) {
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
                log.warning('压缩工具回调失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
            }
        }
        // 防注入：工具返回内容（如历史消息、网页文本）中的内部上下文标签直接剥离，不进入上下文
        text = stripInternalTags(text);
        const tcbm: ToolCallbackMessage = {
            role: 'tool',
            text,
            toolCallId,
            contentParts,
            toolName
        }
        this.messages.push(tcbm);
    }

    limitMessages() {
        const { MAX_ROUNDS } = Config.message;
        if (MAX_ROUNDS <= 0) return;

        const messages = this.messages;
        let round = 0;

        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') round++;

            if (round > MAX_ROUNDS) {
                // 删除超限的这条 user 及其后紧跟的 assistant/tool，直到下一条 user 前
                let removeEnd = i + 1;
                while (removeEnd < messages.length && messages[removeEnd].role !== 'user') {
                    removeEnd++;
                }

                messages.splice(0, removeEnd);
                this.lastSummarizedIndex = Math.max(0, this.lastSummarizedIndex - removeEnd);
                return;
            }
        }
    }

    getUserById(userId: string | number): User | null {
        const normalizedId = normalizeUserId(userId);
        if (!normalizedId || this.session.checkIgnoredUserId(normalizedId)) return null;
        return User.get(normalizedId);
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
                const strangerInfo = await callOb11Api(epId, "get_stranger_info", { user_id: uid.replace(/^.+:/, ""), no_cache: true });
                if (!strangerInfo || !strangerInfo.nickname) {
                    log.warning(`未找到用户<${uid}>的昵称`);
                    break;
                }
                name = strangerInfo.nickname;
                break;
            }
            case 'card': {
                if (!gid) break;
                const memberInfo = await callOb11Api(epId, "get_group_member_info", { group_id: gid.replace(/^.+:/, ""), user_id: uid.replace(/^.+:/, ""), no_cache: true });
                if (!memberInfo) {
                    log.warning(`获取用户<${uid}>的群成员信息失败，尝试使用昵称`);
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
            log.warning(`用户<${uid}>未设置昵称或群名片`);
            return;
        }
        const u = User.get(uid);
        u.userName = name;
        User.save(u);
    }
    getGroupById(groupId: string | number): Group | null {
        const normalizedId = normalizeGroupId(groupId);
        if (!normalizedId) return null;
        return Group.get(normalizedId);
    }
    async findImage(_ctx: seal.MsgContext, id: string): Promise<Image | null> {
        if (/^user_avatar[:：?]/.test(id)) {
            const userId = normalizeUserId(id.replace(/^user_avatar[:：?]/, ''));
            if (userId) return Image.getUserAvatar(userId);
            return null;
        }
        if (/^group_avatar[:：?]/.test(id)) {
            const groupId = normalizeGroupId(id.replace(/^group_avatar[:：?]/, ''));
            if (groupId) return Image.getGroupAvatar(groupId);
            return null;
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
                try {
                    await withTimeout(() => this.setName(epId, gid, uid, 'nickname'), 5000);
                } catch (e) {
                    log.warning(`自动改名（昵称）失败: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }
            case 2: {
                try {
                    await withTimeout(() => this.setName(epId, gid, uid, 'card'), 5000);
                } catch (e) {
                    log.warning(`自动改名（群名片）失败: ${e instanceof Error ? e.message : String(e)}`);
                }
                break;
            }
        }
    }

}


