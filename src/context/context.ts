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
import { estimateMessageTokens } from "../utils/message";
import { callOb11Api } from "../utils/ob11";
import { buildToolTruncateMarker, buildUserBlockMarker, buildUserSingleMarker, stripRawMarkers } from "../utils/raw_marker";
import { stripInternalTags } from "../utils/string";
import { getPlatform, normalizeGroupId, normalizeUserId } from "../utils/target_id";
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

/** 归档分块 token 预算：避免单次总结上下文过大 */
export const ARCHIVE_CHUNK_TOKENS = 50000;

/** 真实用户轮：role=user 且包含真实用户消息项；system-only user 不算轮 */
export function isRealUserMessage(m: MessageType): boolean {
    if (m.role !== 'user') return false;
    if (!Array.isArray((m as UserMessage).contentItems)) return false;
    return (m as UserMessage).contentItems.some(
        item => typeof (item as UserMessageItem).userId === 'string'
    );
}

/** 将消息列表切成“真实 user 轮”段；assistant/tool 不新开轮，system-only 不新开轮 */
export function buildRoundSegments(messages: MessageType[]): Array<{ start: number; end: number }> {
    const segments: Array<{ start: number; end: number }> = [];
    let currentStart: number | null = null;
    let inUserTurn = false;

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];

        if (m.role === 'assistant' || m.role === 'tool') {
            inUserTurn = false;
            continue;
        }

        const realUser = isRealUserMessage(m);

        if (realUser && !inUserTurn) {
            if (currentStart !== null) segments.push({ start: currentStart, end: i });
            currentStart = i;
            inUserTurn = true;
        }
    }

    if (currentStart !== null) segments.push({ start: currentStart, end: messages.length });
    return segments;
}

/** 返回“保留最近 keepRounds 个真实 user 轮”的起始消息下标；不足时返回 0 */
export function getKeepStart(messages: MessageType[], keepRounds: number): number {
    if (keepRounds <= 0) return messages.length;
    const segments = buildRoundSegments(messages);
    if (segments.length <= keepRounds) return 0;
    return segments[segments.length - keepRounds].start;
}

/** 估算 Context 内持久化消息 token 数 */
export function estimateContextMessagesTokens(messages: MessageType[]): number {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m as any), 0);
}

