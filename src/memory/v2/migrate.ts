// 旧记忆导入：把旧存档 memoryMap/summaries/persona 写入 v3 引擎（仅测试/迁移使用）。
import type { MemoryEngine } from "./engine";

import { bankKindOfBankId, getMemoryEngine, personaQuestionFor } from "./index";

export interface LegacyMemoryItem {
    id?: string;
    content?: string;
    tags?: string[];
    users?: string[];
    groups?: string[];
    visibility?: string;
    type?: string;
    importance?: number;
}

export interface LegacyMemorySource {
    memoryMap?: Record<string, LegacyMemoryItem>;
    summaries?: string[];
    persona?: string;
}

export async function migrateLegacyMemory(
    bankId: string,
    source: LegacyMemorySource,
    engine: MemoryEngine = getMemoryEngine(),
): Promise<number> {
    let count = 0;
    if (source.memoryMap) {
        for (const id of Object.keys(source.memoryMap)) {
            const m = source.memoryMap[id];
            if (!m?.content) continue;
            const tags = [
                ...(m.tags || []),
                ...(m.users || []).map(u => `user:${u}`),
                ...(m.groups || []).map(g => `group:${g}`),
                m.visibility === 'private' ? 'vis:owner' : 'vis:public',
            ];
            const result = await engine.retain(bankId, {
                content: m.content,
                tags: Array.from(new Set(tags)),
                metadata: { legacyId: id, type: m.type || 'text' },
                importance: m.importance ?? 0.5,
                factType: m.type === 'event' ? 'experience' : 'world',
            });
            if (result.action !== 'noop') count++;
        }
    }
    if (source.summaries?.length) {
        const now = Math.floor(Date.now() / 1000);
        for (const summary of source.summaries) {
            if (!summary) continue;
            engine.repository.addObservation(bankId, {
                id: `legacy_${count}_${Date.now().toString(36)}`,
                bankId,
                text: summary,
                tags: ['legacy:observation'],
                evidence: [],
                proofCount: 0,
                createdAt: now,
                updatedAt: now,
                lastSupportedAt: now,
                status: 'active',
                history: [{ text: summary, reason: 'created', at: now }],
            }, true);
            count++;
        }
    }
    if (source.persona && source.persona !== '无') {
        const kind = bankKindOfBankId(bankId);
        await engine.createMentalModel(bankId, personaQuestionFor(kind), source.persona, [], { templateId: 'persona' });
    }
    return count;
}
