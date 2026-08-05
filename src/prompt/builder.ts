// prompt 构建：system prompt 分节组装（角色/会话信息/能力/记忆/知识）
import Config from "../config/config";
import { MemoryManager } from "../memory/manager";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";
import User from "../session/user";
import { getSkillNames } from "../tool/skills";
import Tool from "../tool/tool";

export interface SystemPromptSection {
    name: string;
    content: string;
}

/**
 * 组装 system prompt 内容。
 * 各动态段（长期记忆/总结记忆/知识库/工具与技能）按开关独立构建后，
 * 交由用户可编辑的 SYSTEM_MESSAGE_TEMPLATE 骨架渲染固定部分。
 */
export async function buildSystemPromptContent(
    ctx: seal.MsgContext,
    session: Session,
    roleIndex: number,
    roleSetting: string
): Promise<string> {
    const { RECEIVE_IMAGE } = Config.received;
    const { STATUS, PROMPT_ENGINEERING } = Config.tool;

    // 本地可发送资源（图片/语音）来自“资源”配置
    const localImages = (Config.resource.LOCAL_IMAGES || []).map(img => ({ imageId: img.imageId }));
    const localAudios: any[] = Config.resource.LOCAL_AUDIOS || [];

    // 取最后一条用户消息，作为记忆/知识库查询的上下文
    const userMessages = session.context.messages.filter(m => m.role === 'user');
    let text = '', ui: UserInfo = null, gi: GroupInfo = null;
    const lastUser = userMessages[userMessages.length - 1] as any;
    if (lastUser && Array.isArray(lastUser.contentItems) && lastUser.contentItems.length > 0) {
        const lastItem = lastUser.contentItems[lastUser.contentItems.length - 1];
        text = lastItem.text || '';
        if (lastItem.userId) {
            const u = User.get(lastItem.userId);
            ui = { isPrivate: true, id: lastItem.userId, name: u.userName || lastItem.userId };
        }
        gi = { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
    }

    // 记忆段：长期记忆 + 总结记忆 + 知识库（统一由 MemoryManager 按开关构建）
    const memoryPrompt = await MemoryManager.buildLongTermPrompt(ctx, session, text, ui, gi);
    const summaryPrompt = MemoryManager.buildSummaryPrompt(session);
    const knowledgePrompt = await MemoryManager.buildKnowledgePrompt(session, roleIndex, text);

    // 能力段：工具函数 + 可用技能（MCP 工具已并入工具列表）
    const toolPrompt = STATUS && PROMPT_ENGINEERING ? Tool.getToolsInfoPrompt(session) : '';

    let content = Config.prompt.SYSTEM_MESSAGE_TEMPLATE({
        instruction: roleSetting,
        platform: ctx.endPoint.platform,
        sessionType: ctx.isPrivate ? 'private' : 'group',
        sessionName: ctx.isPrivate ? ctx.player.name : ctx.group.groupName,
        sessionId: ctx.isPrivate ? ctx.player.userId : ctx.group.groupId,
        RECEIVE_IMAGE,
        LOCAL_IMAGES: localImages,
        LOCAL_AUDIOS: localAudios,
        memoryPrompt,
        summaryPrompt,
        knowledgePrompt,
        toolPrompt
    });

    // 能力段：技能在两种工具模式下都可见（函数调用模式无工具提示词段时也能发现技能）
    const skillNames = getSkillNames();
    if (skillNames.length > 0) {
        content += `\n\n## 可用技能\n- ${skillNames.join('\n- ')}\n需要时请使用 use_skill 工具获取对应技能内容。`;
    }
    return content;
}
