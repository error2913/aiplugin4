// 记忆仓库：内存态 Bank 管理 + 持久化。
import { InMemoryMemoryStorage, MemoryStorage } from "./storage";
import type {
    ConsolidationResult,
    MemoryBankMeta,
    MemoryChunk,
    MemoryDocument,
    MemoryEntity,
    MemoryLink,
    MemoryUnit,
    MentalModel,
    Observation,
    PersistedBank,
} from "./types";

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

export class MemoryRepository {
    private banks = new Map<string, PersistedBank>();
    private storage: MemoryStorage;

    constructor(storage?: MemoryStorage) {
        this.storage = storage || new InMemoryMemoryStorage();
    }

    getBank(id: string): PersistedBank | null {
        let bank = this.banks.get(id);
        if (!bank) {
            bank = this.storage.getBank(id) ?? undefined;
            if (bank) {
                normalizeBank(bank);
                this.banks.set(id, bank);
            }
        }
        return bank || null;
    }

    getOrCreateBank(id: string, kind: MemoryBankMeta['kind'] = 'global', agentName = ''): PersistedBank {
        const existing = this.getBank(id);
        if (existing) return existing;
        const bank: PersistedBank = {
            meta: {
                id,
                kind,
                agentName,
                sessionId: kind !== 'global' ? id : undefined,
                createdAt: nowSec(),
                updatedAt: nowSec(),
                settings: {
                    disposition: { skepticism: 3, literalism: 3, empathy: 3 },
                    directives: [],
                },
            },
            units: [],
            entities: [],
            links: [],
            observations: [],
            mentalModels: [],
            documents: [],
            chunks: [],
        };
        this.banks.set(id, bank);
        this.save(id);
        return bank;
    }

    deleteBank(id: string): void {
        this.banks.delete(id);
        this.storage.deleteBank(id);
    }

    save(id: string): void {
        const bank = this.banks.get(id);
        if (!bank) return;
        bank.meta.updatedAt = nowSec();
        this.storage.saveBank(bank);
    }

    // ===== Units =====

    listUnits(bankId: string): MemoryUnit[] {
        const bank = this.getBank(bankId);
        return bank ? bank.units.slice() : [];
    }

    getUnit(bankId: string, unitId: string): MemoryUnit | null {
        const bank = this.getBank(bankId);
        return bank ? bank.units.find(u => u.id === unitId) || null : null;
    }

    addUnit(bankId: string, unit: MemoryUnit): void {
        const bank = this.getOrCreateBank(bankId, 'global');
        bank.units.push(unit);
        this.save(bankId);
    }

