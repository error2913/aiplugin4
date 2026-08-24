// 旧记忆迁移：把旧 MemoryService.memoryMap / summaries / persona 写入 Hindsight-like 新引擎。
import MemoryItem from "../memory_item";

import type { MemoryEngine } from "./engine";
import type { MemoryUnit } from "./types";

import { getMemoryEngine } from "./index";

export interface LegacyMemorySource {
    memoryMap?: Record<string, MemoryItem>;
    summaries?: string[];
    persona?: string;
}

export async function migrateLegacyMemory(bankId: string, source: LegacyMemorySource, engine: MemoryEngine = getMemoryEngine()): Promise<number> {
    const engineInstance = engine;
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
            const result = await engineInstance.addMemory(bankId, {
                content: m.content,
                tags: Array.from(new Set(unitTags)),
                metadata: {
                    legacyId: id,
                    type: m.type || 'text',
                },
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
            await engineInstance.addMemory(bankId, {
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
        await engineInstance.createMentalModel(bankId, '这个用户/群的设定是什么？', source.persona, tags);
    }

    return count;
}

export function unitToLegacyView(unit: MemoryUnit): MemoryItem {
    const m = new MemoryItem();
    m.id = unit.id;
    m.sessionId = unit.bankId;
    m.type = unit.factType === 'observation' ? 'text' : unit.factType === 'experience' ? 'event' : 'fact';
    m.visibility = unit.tags.includes('vis:private') ? 'private' : 'public';
    m.createAt = unit.createdAt;
    m.lastAccessedAt = unit.lastAccessedAt;
    m.accessCount = unit.accessCount;
    m.importance = unit.importance;
    m.stale = unit.state !== 'valid';
    m.content = unit.text;
    m.vector = unit.embedding;
    m.tags = unit.tags;
    m.relatedMemories = [];
    m.users = unit.tags.filter(t => t.startsWith('user:')).map(t => t.slice(5));
    m.groups = unit.tags.filter(t => t.startsWith('group:')).map(t => t.slice(6));
    return m;
}
