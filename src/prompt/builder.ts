// prompt 构建：system prompt 分节组装（角色/会话信息/能力/记忆/知识）
import Config, { ext } from "../config/config";
import Message from "../context/message";
import { UserMessage, UserMessageItem } from "../context/types";
import { knowledgeService } from "../memory/knowledge";
import { MemoryManager } from "../memory/manager";
import { getMemoryRevision, getSummaryRevision } from "../memory/revision";
import Model from "../model/model";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { getSkillSummaries } from "../tool/skills";
import Tool from "../tool/tool";
import { fmtDate, stripInternalTags } from "../utils/string";

import { getCachedString } from "./prompt_cache";
import { SYSTEM_MESSAGE_TEMPLATE } from "./templates";

export interface SystemPromptSection {
    name: string;
    content: string;
}

const STATIC_FRAME_TTL = 30_000;
const LONG_TERM_MEMORY_TTL = 10_000;
const SUMMARY_TTL = 60_000;
const KNOWLEDGE_TTL = 60_000;

function signature(parts: Array<string | number | boolean>): string {
    return parts.map(String).join('|');
}

function toolStateSignature(session: Session): string {
    return Object.keys(session.toolState)
        .sort()
        .map(key => `${key}:${session.toolState[key] ? '1' : '0'}`)
        .join(',');
}

/**
 * 组装 system prompt 内容。
 * 各动态段（长期记忆/总结记忆/知识库/工具与技能）按开关独立构建后，
 * 交由用户可编辑的 SYSTEM_MESSAGE_TEMPLATE 骨架渲染固定部分。
 */
export async function buildSystemPromptContent(
    ctx: seal.MsgContext,
    session: Session,
    _roleIndex: number,
    roleSetting: string
): Promise<string> {
    const { RECEIVE_IMAGE } = Config.received;
    const { STATUS, PROMPT_ENGINEERING } = Config.tool;

    // 取最近 2~3 条用户消息拼接，作为记忆/知识库查询的上下文（剥离内部标签）；
    // 同时收集全部发言者：群聊多人在线时，记忆检索不再只按最后一位发言者过滤
    const userMessages = session.context.messages.filter(m => m.role === 'user');
    let text = '';
    const uis: UserInfo[] = [];
    let gi: GroupInfo | null = null;
    for (const userMsg of userMessages.slice(-3)) {
        if (!Array.isArray((userMsg as UserMessage).contentItems)) continue;
        for (const item of (userMsg as UserMessage).contentItems) {
            if (Message.getUserMessageItemType(item) !== 'user') continue;
            const umi = item as UserMessageItem;
            if (umi.text) text += (text ? ' ' : '') + stripInternalTags(umi.text);
            if (umi.userId) {
                const u = User.get(umi.userId);
                const info: UserInfo = { isPrivate: true, id: umi.userId, name: u.userName || umi.userId };
                if (!uis.some(x => x.id === info.id)) uis.push(info);
            }
        }
    }
    if (!ctx.isPrivate && ctx.group) {
        gi = { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
    }
    // 限制记忆检索 query 长度：优先保留最近内容，避免超长合并消息/合并转发完整送入 embedding
    if (text.length > 2000) text = text.slice(-2000);

    // 静态壳：角色/平台/会话/本地资源/工具与技能，连续对话可复用 30 秒。
    // key 读取原始技能配置避免每次缓存命中都解析/打印错误；真正解析在缓存未命中时执行。
    const toolState = STATUS && PROMPT_ENGINEERING ? toolStateSignature(session) : '';
    const skillConfigSignature = STATUS ? seal.ext.getTemplateConfig(ext, "技能配置").join('\n') : '';
    const staticKey = signature([
        'prompt:static',
        roleSetting,
        ctx.endPoint.platform,
        ctx.isPrivate ? 'private' : 'group',
        ctx.isPrivate ? ctx.player!.name : ctx.group!.groupName,
        ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId,
        RECEIVE_IMAGE,
        STATUS,
        PROMPT_ENGINEERING,
        Config.tool.BLOCKED.join(','),
        Config.tool.DEFAULT_CLOSED.join(','),
        toolState,
        skillConfigSignature
    ]);
    const frame = await getCachedString(staticKey, STATIC_FRAME_TTL, () => {
        const skillSummaries = getSkillSummaries();
        const toolPrompt = STATUS && PROMPT_ENGINEERING ? Tool.getToolsInfoPrompt(session) : '';

        let content = SYSTEM_MESSAGE_TEMPLATE({
            instruction: roleSetting,
            platform: ctx.endPoint.platform,
            sessionType: ctx.isPrivate ? 'private' : 'group',
            sessionName: ctx.isPrivate ? ctx.player!.name : ctx.group!.groupName,
            sessionId: ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId,
            RECEIVE_IMAGE,
            toolPrompt
        });

        const skillBlock = STATUS && skillSummaries.length > 0
            ? `\n\n## 可用技能\n- ${skillSummaries.join('\n- ')}\n需要时请使用 use_skill 工具获取对应技能内容。`
            : '';
        content = content.replace('**DYNAMIC_SECTIONS**', `${skillBlock}\n\n**DYNAMIC_SECTIONS**`);
        return content;
    });

    // 动态段：长期记忆只短缓存并绑定版本号，保证刚写入的记忆立即可见；
    // 总结记忆与知识库变化频率更低，分别用版本号和知识库配置签名失效。
    const embeddingModelName = Model.getEmbeddingModel('text-embedding')?.name || '';
    const memoryKey = signature([
        'prompt:memory',
        session.sessionId,
        getMemoryRevision(),
        Config.memory.MEMORY,
        Config.model.EMBEDDING_MODEL_ENABLED,
        Model.getEmbeddingDimension(),
        embeddingModelName,
        ctx.isPrivate,
        session.memory.persona,
        seal.formatTmpl(ctx, '核心:骰子名字'),
        uis.map(u => u.id).join(','),
        uis.map(u => u.name).join(','),
        gi?.id || '',
        gi?.name || '',
        text
    ]);
    const summaryKey = signature([
        'prompt:summary',
        session.sessionId,
        getSummaryRevision(),
        Config.memory.SUMMARY
    ]);
    const knowledgeKey = signature(['prompt:knowledge', knowledgeService.getCacheVersion()]);

    const memoryTask = Config.memory.MEMORY
        ? getCachedString(memoryKey, LONG_TERM_MEMORY_TTL, () => MemoryManager.buildLongTermPrompt(ctx, session, text, uis, gi || null))
        : Promise.resolve('');
    const summaryTask = Config.memory.SUMMARY
        ? getCachedString(summaryKey, SUMMARY_TTL, () => MemoryManager.buildObservationPrompt(session))
        : Promise.resolve('');
    const knowledgeTask = Config.knowledgeBase.KNOWLEDGE
        ? getCachedString(knowledgeKey, KNOWLEDGE_TTL, () => MemoryManager.buildKnowledgePrompt(session, text))
        : Promise.resolve('');

    const [memoryPrompt, summaryPrompt, knowledgePrompt] = await Promise.all([memoryTask, summaryTask, knowledgeTask]);

    const dynamicSections = [memoryPrompt, summaryPrompt, knowledgePrompt].filter(Boolean).join('\n\n');
    const content = frame
        .split('**CURRENT_TIME**').join(fmtDate(Math.floor(Date.now() / 1000)))
        .split('**DYNAMIC_SECTIONS**').join(dynamicSections);

    // 防注入：长期记忆/总结记忆/知识库等外部内容可能夹带内部上下文标签，system prompt 出口统一兜底剥离
    return stripInternalTags(content);
}