    updateUnit(bankId: string, unit: MemoryUnit, persist = true): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.units.findIndex(u => u.id === unit.id);
        if (idx >= 0) {
            bank.units[idx] = unit;
            // persist=false 用于高频元数据更新（如 recall 的访问计数），由调用方批量落盘，避免每条命中都整库序列化
            if (persist) this.save(bankId);
        }
    }

    deleteUnit(bankId: string, unitId: string): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        bank.units = bank.units.filter(u => u.id !== unitId);
        bank.links = bank.links.filter(l => l.fromUnitId !== unitId && l.toUnitId !== unitId);
        bank.observations = bank.observations.map(o => ({
            ...o,
            evidence: o.evidence.filter(e => e.memoryId !== unitId),
            proofCount: o.evidence.filter(e => e.memoryId !== unitId).length,
        }));
        this.save(bankId);
    }

    /**
     * 批量物理删除单元（遗忘淘汰/手动清除用）：一次落盘，避免逐条整库序列化。
     * 同步清理相关 links 与 observation evidence 引用，返回实际删除条数。
     */
    deleteUnits(bankId: string, unitIds: string[]): number {
        const bank = this.getBank(bankId);
        if (!bank || unitIds.length === 0) return 0;
        const ids = new Set(unitIds);
        const before = bank.units.length;
        bank.units = bank.units.filter(u => !ids.has(u.id));
        bank.links = bank.links.filter(l => !ids.has(l.fromUnitId) && !ids.has(l.toUnitId));
        bank.observations = bank.observations.map(o => ({
            ...o,
            evidence: o.evidence.filter(e => !ids.has(e.memoryId)),
            proofCount: o.evidence.filter(e => !ids.has(e.memoryId)).length,
        }));
        this.save(bankId);
        return before - bank.units.length;
    }

    /**
     * 删除观察记忆：移除 observation 条目与同步的 observation unit，
     * 清理其他 observation 中对该观察证据的引用，并移除相关 links。
     */
    deleteObservation(bankId: string, observationId: string): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        bank.observations = bank.observations.filter(o => o.id !== observationId);
        bank.units = bank.units.filter(u => u.id !== observationId);
        bank.links = bank.links.filter(l => l.fromUnitId !== observationId && l.toUnitId !== observationId);
        bank.observations = bank.observations.map(o => ({
            ...o,
            evidence: o.evidence.filter(e => e.memoryId !== observationId),
            proofCount: o.evidence.filter(e => e.memoryId !== observationId).length,
        }));
        this.save(bankId);
    }

    // ===== Entities =====

    listEntities(bankId: string): MemoryEntity[] {
        const bank = this.getBank(bankId);
        return bank ? bank.entities.slice() : [];
    }

    getEntity(bankId: string, entityId: string): MemoryEntity | null {
        const bank = this.getBank(bankId);
        return bank ? bank.entities.find(e => e.id === entityId) || null : null;
    }

    findEntityByName(bankId: string, name: string): MemoryEntity | null {
        const bank = this.getBank(bankId);
        if (!bank) return null;
        const normalized = normalizeName(name);
        return bank.entities.find(e => normalizeName(e.canonicalName) === normalized
            || e.aliases.some(a => normalizeName(a) === normalized)) || null;
    }

    addEntity(bankId: string, entity: MemoryEntity): void {
        const bank = this.getOrCreateBank(bankId, 'global');
        bank.entities.push(entity);
        this.save(bankId);
    }

    updateEntity(bankId: string, entity: MemoryEntity): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.entities.findIndex(e => e.id === entity.id);
        if (idx >= 0) {
            bank.entities[idx] = entity;
            this.save(bankId);
        }
    }

    // ===== Links =====

    listLinks(bankId: string): MemoryLink[] {
        const bank = this.getBank(bankId);
        return bank ? bank.links.slice() : [];
    }

    addLink(bankId: string, link: MemoryLink): void {
        const bank = this.getOrCreateBank(bankId, 'global');
        const exists = bank.links.some(l =>
            l.fromUnitId === link.fromUnitId
            && l.toUnitId === link.toUnitId
            && l.linkType === link.linkType
            && l.entityId === link.entityId
        );
        if (!exists) bank.links.push(link);
        this.save(bankId);
    }

    // ===== Observations =====

    listObservations(bankId: string): Observation[] {
        const bank = this.getBank(bankId);
        return bank ? bank.observations.slice() : [];
    }

    addObservation(bankId: string, observation: Observation): void {
        const bank = this.getOrCreateBank(bankId, 'global');
        bank.observations.push(observation);
        this.save(bankId);
    }

    updateObservation(bankId: string, observation: Observation): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.observations.findIndex(o => o.id === observation.id);
        if (idx >= 0) {
            bank.observations[idx] = observation;
            this.save(bankId);
        }
    }

    // ===== Mental Models =====

    listMentalModels(bankId: string): MentalModel[] {
        const bank = this.getBank(bankId);
        return bank ? bank.mentalModels.slice() : [];
    }

    addMentalModel(bankId: string, model: MentalModel): void {
        const bank = this.getOrCreateBank(bankId, 'global');
        bank.mentalModels.push(model);
        this.save(bankId);
    }

    updateMentalModel(bankId: string, model: MentalModel): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.mentalModels.findIndex(m => m.id === model.id);
        if (idx >= 0) {
            bank.mentalModels[idx] = model;
            this.save(bankId);
        }
    }

    deleteMentalModel(bankId: string, id: string): boolean {
        const bank = this.getBank(bankId);
        if (!bank) return false;
        const idx = bank.mentalModels.findIndex(m => m.id === id);
        if (idx < 0) return false;
        bank.mentalModels.splice(idx, 1);
        this.save(bankId);
        return true;
    }

    // ===== Documents / Chunks =====

    getDocument(bankId: string, documentId: string): MemoryDocument | null {
        const bank = this.getBank(bankId);
        return bank ? bank.documents.find(d => d.id === documentId) || null : null;
    }

    addDocument(bankId: string, document: MemoryDocument): MemoryDocument {
        const bank = this.getOrCreateBank(bankId, 'global');
        const existing = bank.documents.find(d => d.id === document.id);
        if (existing) {
            existing.originalText = document.originalText;
            existing.contentHash = document.contentHash;
            existing.metadata = { ...existing.metadata, ...document.metadata };
        } else {
            bank.documents.push(document);
        }
        this.save(bankId);
        return this.getDocument(bankId, document.id)!;
    }

    addChunk(bankId: string, chunk: MemoryChunk): void {
        const bank = this.getOrCreateBank(bankId, 'global');
        const existing = bank.chunks.find(c => c.id === chunk.id);
        if (existing) {
            existing.text = chunk.text;
            existing.embedding = chunk.embedding;
        } else {
            bank.chunks.push(chunk);
        }
        this.save(bankId);
    }

    listChunks(bankId: string, documentId?: string): MemoryChunk[] {
        const bank = this.getBank(bankId);
        if (!bank) return [];
        return bank.chunks.filter(c => !documentId || c.documentId === documentId);
    }

    // ===== Consolidation helpers =====

    markUnitConsolidated(bankId: string, unitIds: string[], observationId?: string): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const now = nowSec();
        for (const unit of bank.units) {
            if (unitIds.includes(unit.id)) {
                unit.consolidationState = 'done';
                unit.consolidatedAt = now;
                if (observationId) unit.metadata = { ...unit.metadata, observationId };
            }
        }
        this.save(bankId);
    }

    mergeSimilarObservations(bankId: string, threshold: number): ConsolidationResult {
        const bank = this.getBank(bankId);
        if (!bank) return { created: [], updated: [], merged: [], skipped: 0 };
        const merged: string[] = [];
        const kept: Observation[] = [];
        for (const obs of bank.observations) {
            const target = kept.find(o => observationSimilarity(o.text, obs.text) >= threshold);
            if (target) {
                target.evidence = dedupEvidence([...target.evidence, ...obs.evidence]);
                target.proofCount = target.evidence.length;
                target.history.push({ text: obs.text, reason: 'merged', at: nowSec() });
                target.updatedAt = nowSec();
                merged.push(obs.id);
                bank.units = bank.units.filter(u => u.id !== obs.id);
            } else {
                kept.push(obs);
            }
        }
        bank.observations = kept;
        this.save(bankId);
        return { created: [], updated: [], merged, skipped: 0 };
    }
}

