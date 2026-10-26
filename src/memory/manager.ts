// 兼容门面：旧调用方仍可 import MemoryManager；新代码用 MemoryService。
// summarizeChunk* 仅为历史测试/legacy 路径保留，运行路径已改用 context_bridge + scheduler。
import Config from "../config/config";
import type { Session } from "../session/session";

import { bumpMemoryRevision, bumpSummaryRevision } from "./revision";
import { MemoryService, parseOccurredAt } from "./service";
import { parseLooseJson } from "./session_state";
import type { RecallOptions, RetainResult } from "./v2/types";

export class MemoryManager {
    static async buildLongTermPrompt(_ctx: seal.MsgContext, session: Session, text: string, uis: any[], gi: any): Promise<string> {
        return MemoryService.buildMemoryPrompt(session, text, uis, gi);
    }

    static buildObservationPrompt(session: Session): string {
        return MemoryService.buildObservationSectionForBank(MemoryService.bankIdForSessionId(session.sessionId, session.agentName));
    }

    static async retainMemory(
        _ctx: seal.MsgContext | null,
        session: Session,
        ul: any[],
        gl: any[],
        keywords: string[],
        _images: unknown[],
        text: string,
        visibility: 'public' | 'private' = 'public',
        type?: string,
        importance = 0.5,
    ): Promise<RetainResult> {
        return MemoryService.retainForSession(session, {
            content: text,
            relatedUserIds: (ul || []).map(u => u.id),
            relatedGroupIds: (gl || []).map(g => g.id),
            keywords,
            visibility,
            metadata: { type: type || 'text' },
            importance,
        });
    }

    static async recallMemory(session: Session, text: string, options: Partial<RecallOptions> = {}) {
        const hits = await MemoryService.recallForSessionId(session.sessionId, session.agentName, text, options);
        return hits.filter(h => h.kind === 'fact' && h.unit).map(h => h.unit!);
    }

    static async consolidateMemory(session: Session): Promise<{ summary: any }> {
        const bankId = MemoryService.bankIdForSessionId(session.sessionId, session.agentName);
        const result = await MemoryService.consolidateBank(bankId);
        const summary = typeof (Config.memory as any).MM_REFRESH_AFTER_CONSOLIDATION === 'boolean'
            ? await MemoryService.refreshMentalModels(bankId, { touchedTags: result.touchedTags, reason: 'consolidate' })
            : { updated: 0, skipped: 0, failed: 0, skippedReasons: {}, refreshedIds: [] };
        if (result.created.length + result.updated.length > 0) bumpSummaryRevision();
        return { summary };
    }

    static async reflectMemory(session: Session, query: string) {
        const bankId = MemoryService.bankIdForSessionId(session.sessionId, session.agentName);
        return MemoryService.reflect(bankId, query, { fastPath: true });
    }

    /** 旧归档/测试路径：文本 → 抽取 → 写事实 → 巩固。 */
    static async summarizeChunk(session: Session, messages: any[]): Promise<boolean> {
        const text = Array.isArray(messages)
            ? messages.map(m => Array.isArray(m?.contentItems)
                ? m.contentItems.map((it: any) => it?.text || '').join('')
                : String(m?.content || '')).join('\n')
            : '';
        if (!text.trim()) return false;
        try {
            const outcome = await MemoryService.extractFromChunk(session, { text, throughSeq: 0, textLength: text.length }, 'archive');
            for (const bankId of outcome.touchedBanks) {
                await MemoryService.consolidateBank(bankId);
            }
            bumpMemoryRevision();
            bumpSummaryRevision();
            return true;
        } catch {
            return false;
        }
    }

    static async summarizeChunkWithRetry(session: Session, messages: any[]): Promise<boolean> {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (await this.summarizeChunk(session, messages)) return true;
        }
        return false;
    }

    static async migrateLegacyPersona(session: Session): Promise<void> {
        const persona = session.memory.persona;
        if (!persona || persona === '无') return;
        const bankId = MemoryService.bankIdForSessionId(session.sessionId, session.agentName);
        await MemoryService.ensureBank(bankId, /-Group:/.test(session.sessionId) ? 'group' : 'user', session.agentName);
        const question = /-Group:/.test(session.sessionId) ? '这个群聊的设定是什么？' : '这个用户的设定是什么？';
        await MemoryService.reflect(bankId, question, { fastPath: false, strict: false });
        session.memory.persona = '无';
    }
}

export { parseLooseJson, parseOccurredAt };
export { MemoryService };
export type { RetainResult };
