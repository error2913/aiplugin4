// prompt 构建：system prompt 分节组装（角色/会话信息/静态能力/动态记忆）
import Config from "../config/config";
import Message from "../context/message";
import { UserMessage, UserMessageItem } from "../context/types";
import { knowledgeService } from "../memory/knowledge";
import { MemoryManager } from "../memory/manager";
import { getMemoryRevision, getSummaryRevision } from "../memory/revision";
import Model from "../model/model";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { getSkillSummaries, getSkillsSignature } from "../tool/skills";
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

function signature(parts: Array<string | number | boolean>): string {
    return parts.map(String).join('|');
}

function toolStateSignature(session: Session): string {
    return Object.keys(session.toolState)
        .sort()
        .map(key => `${key}:${session.toolState[key] ? '1' : '0'}`)
        .join(',');
}

function buildSkillSummaryBlock(): string {
    const r = getSkillSummaries();
    if (r.summaries.length === 0) return '';
    const lines = ['## 可用技能'];
    for (const s of r.summaries) lines.push(`- ${s}`);
    if (r.truncated) {
        lines.push(`（共 ${r.total} 个技能，最多显示 100 个）`);
    }
    lines.push('需要完整列表：skill_list；需要技能内容：use_skill。');
    return lines.join('\n');
}

/**
 * 组装 system prompt 内容。
 * 静态段：角色/会话信息/消息标记/工作方向/工具/技能/知识库。
 * 动态段：当前时间/观察记忆/记忆工具提示/长期记忆与心智模型。
 */
export async function buildSystemPromptContent(
    ctx: seal.MsgContext,
    session: Session,
    _roleIndex: number,
    roleSetting: string
): Promise<string> {
    const { RECEIVE_IMAGE } = Config.received;
    const { STATUS, PROMPT_ENGINEERING, DIRECTION_PROMPT } = Config.tool;

    if (Config.knowledgeBase.KNOWLEDGE) await knowledgeService.init();

    // 取最近 2~3 条用户消息拼接，作为记忆检索的上下文（剥离内部标签）；
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

    // 静态壳：角色/平台/会话/BotID/工具/技能/知识库，连续对话可复用 30 秒。
    const toolState = STATUS ? toolStateSignature(session) : '';
    const skillConfigSignature = STATUS ? getSkillsSignature() : '';
    const knowledgeSignature = Config.knowledgeBase.KNOWLEDGE ? knowledgeService.getLibrariesSignature() : '';
    const staticKey = signature([
        'prompt:static',
        roleSetting,
        ctx.endPoint.platform,
        ctx.isPrivate ? 'private' : 'group',
        ctx.isPrivate ? ctx.player!.name : ctx.group!.groupName,
        ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId,
        ctx.endPoint.userId,
        RECEIVE_IMAGE,
        STATUS,
        PROMPT_ENGINEERING,
        DIRECTION_PROMPT,
        Config.tool.BLOCKED.join(','),
        Config.tool.DEFAULT_CLOSED.join(','),
        toolState,
        skillConfigSignature,
        knowledgeSignature
    ]);
    const frame = await getCachedString(staticKey, STATIC_FRAME_TTL, async () => {
        const toolBlock = STATUS
            ? (PROMPT_ENGINEERING ? Tool.getPromptEngineeringToolBlock(session) : Tool.getToolSummaryBlock(session))
            : '';
        const skillBlock = STATUS ? buildSkillSummaryBlock() : '';
        const knowledgeBlock = STATUS && Config.knowledgeBase.KNOWLEDGE ? knowledgeService.formatLibraries() : '';
        const staticBlocks = [toolBlock, skillBlock, knowledgeBlock].filter(Boolean).join('\n\n');

        return SYSTEM_MESSAGE_TEMPLATE({
            instruction: roleSetting,
            platform: ctx.endPoint.platform,
            sessionType: ctx.isPrivate ? 'private' : 'group',
            sessionName: ctx.isPrivate ? ctx.player!.name : ctx.group!.groupName,
            sessionId: ctx.isPrivate ? ctx.player!.userId : ctx.group!.groupId,
            botId: ctx.endPoint.userId,
            RECEIVE_IMAGE,
            DIRECTION_PROMPT,
            toolBlock: staticBlocks
        });
    });

    // 动态段：长期记忆/观察记忆分别缓存；当前时间每次动态生成
    const embeddingModelName = Model.getEmbeddingModel('text-embedding')?.name || '';
    const memoryKey = signature([
        'prompt:memory',
        session.sessionId,
        getMemoryRevision(),
        Config.memory.MEMORY,
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
    const memoryTask = Config.memory.MEMORY
        ? getCachedString(memoryKey, LONG_TERM_MEMORY_TTL, () => MemoryManager.buildLongTermPrompt(ctx, session, text, uis, gi || null))
        : Promise.resolve('');
    const summaryTask = Config.memory.SUMMARY
        ? getCachedString(summaryKey, SUMMARY_TTL, () => MemoryManager.buildObservationPrompt(session))
        : Promise.resolve('');

    const [memoryPrompt, summaryPrompt] = await Promise.all([memoryTask, summaryTask]);

    const timeBlock = `## 当前时间\n${fmtDate(Math.floor(Date.now() / 1000))}`;
    const memoryToolHint = (Config.memory.MEMORY || Config.memory.SUMMARY)
        ? '需要查看更多记忆时，使用 memory_recall 工具。'
        : '';
    const dynamicSections = [timeBlock, summaryPrompt, memoryToolHint, memoryPrompt]
        .filter(Boolean)
        .join('\n\n');

    const content = frame
        .split('**DYNAMIC_SECTIONS**')
        .join(dynamicSections);

    // 防注入：长期记忆/观察记忆等外部内容可能夹带内部上下文标签，system prompt 出口统一兜底剥离
    return stripInternalTags(content);
}