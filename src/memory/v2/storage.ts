// 记忆存储抽象：支持 SealDice ext.storage 与测试用内存存储。
import { ext } from "../../config/config";

import type {
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

export interface MemoryStorage {
    getBank(id: string): PersistedBank | null;
    saveBank(bank: PersistedBank): void;
    deleteBank(id: string): void;
}

function keyOf(bankId: string, part: string): string {
    return `memv2:${bankId}:${part}`;
}

// 分片键：meta / units / links / docs（documents+chunks）/ obs（observations+entities+mentalModels）
// 避免整库大 JSON 反复全量写穿，仅变更的分片重写；旧版单 key（memv2:<id>:bank）读取时一次性迁移。
const MEMV2_PARTS = ['meta', 'units', 'links', 'docs', 'obs'] as const;

interface DocsPart {
    documents?: MemoryDocument[];
    chunks?: MemoryChunk[];
}

interface ObsPart {
    observations?: Observation[];
    entities?: MemoryEntity[];
    mentalModels?: MentalModel[];
}

export class SealMemoryStorage implements MemoryStorage {
    getBank(id: string): PersistedBank | null {
        try {
            // 新版分片：存在 meta 分片即按分片读取，部分分片缺失时容忍为空数组（迁移中断/旧数据兜底）
            const metaRaw = ext.storageGet(keyOf(id, 'meta'));
            if (metaRaw) {
                const meta = JSON.parse(metaRaw) as MemoryBankMeta;
                const units = (this.readPart(id, 'units') as MemoryUnit[] | null) ?? [];
                const links = (this.readPart(id, 'links') as MemoryLink[] | null) ?? [];
                const docs = (this.readPart(id, 'docs') as DocsPart | null) ?? {};
                const obs = (this.readPart(id, 'obs') as ObsPart | null) ?? {};
                return {
                    meta,
                    units,
                    entities: obs.entities ?? [],
                    links,
                    observations: obs.observations ?? [],
                    mentalModels: obs.mentalModels ?? [],
                    documents: docs.documents ?? [],
                    chunks: docs.chunks ?? [],
                };
            }

            // 旧版单 key：命中即一次性迁移到分片，并清空旧 key
            const raw = ext.storageGet(keyOf(id, 'bank'));
            if (!raw) return null;
            const bank = JSON.parse(raw) as PersistedBank;
            this.saveBank(bank);
            ext.storageSet(keyOf(id, 'bank'), '');
            return bank;
        } catch {
            return null;
        }
    }

    private readPart(id: string, part: string): unknown {
        const raw = ext.storageGet(keyOf(id, part));
        if (!raw) return null;
        return JSON.parse(raw);
    }

    saveBank(bank: PersistedBank): void {
        ext.storageSet(keyOf(bank.meta.id, 'meta'), JSON.stringify(bank.meta));
        ext.storageSet(keyOf(bank.meta.id, 'units'), JSON.stringify(bank.units));
        ext.storageSet(keyOf(bank.meta.id, 'links'), JSON.stringify(bank.links));
        ext.storageSet(keyOf(bank.meta.id, 'docs'), JSON.stringify({ documents: bank.documents, chunks: bank.chunks } satisfies DocsPart));
        ext.storageSet(keyOf(bank.meta.id, 'obs'), JSON.stringify({ observations: bank.observations, entities: bank.entities, mentalModels: bank.mentalModels } satisfies ObsPart));
    }

    deleteBank(id: string): void {
        for (const part of MEMV2_PARTS) {
            ext.storageSet(keyOf(id, part), '');
        }
        // 兼容清理旧版单 key
        ext.storageSet(keyOf(id, 'bank'), '');
    }
}

export class InMemoryMemoryStorage implements MemoryStorage {
    private map = new Map<string, PersistedBank>();

    getBank(id: string): PersistedBank | null {
        return this.map.get(id) || null;
    }

    saveBank(bank: PersistedBank): void {
        this.map.set(bank.meta.id, JSON.parse(JSON.stringify(bank)) as PersistedBank);
    }

    deleteBank(id: string): void {
        this.map.delete(id);
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
