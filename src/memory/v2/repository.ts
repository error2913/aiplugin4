// 记忆仓库：内存态 bank 管理 + 分片持久化 + v2→v3 惰性迁移。
import { migrateBankV3 } from "./migrate_v3";
import type { BankPart, MemoryStorage } from "./storage";
import { InMemoryMemoryStorage } from "./storage";
import type {
    MemoryBankMeta,
    MemoryEntity,
    MemoryLink,
    MemoryUnit,
    MentalModel,
    Observation,
    PersistedBank,
} from "./types";

function localId(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

export function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

export function normalizeName(name: string): string {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export class MemoryRepository {
    private banks = new Map<string, PersistedBank>();
    private dirty = new Map<string, Set<BankPart>>();
    private storage: MemoryStorage;

    constructor(storage?: MemoryStorage) {
        this.storage = storage || new InMemoryMemoryStorage();
    }

    get storageBackend(): MemoryStorage {
        return this.storage;
    }

    getBank(id: string): PersistedBank | null {
        let bank = this.banks.get(id);
        if (!bank && id === 'global_main') {
            // D9：旧 `*` 归一为 `_` 形成的 global__ 孤儿，惰性改名到 global_main
            const legacy = this.storage.getBank('global__');
            if (legacy && !this.storage.getBankMeta(id)) {
                this.storage.backupBank?.('global__', legacy, 'v2');
                legacy.meta.id = 'global_main';
                legacy.meta.kind = 'global';
                legacy.meta.sessionId = undefined;
                for (const u of legacy.units) u.bankId = 'global_main';
                for (const o of legacy.observations) o.bankId = 'global_main';
                for (const m of legacy.mentalModels) m.bankId = 'global_main';
                for (const e of legacy.entities) e.bankId = 'global_main';
                this.storage.saveBank(legacy);
                this.storage.deleteBank('global__');
            }
        }
        if (!bank) {
            bank = this.storage.getBank(id) ?? undefined;
            if (bank) {
                const oldSchema = (bank.meta as unknown as { schemaVersion?: number })?.schemaVersion;
                if (oldSchema !== 3) this.storage.backupBank?.(id, bank, 'v2');
                const result = migrateBankV3(bank);
                bank = result.bank;
                this.banks.set(id, bank);
                if (result.changed) this.save(id);
            }
        }
        return bank || null;
    }

    /** 只读 meta：调度器 tick 使用，不解析 units/links/obs。 */
    getBankMeta(id: string): MemoryBankMeta | null {
        const cached = this.banks.get(id);
        if (cached) return cached.meta;
        return this.storage.getBankMeta(id);
    }

    listBankIds(): string[] {
        return this.storage.listBankIds();
    }

    getOrCreateBank(id: string, kind?: MemoryBankMeta['kind'], agentName = '', sessionId?: string): PersistedBank {
        const existing = this.getBank(id);
        if (existing) return existing;
        const inferred = inferKind(id);
        const bankKind = kind && kind === inferred ? kind : inferred;
        const now = nowSec();
        const bank: PersistedBank = {
            meta: {
                id,
                kind: bankKind,
                agentName,
                sessionId: bankKind === 'global' ? undefined : (sessionId ?? id.replace(/^(user|group|global)_/, '')),
                createdAt: now,
                updatedAt: now,
                schemaVersion: 3,
                settings: {
                    nextFactSeq: 0,
                    pendingFactCount: 0,
                },
            },
            units: [],
            entities: [],
            links: [],
            observations: [],
            mentalModels: [],
        };
        this.banks.set(id, bank);
        this.save(id);
        return bank;
    }

    save(id: string, parts?: BankPart[]): void {
        const bank = this.banks.get(id);
        if (!bank) return;
        bank.meta.updatedAt = nowSec();
        const dirtyParts = parts ?? Array.from(this.dirty.get(id) ?? new Set<BankPart>(['meta', 'units', 'links', 'obs']));
        if (!parts) dirtyParts.push('meta');
        const unique = Array.from(new Set(dirtyParts));
        this.storage.saveBank(bank, unique);
        this.dirty.delete(id);
    }

    markDirty(id: string, part: BankPart): void {
        const set = this.dirty.get(id) ?? new Set<BankPart>();
        set.add(part);
        this.dirty.set(id, set);
    }

    deleteBank(id: string): void {
        this.banks.delete(id);
        this.dirty.delete(id);
        this.storage.deleteBank(id);
    }

    // ===== 原始事实 =====

    listUnits(bankId: string): MemoryUnit[] {
        return this.getBank(bankId)?.units.slice() ?? [];
    }

    getUnit(bankId: string, unitId: string): MemoryUnit | null {
        return this.getBank(bankId)?.units.find(u => u.id === unitId) ?? null;
    }

    findUnitByHash(bankId: string, hash: string): MemoryUnit | null {
        return this.getBank(bankId)?.units.find(u => u.metadata?.contentHash === hash) ?? null;
    }

    addUnit(bankId: string, unit: MemoryUnit, persist = false): void {
        const bank = this.getOrCreateBank(bankId);
        bank.units.push(unit);
        bank.meta.settings.pendingFactCount = (bank.meta.settings.pendingFactCount || 0) + 1;
        this.markDirty(bankId, 'units');
        this.markDirty(bankId, 'meta');
        if (persist) this.save(bankId, ['units', 'meta']);
    }

    updateUnit(bankId: string, unit: MemoryUnit, persist = false): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.units.findIndex(u => u.id === unit.id);
        if (idx >= 0) {
            bank.units[idx] = unit;
            this.markDirty(bankId, 'units');
            if (persist) this.save(bankId, ['units']);
        }
    }

    deleteUnits(bankId: string, ids: string[], persist = false): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const removing = new Set(ids);
        const pendingBefore = bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;
        bank.units = bank.units.filter(u => !removing.has(u.id));
        const pendingAfter = bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;
        if (pendingAfter !== pendingBefore) {
            bank.meta.settings.pendingFactCount = pendingAfter;
            this.markDirty(bankId, 'meta');
        }
        bank.links = bank.links.filter(l => !removing.has(l.fromUnitId) && !removing.has(l.toUnitId));
        for (const obs of bank.observations) {
            const before = obs.evidence.length;
            obs.evidence = obs.evidence.filter(e => !removing.has(e.memoryId));
            obs.proofCount = distinctLiveEvidence(bank, obs.evidence);
            if (obs.evidence.length !== before) this.markDirty(bankId, 'obs');
        }
        this.markDirty(bankId, 'units');
        this.markDirty(bankId, 'links');
        if (persist) this.save(bankId, ['units', 'links', 'obs', 'meta']);
    }

    listPendingFacts(bankId: string, limit: number): MemoryUnit[] {
        return this.listUnits(bankId)
            .filter(u => u.state === 'valid' && u.consolidationState === 'pending')
            .sort((a, b) => a.createdAtSeq - b.createdAtSeq)
            .slice(0, limit);
    }

    markConsolidated(bankId: string, ids: string[]): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const set = new Set(ids);
        const now = nowSec();
        let changed = false;
        for (const unit of bank.units) {
            if (set.has(unit.id) && unit.consolidationState === 'pending') {
                unit.consolidationState = 'done';
                unit.consolidatedAt = now;
                changed = true;
            }
        }
        if (changed) {
            bank.meta.settings.pendingFactCount = bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;
            this.markDirty(bankId, 'units');
            this.markDirty(bankId, 'meta');
        }
    }

    setPendingCount(bankId: string, count?: number): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        bank.meta.settings.pendingFactCount = count ?? bank.units.filter(u => u.state === 'valid' && u.consolidationState === 'pending').length;
        this.markDirty(bankId, 'meta');
    }

    maxFactSeq(bankId: string): number {
        const bank = this.getBank(bankId);
        if (!bank) return 0;
        return bank.units.reduce((max, u) => Math.max(max, u.createdAtSeq || 0), 0);
    }

    // ===== 实体/链接 =====

    listEntities(bankId: string): MemoryEntity[] {
        return this.getBank(bankId)?.entities.slice() ?? [];
    }

    upsertEntity(bankId: string, name: string, aliases?: string[]): MemoryEntity {
        const bank = this.getOrCreateBank(bankId);
        const canonical = normalizeName(name);
        if (!canonical) {
            return { id: localId(), bankId, canonicalName: name, aliases: aliases ?? [], firstSeen: nowSec(), lastSeen: nowSec(), mentionCount: 0 };
        }
        let entity = bank.entities.find(e => normalizeName(e.canonicalName) === canonical
            || e.aliases.some(a => normalizeName(a) === canonical));
        const now = nowSec();
        if (entity) {
            entity.lastSeen = now;
            entity.mentionCount++;
            for (const alias of aliases ?? []) {
                if (!entity.aliases.includes(alias)) entity.aliases.push(alias);
            }
        } else {
            entity = {
                id: localId(),
                bankId,
                canonicalName: name,
                aliases: aliases ?? [],
                firstSeen: now,
                lastSeen: now,
                mentionCount: 1,
            };
            bank.entities.push(entity);
        }
        this.markDirty(bankId, 'obs');
        return entity;
    }

    findEntity(bankId: string, name: string): MemoryEntity | null {
        const canonical = normalizeName(name);
        return this.getBank(bankId)?.entities.find(e => normalizeName(e.canonicalName) === canonical
            || e.aliases.some(a => normalizeName(a) === canonical)) ?? null;
    }

    listLinks(bankId: string): MemoryLink[] {
        return this.getBank(bankId)?.links.slice() ?? [];
    }

    addLink(bankId: string, link: MemoryLink, persist = false): void {
        const bank = this.getOrCreateBank(bankId);
        if (link.fromUnitId === link.toUnitId) return;
        if (bank.links.some(l => l.fromUnitId === link.fromUnitId && l.toUnitId === link.toUnitId && l.linkType === link.linkType)) return;
        bank.links.push(link);
        this.markDirty(bankId, 'links');
        if (persist) this.save(bankId, ['links']);
    }

    // ===== 观察 =====

    listObservations(bankId: string): Observation[] {
        return this.getBank(bankId)?.observations.slice() ?? [];
    }

    getObservation(bankId: string, id: string): Observation | null {
        return this.getBank(bankId)?.observations.find(o => o.id === id) ?? null;
    }

    addObservation(bankId: string, observation: Observation, persist = false): void {
        const bank = this.getOrCreateBank(bankId);
        bank.observations.push(observation);
        this.markDirty(bankId, 'obs');
        if (persist) this.save(bankId, ['obs']);
    }

    updateObservation(bankId: string, observation: Observation, persist = false): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.observations.findIndex(o => o.id === observation.id);
        if (idx >= 0) {
            bank.observations[idx] = observation;
            this.markDirty(bankId, 'obs');
            if (persist) this.save(bankId, ['obs']);
        }
    }

    deleteObservation(bankId: string, id: string, persist = false): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        bank.observations = bank.observations.filter(o => o.id !== id);
        this.markDirty(bankId, 'obs');
        if (persist) this.save(bankId, ['obs']);
    }

    // ===== 心智模型 =====

    listMentalModels(bankId: string): MentalModel[] {
        return this.getBank(bankId)?.mentalModels.slice() ?? [];
    }

    getMentalModel(bankId: string, id: string): MentalModel | null {
        return this.getBank(bankId)?.mentalModels.find(m => m.id === id) ?? null;
    }

    addMentalModel(bankId: string, model: MentalModel, persist = false): void {
        const bank = this.getOrCreateBank(bankId);
        bank.mentalModels.push(model);
        this.markDirty(bankId, 'obs');
        if (persist) this.save(bankId, ['obs']);
    }

    updateMentalModel(bankId: string, model: MentalModel, persist = false): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        const idx = bank.mentalModels.findIndex(m => m.id === model.id);
        if (idx >= 0) {
            bank.mentalModels[idx] = model;
            this.markDirty(bankId, 'obs');
            if (persist) this.save(bankId, ['obs']);
        }
    }

    deleteMentalModel(bankId: string, id: string, persist = false): void {
        const bank = this.getBank(bankId);
        if (!bank) return;
        bank.mentalModels = bank.mentalModels.filter(m => m.id !== id);
        this.markDirty(bankId, 'obs');
        if (persist) this.save(bankId, ['obs']);
    }
}

export function inferKind(bankId: string): MemoryBankMeta['kind'] {
    const prefix = String(bankId || '').split('_')[0];
    return prefix === 'user' || prefix === 'group' ? prefix : 'global';
}

export function distinctLiveEvidence(bank: PersistedBank, evidence: Array<{ memoryId: string }>): number {
    const live = new Set(bank.units.filter(u => u.state === 'valid').map(u => u.id));
    return new Set(evidence.filter(e => live.has(e.memoryId)).map(e => e.memoryId)).size;
}