export function normalizeName(name: string): string {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 补齐旧存档缺省字段：MentalModel 的 E4 扩展字段（lastRefreshedAt/history/trigger） */
function normalizeBank(bank: PersistedBank): void {
    if (!Array.isArray(bank.mentalModels)) return;
    for (const m of bank.mentalModels) {
        if (typeof m.lastRefreshedAt !== 'number') m.lastRefreshedAt = typeof m.updatedAt === 'number' ? m.updatedAt : nowSec();
        if (!Array.isArray(m.history)) m.history = [];
        if (m.trigger !== 'full' && m.trigger !== 'delta') m.trigger = 'full';
    }
}

function dedupEvidence(evidence: Array<{ memoryId: string; quote: string }>): Array<{ memoryId: string; quote: string }> {
    const seen = new Set<string>();
    const out: Array<{ memoryId: string; quote: string }> = [];
    for (const e of evidence) {
        const key = `${e.memoryId}:${e.quote}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(e);
        }
    }
    return out;
}

function observationSimilarity(a: string, b: string): number {
    const gramsA = charNGrams(a);
    const gramsB = charNGrams(b);
    if (gramsA.size === 0 || gramsB.size === 0) return 0;
    let hit = 0;
    for (const g of gramsA) if (gramsB.has(g)) hit++;
    return hit / Math.min(gramsA.size, gramsB.size);
}

function charNGrams(s: string, min = 2, max = 3): Set<string> {
    const text = String(s || '').replace(/\s+/g, '');
    const set = new Set<string>();
    for (let n = min; n <= max; n++) {
        for (let i = 0; i + n <= text.length; i++) set.add(text.slice(i, i + n));
    }
    return set;
}
