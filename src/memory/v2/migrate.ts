// 旧记忆迁移：把旧存档中的记忆数据写入 Hindsight-like 新引擎。
import type { MemoryEngine } from "./engine";

import { getMemoryEngine } from "./index";

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
    engine: MemoryEngine = getMemoryEngine()
): Promise<number> {
    const tags: string[] = [];
    let count = 0;

    if (source.memoryMap) {
        for (const id of Object.keys(source.memoryMap)) {
            const m = source.memoryMap[id];
            if (!m || !m.content) continue;
            const unitTags = [
                ...tags,
                ...(m.tags || []),
                ...(m.users || []).map(u => `user:${u}`),
                ...(m.groups || []).map(g => `group:${g}`),
                m.visibility === 'private' ? 'vis:private' : 'vis:public',
            ];
            const result = await engine.addMemory(bankId, {
                content: m.content,
                tags: Array.from(new Set(unitTags)),
                metadata: { legacyId: id, type: m.type || 'text' },
                importance: m.importance ?? 0.5,
                factType: m.type === 'event' ? 'experience' : 'world',
                verbatim: true,
            });
            if (result.action !== 'noop') count++;
        }
    }

    if (source.summaries && source.summaries.length > 0) {
        for (const summary of source.summaries) {
            if (!summary) continue;
            await engine.addMemory(bankId, {
                content: summary,
                tags: [...tags, 'observation:legacy'],
                factType: 'observation',
                importance: 0.7,
                verbatim: true,
            });
            count++;
        }
    }

    if (source.persona && source.persona !== '无') {
        await engine.createMentalModel(bankId, '这个用户/群的设定是什么？', source.persona, tags);
    }

    return count;
}
