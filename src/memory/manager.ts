// 记忆管理器：统一长期/短期/总结/知识库的读取入口，供 prompt 组装与检索使用
import Config from "../config/config";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";

import { knowledgeService } from "./knowledge";

export class MemoryManager {
    /** 长期记忆段：按开关与检索构建（记忆条目 + 权重更新） */
    static async buildLongTermPrompt(ctx: seal.MsgContext, session: Session, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        const { MEMORY } = Config.memory;
        return MEMORY ? session.memory.buildMemoryPrompt(ctx, session.context, text, ui, gi) : '';
    }

    /** 总结记忆段：按开关构建 */
    static buildSummaryPrompt(session: Session): string {
        const { SUMMARY } = Config.memory;
        return SUMMARY ? session.memory.buildSummaryPrompt() : '';
    }

    /** 知识库段：按角色加载（角色无知识时回退全局），再按开关构建 */
    static async buildKnowledgePrompt(session: Session, roleIndex: number, text: string): Promise<string> {
        const { KNOWLEDGE } = Config.memory;
        if (!KNOWLEDGE) return '';
        await knowledgeService.updateKnowledgeMemory(roleIndex);
        return knowledgeService.buildKnowledgePrompt(session.context.sessionId, text);
    }
}
