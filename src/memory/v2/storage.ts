// 记忆存储抽象：meta/units/links/obs 四分片 + bank 索引。
// 旧 v2 单 key / docs 分片在读取时兼容迁移；不再写入 docs。
import { getHost } from "../../core/host";

import type { MemoryBankMeta, MemoryEntity, MemoryLink, MemoryUnit, MentalModel, Observation, PersistedBank } from "./types";

export type BankPart = 'meta' | 'units' | 'links' | 'obs';

export interface MemoryStorage {
    getBank(id: string): PersistedBank | null;
    /** 只读 meta（调度器 tick 用，避免解析 units/links/obs） */
    getBankMeta(id: string): MemoryBankMeta | null;
    saveBank(bank: PersistedBank, parts?: BankPart[]): void;
    saveBankMeta(meta: MemoryBankMeta): void;
    listBankIds(): string[];
    deleteBank(id: string): void;
    /** 迁移前备份（幂等，不覆盖已有备份） */
    backupBank?(id: string, bank: PersistedBank, source: 'legacy' | 'v2'): void;
}

const INDEX_KEY = 'memv2:banks';
const PARTS: BankPart[] = ['meta', 'units', 'links', 'obs'];

function keyOf(bankId: string, part: string): string {
    return `memv2:${bankId}:${part}`;
}

interface ObsPart {
    observations?: Observation[];
    entities?: MemoryEntity[];
    mentalModels?: MentalModel[];
}

export class SealMemoryStorage implements MemoryStorage {
    getBank(id: string): PersistedBank | null {
        try {
            const metaRaw = getHost().storage.get(keyOf(id, 'meta'));
            if (metaRaw) {
                const meta = JSON.parse(metaRaw) as MemoryBankMeta;
                const units = this.readPart<MemoryUnit[]>(id, 'units') ?? [];
                const links = this.readPart<MemoryLink[]>(id, 'links') ?? [];
                const obs = this.readPart<ObsPart>(id, 'obs') ?? {};
                return {
                    meta,
                    units,
                    entities: obs.entities ?? [],
                    links,
                    observations: obs.observations ?? [],
                    mentalModels: obs.mentalModels ?? [],
                };
            }
            // 旧 v2 单 key：迁移到分片后清空
            const raw = getHost().storage.get(keyOf(id, 'bank'));
            if (!raw) return null;
            const legacy = JSON.parse(raw) as PersistedBank & { documents?: unknown; chunks?: unknown };
            const bank: PersistedBank = {
                meta: legacy.meta,
                units: legacy.units ?? [],
                entities: legacy.entities ?? [],
                links: legacy.links ?? [],
                observations: legacy.observations ?? [],
                mentalModels: legacy.mentalModels ?? [],
            };
            this.backupBank(id, bank, 'legacy');
            this.registerBank(id);
            this.saveBank(bank);
            getHost().storage.set(keyOf(id, 'bank'), '');
            return bank;
        } catch {
            return null;
        }
    }

    getBankMeta(id: string): MemoryBankMeta | null {
        try {
            const raw = getHost().storage.get(keyOf(id, 'meta'));
            return raw ? JSON.parse(raw) as MemoryBankMeta : null;
        } catch {
            return null;
        }
    }

    saveBank(bank: PersistedBank, parts: BankPart[] = PARTS): void {
        // 数据分片先写、meta 最后写：迁移时 schemaVersion=3 的 meta 不会先于数据出现，
        // 进程中断后可安全重试（旧 meta 仍在）。
        if (parts.includes('units')) getHost().storage.set(keyOf(bank.meta.id, 'units'), JSON.stringify(bank.units));
        if (parts.includes('links')) getHost().storage.set(keyOf(bank.meta.id, 'links'), JSON.stringify(bank.links));
        if (parts.includes('obs')) {
            const obs: ObsPart = {
                observations: bank.observations,
                entities: bank.entities,
                mentalModels: bank.mentalModels,
            };
            getHost().storage.set(keyOf(bank.meta.id, 'obs'), JSON.stringify(obs));
        }
        if (parts.includes('meta')) this.saveBankMeta(bank.meta);
        this.registerBank(bank.meta.id);
    }

    saveBankMeta(meta: MemoryBankMeta): void {
        getHost().storage.set(keyOf(meta.id, 'meta'), JSON.stringify(meta));
        this.registerBank(meta.id);
    }

    listBankIds(): string[] {
        try {
            const raw = getHost().storage.get(INDEX_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
        } catch {
            return [];
        }
    }

    deleteBank(id: string): void {
        for (const part of [...PARTS, 'bank', 'docs']) getHost().storage.set(keyOf(id, part), '');
        this.writeIndex(this.listBankIds().filter(x => x !== id));
    }

    backupBank(id: string, bank: PersistedBank, source: 'legacy' | 'v2'): void {
        try {
            const key = keyOf(id, `backup:${source}`);
            if (getHost().storage.get(key)) return;
            getHost().storage.set(key, JSON.stringify(bank));
        } catch { /* 备份失败不阻塞迁移 */ }
    }

    private registerBank(id: string): void {
        if (!id) return;
        const ids = this.listBankIds();
        if (!ids.includes(id)) {
            ids.push(id);
            this.writeIndex(ids);
        }
    }

    private writeIndex(ids: string[]): void {
        getHost().storage.set(INDEX_KEY, JSON.stringify(Array.from(new Set(ids))));
    }

    private readPart<T>(id: string, part: string): T | null {
        const raw = getHost().storage.get(keyOf(id, part));
        return raw ? JSON.parse(raw) as T : null;
    }
}

export class InMemoryMemoryStorage implements MemoryStorage {
    private map = new Map<string, PersistedBank>();
    private order: string[] = [];

    getBank(id: string): PersistedBank | null {
        const bank = this.map.get(id);
        return bank ? JSON.parse(JSON.stringify(bank)) as PersistedBank : null;
    }

    getBankMeta(id: string): MemoryBankMeta | null {
        const bank = this.map.get(id);
        return bank ? JSON.parse(JSON.stringify(bank.meta)) as MemoryBankMeta : null;
    }

    saveBank(bank: PersistedBank): void {
        this.map.set(bank.meta.id, JSON.parse(JSON.stringify(bank)) as PersistedBank);
        if (!this.order.includes(bank.meta.id)) this.order.push(bank.meta.id);
    }

    saveBankMeta(meta: MemoryBankMeta): void {
        const bank = this.map.get(meta.id);
        if (bank) bank.meta = JSON.parse(JSON.stringify(meta)) as MemoryBankMeta;
    }

    listBankIds(): string[] {
        return this.order.slice();
    }

    deleteBank(id: string): void {
        this.map.delete(id);
        this.order = this.order.filter(x => x !== id);
    }
}

let defaultStorage: MemoryStorage | null = null;

export function getDefaultMemoryStorage(): MemoryStorage {
    if (!defaultStorage) defaultStorage = new SealMemoryStorage();
    return defaultStorage;
}

export function setDefaultMemoryStorage(storage: MemoryStorage): void {
    defaultStorage = storage;
}
