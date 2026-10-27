// Prompt 构建入口（薄壳）：构造 PromptContext → assemblePrompt，产出 system/runtime 两路文本。
// 兼容旧 API：buildSystemPromptContent 仍返回 system 文本；buildSystemMessage 在 utils/message.ts。
import Config from "../config/config";
import Message from "../context/message";
import type { UserMessage, UserMessageItem } from "../context/types";
import { ImageHost } from "../resource/image_host";
import type { Session } from "../session/session";
import type { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { toolMap } from "../tool/registry";
import Tool from "../tool/tool";
import { extraSeparatorLabels } from "../utils/message_separator";
import { getRoleSetting } from "../utils/role";
import { stripInternalTags } from "../utils/string";
import { platformOf } from "../utils/target_id";

import { assemblePrompt } from "./assemble";
import { initKnowledgeBase } from "./sections/skills_knowledge";
import type { PromptContext, PromptFlags, PromptParts } from "./types";

/** 记忆检索输入：最近 2~3 条用户消息拼接（≤2000 字符）+ 发言者/群信息 */
function collectMemoryInput(ctx: seal.MsgContext, session: Session): {
    query: string;
    users: UserInfo[];
    group: GroupInfo | null;
} {
    const userMessages = session.context.messages.filter(message => message.role === 'user');
    let text = '';
    const users: UserInfo[] = [];
    let group: GroupInfo | null = null;
    for (const userMessage of userMessages.slice(-3)) {
        if (!Array.isArray((userMessage as UserMessage).contentItems)) continue;
        for (const item of (userMessage as UserMessage).contentItems) {
            if (Message.getUserMessageItemType(item) !== 'user') continue;
            const userItem = item as UserMessageItem;
            if (userItem.text) text += (text ? ' ' : '') + stripInternalTags(userItem.text);
            if (userItem.userId) {
                const user = User.get(userItem.userId);
                const info: UserInfo = { isPrivate: true, id: userItem.userId, name: user.userName || userItem.userId };
                if (!users.some(existing => existing.id === info.id)) users.push(info);
            }
        }
    }
    if (!ctx.isPrivate && ctx.group) {
        group = { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
    }
    if (text.length > 2000) text = text.slice(-2000);
    return { query: text, users, group };
}

/** 读取配置开关快照 */
function readFlags(): PromptFlags {
    const { RECEIVE_IMAGE } = Config.received;
    const { STATUS, PROMPT_ENGINEERING, DIRECTION_PROMPT } = Config.tool;
    const { EXTRA_SEPARATOR } = Config.reply;
    return {
        status: !!STATUS,
        promptEngineering: !!PROMPT_ENGINEERING,
        directionPrompt: !!DIRECTION_PROMPT,
        receiveImage: !!RECEIVE_IMAGE,
        extraSeparator: extraSeparatorLabels(EXTRA_SEPARATOR),
        imageLibrary: !!(ImageHost.enabled || Config.mcp.MCP_ENABLED),
        memory: !!((Config.memory as any).MEMORY_ENABLED ?? Config.memory.MEMORY),
        knowledge: !!Config.knowledgeBase.KNOWLEDGE,
    };
}

/** 构造一次组装的只读上下文 */
export async function createPromptContext(ctx: seal.MsgContext, session: Session, roleSettingOverride?: string): Promise<PromptContext> {
    const role = getRoleSetting(ctx);
    const roleSetting = roleSettingOverride !== undefined ? roleSettingOverride : role.roleSetting;
    const platform = platformOf(ctx);
    const flags = readFlags();
    if (flags.status && flags.knowledge) await initKnowledgeBase();

    const memory = collectMemoryInput(ctx, session);
    const tool = (name: string): boolean => {
        if (!session.toolState?.[name]) return false;
        const item = toolMap[name];
        if (!item) return false;
        if (!Tool.isAllowedPlatform(item, platform)) return false;
        if (item.sessionType !== 'any' && item.sessionType !== session.sessionType) return false;
        return true;
    };

    const sessionName = ctx.isPrivate ? ctx.player!.name : ctx.group!.groupName;
    const sessionId = ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId;
    return {
        ctx,
        session,
        roleSetting,
        roleIndex: role.roleIndex,
        platform,
        isPrivate: ctx.isPrivate,
        sessionName,
        sessionId,
        botId: ctx.endPoint.userId,
        flags,
        tool,
        memoryQuery: memory.query,
        memoryUsers: memory.users,
        memoryGroup: memory.group,
    };
}

/** 组装 system + runtime（每轮调用一次，工具循环内复用返回值） */
export async function buildPromptParts(ctx: seal.MsgContext, session: Session, roleSettingOverride?: string): Promise<PromptParts> {
    const promptContext = await createPromptContext(ctx, session, roleSettingOverride);
    return assemblePrompt(promptContext);
}

/**
 * 兼容旧 API：返回 system 文本。
 * @param roleSetting 显式角色设定（缺省按 $gSYSPROMPT 解析）
 */
export async function buildSystemPromptContent(
    ctx: seal.MsgContext,
    session: Session,
    _roleIndex?: number,
    roleSetting?: string,
): Promise<string> {
    const parts = await buildPromptParts(ctx, session, roleSetting);
    return parts.system;
}

/** 仅取 runtime 文本（handleMessages 未拿到 systemMessage 时的兜底） */
export async function buildRuntimePromptText(ctx: seal.MsgContext, session: Session): Promise<string> {
    const parts = await buildPromptParts(ctx, session);
    return parts.runtime;
}

/** 把组装结果转成 system 消息体（与 utils/message.ts 的 ContextMessage 结构兼容） */
export function promptPartsToSystemMessage(parts: PromptParts): { role: 'system'; contentItems: Array<{ text: string; time: number; systemName: string }> } {
    return {
        role: 'system',
        contentItems: [{
            text: parts.system,
            time: Math.floor(Date.now() / 1000),
            systemName: '',
        }],
    };
}
