// Prompt 构建入口（薄壳）：构造 PromptContext → assemblePrompt，产出 system/runtime 两路文本。
// 兼容旧 API：buildSystemPromptContent 仍返回 system 文本；buildSystemMessage 在 utils/message.ts。
import Config from "../config/config";
import Message from "../context/message";
import type { UserMessage, UserMessageItem } from "../context/types";
import { auxRegistry } from "../core/ports/aux_tools";
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

/** 图片段 flag 派生输入（纯函数入参，供单测直接断言；方案 v1.4 §10.5） */
export interface ImagePromptFlagInput {
    /** 消息接收页「接收图片」 */
    receiveImage: boolean;
    /** 图片页「图床提示注入」开关（默认 true） */
    imageHostPrompt: boolean;
    /** 资源页「资源清单注入」开关（默认 false） */
    resourcePrompt: boolean;
    /** aux 注册表是否存在 image-host 片段（适配器注册条件已保证 = 图床/MCP 有图片能力） */
    hasImageHostSnippet: boolean;
    /** aux 注册表是否存在 resource 片段（资源开关开且确有内置图片/本地资源） */
    hasResourceSnippet: boolean;
}

/** 图片相关 flag 的唯一派生点：不再直接 import ImageHost/MCP 判断（等价性由适配器注册条件保证） */
export function deriveImagePromptFlags(input: ImagePromptFlagInput): {
    imageUsage: boolean;
    imageHost: boolean;
    resourceLibrary: boolean;
    imageLibrary: boolean;
} {
    const imageHost = !!input.imageHostPrompt && !!input.hasImageHostSnippet;
    const resourceLibrary = !!input.resourcePrompt && !!input.hasResourceSnippet;
    // 有意修正（方案 §10.5 行为差异 #2）：只开了「接收图片」也应该告诉模型怎么用图片
    const imageUsage = !!input.receiveImage || imageHost || resourceLibrary;
    return {
        imageUsage,
        imageHost,
        resourceLibrary,
        // 兼容旧字段（下一版删除）：语义已收窄为「真有图片能力的来源」，与旧 ImageHost||MCP 等价
        imageLibrary: imageHost,
    };
}

/** 配置读取兜底：配置尚未注册/读取异常时按出厂默认处理，避免提示词装配崩溃 */
function safeBoolean(read: () => boolean, fallback: boolean): boolean {
    try {
        return !!read();
    } catch {
        return fallback;
    }
}

function safeNumber(read: () => number, fallback: number): number {
    try {
        const value = Number(read());
        return Number.isFinite(value) && value > 0 ? value : fallback;
    } catch {
        return fallback;
    }
}

/** 读取配置开关快照 */
function readFlags(): PromptFlags {
    const { RECEIVE_IMAGE } = Config.received;
    const { STATUS, PROMPT_ENGINEERING, DIRECTION_PROMPT } = Config.tool;
    const { EXTRA_SEPARATOR } = Config.reply;
    const derived = deriveImagePromptFlags({
        receiveImage: !!RECEIVE_IMAGE,
        imageHostPrompt: safeBoolean(() => Config.image.IMAGE_HOST_PROMPT, true),
        resourcePrompt: safeBoolean(() => Config.resource.RESOURCE_LIBRARY, false),
        hasImageHostSnippet: auxRegistry.hasSnippet('image-host'),
        hasResourceSnippet: auxRegistry.hasSnippet('resource'),
    });
    return {
        status: !!STATUS,
        promptEngineering: !!PROMPT_ENGINEERING,
        directionPrompt: !!DIRECTION_PROMPT,
        receiveImage: !!RECEIVE_IMAGE,
        extraSeparator: extraSeparatorLabels(EXTRA_SEPARATOR),
        imageUsage: derived.imageUsage,
        resourceLibrary: derived.resourceLibrary,
        imageHost: derived.imageHost,
        resourceBudget: safeNumber(() => Config.resource.RESOURCE_LIBRARY_BUDGET, 600),
        imageHostBudget: safeNumber(() => Config.image.IMAGE_HOST_PROMPT_BUDGET, 600),
        imageLibrary: derived.imageLibrary,
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
        globalPrompt: String(Config.role.GLOBAL_PROMPT || '').trim(),
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
