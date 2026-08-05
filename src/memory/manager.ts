// 记忆管理器：统一长期/短期/总结/知识库的读取入口，供 prompt 组装与检索使用
import Config from "../config/config";
import Image from "../resource/image";
import { Session } from "../session/session";
import { GroupInfo, UserInfo } from "../session/types";

import { knowledgeService } from "./knowledge";
import MemoryItem from "./memory_item";
import { searchOptions } from "./types";

export class MemoryManager {
    /** 长期记忆段：按开关与检索构建（记忆条目 + 权重更新） */
    static async buildLongTermPrompt(ctx: seal.MsgContext, session: Session, text: string, ui: UserInfo | null, gi: GroupInfo | null): Promise<string> {
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

    /** 写入记忆：统一入口（内部含去重合并与向量生成） */
    static async addMemory(ctx: seal.MsgContext | null, session: Session, uiList: UserInfo[], giList: GroupInfo[], keywords: string[], images: Image[], text: string) {
        return session.memory.addMemory(ctx, session, uiList, giList, keywords, images, text);
    }

    /** 检索记忆：统一入口 */
    static async search(session: Session, text: string, options: searchOptions): Promise<MemoryItem[]> {
        return session.memory.search(text, options);
    }

    /** 触发短期记忆总结 */
    static async summarize(session: Session) {
        return session.memory.summarize();
    }
}