/** 将待归档消息按 token 预算切成连续块，保证每条消息都进入且只进入一个块 */
export function splitMessagesByToken(messages: MessageType[], maxTokens: number): MessageType[][] {
    const chunks: MessageType[][] = [];
    let current: MessageType[] = [];
    let currentTokens = 0;

    for (const m of messages) {
        const t = estimateMessageTokens(m as any);
        if (current.length > 0 && currentTokens + t > maxTokens) {
            chunks.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(m);
        currentTokens += t;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** 丢弃最早的一个真实 user 轮（含其 assistant/tool 消息）；无轮时丢弃最早一条消息 */
export function dropOldestRound(messages: MessageType[]): boolean {
    const segments = buildRoundSegments(messages);
    if (segments.length === 0) {
        if (messages.length === 0) return false;
        messages.splice(0, 1);
        return true;
    }
    const oldest = segments[0];
    messages.splice(oldest.start, oldest.end - oldest.start);
    return true;
}

/** 上下文条目定位引用：addSystemUserMessageTracked 的返回值，供事件去重"后到覆盖先到"就地替换 */
export interface SystemEntryRef {
    messageIndex: number;
    itemIndex: number;
}

export class Context {
    static validKeysMap: { [key in keyof Context]?: TypeDescriptor<Context[key]> } = {
        agentName: 'string',
        sessionId: 'string',
        messages: { array: 'any' },
        ignoreList: { array: 'string' },
        autoNameMod: 'number',
    }
    agentName: string;
    sessionId: string;
    messages: MessageType[];
    ignoreList: string[];
    lastReply: string;
    counter: number;
    timer: number | null;
    autoNameMod: number;

    constructor() {
        this.agentName = '';
        this.sessionId = '';
        this.messages = [];
        this.ignoreList = [];
        this.lastReply = '';
        this.counter = 0;
        this.timer = null;
        this.autoNameMod = 0;
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

    /** 文本超过压缩阈值时交给压缩智能体，返回 {display, original, changed}；未超阈值或压缩失败时 changed=false、display=原文 */
    static async compressPreserveIfLong(text: string): Promise<{ display: string; original: string; changed: boolean }> {
        const { COMPRESS_THRESHOLD } = Config.context;
        if (text.length <= COMPRESS_THRESHOLD) return { display: text, original: text, changed: false };
        try {
            const compressed = await Agent.get('compress_agent').chat(text);
            if (compressed && compressed !== text) {
                return { display: compressed, original: text, changed: true };
            }
        } catch (e) {
            log.warning('压缩消息失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
        }
        return { display: text, original: text, changed: false };
    }

    // 用户消息入库：单条超长或连续多条合并后超阈值时，交给压缩智能体压缩后存入上下文
    // 压缩前原文保留在条目 rawText/rawItems（不参与渲染与 token 估算），展示文本末尾带标记，
    // AI 可用 read_raw/grep_raw(kind=user) 按 msg_id（单条）/ blk:<末条messageId>（合并块）核对原文
    async addUserMessage(ctx: seal.MsgContext, text: string, userId: string, messageId: string) {
        // 自动改名：按 autoNameMod 设置，在用户首次出现时更新上下文中的名字
        if (this.autoNameMod > 0) {
            try {
                await this.updateName(ctx.endPoint.userId, ctx.group ? ctx.group.groupId : '', userId);
            } catch (e) {
                log.warning('自动改名失败: ' + (e instanceof Error ? e.message : String(e)));
            }
        }
        // 单条压缩：替换发生时保留压缩前原文 rawText
        const single = await Context.compressPreserveIfLong(text);
        let itemText = stripInternalTags(single.display);
        const rawText = single.changed ? stripInternalTags(single.original) : undefined;
        if (rawText !== undefined) {
            // 防注入：压缩智能体可能回带标签，入库前再兜底剥离一次（主入口在 transformArrayToContent）
            itemText = stripInternalTags(itemText);
            itemText += buildUserSingleMarker(single.original.length, itemText.length, messageId);
        }
        const umi: UserMessageItem = {
            text: itemText,
            time: Math.floor(Date.now() / 1000),
            userId,
            messageId,
            ...(rawText !== undefined ? { rawText } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) {
            const userMsg = lastMessage as UserMessage;
            userMsg.contentItems.push(umi);
            // 连续多条 user 消息合并后总长超阈值 → 合并压缩，替换为该条压缩结果
            // 块内原文逐条保留（各条若已单条压缩，取 rawText 原文而非摘要，避免二次压缩失真）；
            // 分隔符与 buildContent 渲染保持一致（真实 \f）
            const items = userMsg.contentItems as UserMessageItem[];
            const joined = items.map(it => stripRawMarkers(it.rawText ?? it.text)).join('\f');
            const block = await Context.compressPreserveIfLong(joined);
            if (block.changed && block.display !== joined) {
                const rawItems = items.map(it => ({
                    userId: it.userId,
                    messageId: it.messageId,
                    time: it.time,
                    text: stripRawMarkers(it.rawText ?? it.text)
                }));
                let display = stripInternalTags(block.display);
                display += buildUserBlockMarker(items.length, joined.length, umi.messageId);
                userMsg.contentItems = [{
                    text: display,
                    time: umi.time,
                    userId: umi.userId,
                    messageId: umi.messageId,
                    rawItems
                }];
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
        // 不再按轮数周期观察：上下文 token 超限后统一由 archiveByTokenIfNeeded 异步归档
        void this.archiveByTokenIfNeeded().catch(e => {
            log.warning('上下文归档失败: ' + (e instanceof Error ? e.message : String(e)));
        });
    }

    addSystemUserMessage(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }) {
        text = stripInternalTags(text);
        const sumi: SystemUserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            systemName,
            ...(extra?.eventType ? { eventType: extra.eventType } : {}),
            ...(extra?.raw !== undefined ? { raw: extra.raw } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) (lastMessage as UserMessage).contentItems.push(sumi);
        else this.messages.push({
            role: 'user',
            contentItems: [sumi]
        });

    }

    /** 追加系统用户消息并返回条目定位引用（供事件去重窗口内"后到覆盖先到"的就地替换使用）。与 addSystemUserMessage 同构。 */
    addSystemUserMessageTracked(text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): SystemEntryRef | null {
        text = stripInternalTags(text);
        const sumi: SystemUserMessageItem = {
            text,
            time: Math.floor(Date.now() / 1000),
            systemName,
            ...(extra?.eventType ? { eventType: extra.eventType } : {}),
            ...(extra?.raw !== undefined ? { raw: extra.raw } : {})
        };
        const lastMessage = this.messages[this.messages.length - 1];
        let messageIndex: number;
        if (lastMessage && Message.getMessageType(lastMessage) === 'user' && Array.isArray((lastMessage as UserMessage).contentItems)) {
            messageIndex = this.messages.length - 1;
            (lastMessage as UserMessage).contentItems.push(sumi);
        } else {
            messageIndex = this.messages.length;
            this.messages.push({ role: 'user', contentItems: [sumi] });
        }
        const container = (this.messages[messageIndex] as UserMessage).contentItems;
        return { messageIndex, itemIndex: container.length - 1 };
    }

    /**
     * 按引用就地替换系统用户消息条目：事件去重命中时把已入库的旧副本更新为"最后到达的事件"，
     * 保证同一去重窗口内上下文只保留一条、内容取最新。条目已被合并压缩/归档等改写导致引用
     * 失效时返回 false，由调用方自行兜底（如追加新副本）。
     */
    replaceSystemUserMessage(ref: SystemEntryRef, text: string, systemName: string, extra?: { eventType?: string; raw?: unknown }): boolean {
        const m = this.messages[ref.messageIndex];
        if (!m || m.role !== 'user' || !Array.isArray(m.contentItems)) return false;
        const item = m.contentItems[ref.itemIndex];
        // 仅当原位置仍是"系统用户消息"（未被压缩成块/清理/归档改写）时才可安全替换
        if (!item || typeof item.text !== 'string' || !(item as SystemUserMessageItem).systemName) return false;
        const systemItem = item as SystemUserMessageItem;
        systemItem.text = stripInternalTags(text);
        systemItem.systemName = systemName;
        if (extra?.eventType) systemItem.eventType = extra.eventType;
        else delete systemItem.eventType;
        if (extra?.raw !== undefined) systemItem.raw = extra.raw;
        else delete systemItem.raw;
        return true;
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

    // 工具回调消息：过长的结果不再交给压缩智能体，改为只展示开头 N 字（head 截断），
    // 完整原文以 rawText 保留（不参与渲染/预算），供 read_raw/grep_raw(kind=tool) 按 tool_call_id 按需读取。
    async addToolCallbackMessage(text: string, toolCallId: string, toolName?: string, contentParts?: ToolContentPart[]) {
        const { TOOL_RESPONSE_TRUNCATE_CHARS } = Config.tool;
        // 截断前原文：仅当文本确实被截断后保留，供只读工具按需读取（不参与渲染/预算）
        let rawText: string | undefined;
        if (TOOL_RESPONSE_TRUNCATE_CHARS > 0 && text.length > TOOL_RESPONSE_TRUNCATE_CHARS) {
            rawText = text;
            text = text.slice(0, TOOL_RESPONSE_TRUNCATE_CHARS);
        }
        // 防注入：工具返回内容（如历史消息、网页文本）中的内部上下文标签直接剥离，不进入上下文
        text = stripInternalTags(text);
        if (rawText !== undefined) {
            // 原文与展示文本走同一防注入处理；附加指针提示让模型知道内容被截断、可以按需翻原文
            rawText = stripInternalTags(rawText);
            text += buildToolTruncateMarker(rawText.length, text.length, toolCallId);
        }
        const tcbm: ToolCallbackMessage = {
            role: 'tool',
            text,
            ...(rawText !== undefined ? { rawText } : {}),
            toolCallId,
            contentParts,
            toolName
        }
        this.messages.push(tcbm);
    }

    /**
     * 基于 token 上限执行归档（观察归档 + 逐块删除）：
     * - targetTokens 缺省时用「上下文最大token」配置；
     * - 超过上限时保留最近 MAX_ROUNDS 个真实 user 轮；
     * - 更早消息分块归档，成功一块删一块；
     * - 单块重试耗尽后降级丢弃最早轮次（forceFit 到 target），直到不超上限。
     * @returns 是否已收敛到上限以内（false 表示归档失败、仅做了降级硬删）
     */
    async archiveByTokenIfNeeded(targetTokens?: number): Promise<boolean> {
        if (this.archiving) return false;
        this.archiving = true;

        try {
            const { MAX_ROUNDS, MAX_CONTEXT_TOKENS } = Config.context;
            // target <= 0 视为不限制；未传 target 时回退配置上限（配置层已保证其 > 0）
            const target = targetTokens && targetTokens > 0 ? targetTokens : (MAX_CONTEXT_TOKENS > 0 ? MAX_CONTEXT_TOKENS : Infinity);
            const keepRounds = MAX_ROUNDS > 0 ? MAX_ROUNDS : 5;

            while (estimateContextMessagesTokens(this.messages) > target) {
                const keepStart = getKeepStart(this.messages, keepRounds);
                const toArchive = this.messages.slice(0, keepStart);

                if (toArchive.length > 0) {
                    const ok = await this.archivePrefix(toArchive);
                    if (ok) continue;

                    await this.forceFitContext(target);
                    return false;
                }

                await this.forceFitContext(target);
                return false;
            }

            return true;
        } finally {
            this.archiving = false;
        }
    }

    private async archivePrefix(toArchive: MessageType[]): Promise<boolean> {
        const chunks = splitMessagesByToken(toArchive, ARCHIVE_CHUNK_TOKENS);

        for (const chunk of chunks) {
            const ok = await MemoryManager.summarizeChunkWithRetry(this.session, chunk);
            if (!ok) return false;
            // chunk 始终是当前消息数组最前的一段（前面的块成功后已删除）
            this.messages.splice(0, chunk.length);
            try { this.session.save(); } catch { /* 无宿主会话时跳过保存（测试/游离 Context） */ }
        }

        return true;
    }

    private async forceFitContext(targetTokens: number): Promise<void> {
        let safety = 0;

        while (estimateContextMessagesTokens(this.messages) > targetTokens && this.messages.length > 0 && safety < 10000) {
            const dropped = dropOldestRound(this.messages);
            if (!dropped) break;
            safety++;
            log.warning(`上下文归档失败降级：已丢弃最早 1 轮，剩余 token=${estimateContextMessagesTokens(this.messages)}`);
        }

        if (this.messages.length > 0 && estimateContextMessagesTokens(this.messages) > targetTokens) {
            // 极端单条超限：截断最旧消息文本到预算内（仅兜底，尽量保留尾部）
            const m = this.messages[0] as any;
            const tokens = estimateMessageTokens(m);
            const text = (m.text ?? (m.contentItems?.[0]?.text ?? '')) as string;
            const maxTextLen = Math.max(1, Math.floor(text.length * targetTokens / Math.max(1, tokens)));
            if (text.length > maxTextLen) {
                const cut = text.slice(-maxTextLen);
                if (m.contentItems) m.contentItems = [{ text: cut, time: m.contentItems[0]?.time ?? Math.floor(Date.now() / 1000) }];
                else m.text = cut;
            }
        }
    }

    /** 运行时归档锁，不持久化 */
    private archiving = false;

    getUserById(userId: string | number): User | null {
        const normalizedId = normalizeUserId(userId, getPlatform(this.sessionId));
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
        const normalizedId = normalizeGroupId(groupId, getPlatform(this.sessionId));
        if (!normalizedId) return null;
        return Group.get(normalizedId);
    }
    async findImage(_ctx: seal.MsgContext, id: string): Promise<Image | null> {
        if (/^user_avatar[:：?]/.test(id)) {
            const userId = normalizeUserId(id.replace(/^user_avatar[:：?]/, ''), getPlatform(this.sessionId));
            if (userId) return Image.getUserAvatar(userId);
            return null;
        }
        if (/^group_avatar[:：?]/.test(id)) {
            const groupId = normalizeGroupId(id.replace(/^group_avatar[:：?]/, ''), getPlatform(this.sessionId));
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
