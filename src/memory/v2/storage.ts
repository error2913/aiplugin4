// 记忆存储抽象：支持 SealDice ext.storage 与测试用内存存储。
import { ext } from "../../config/config";

import type { PersistedBank } from "./types";

export interface MemoryStorage {
    getBank(id: string): PersistedBank | null;
    saveBank(bank: PersistedBank): void;
    deleteBank(id: string): void;
}

function keyOf(bankId: string, part: string): string {
    return `memv2:${bankId}:${part}`;
}

export class SealMemoryStorage implements MemoryStorage {
    getBank(id: string): PersistedBank | null {
        try {
            const raw = ext.storageGet(keyOf(id, 'bank'));
            if (!raw) return null;
            return JSON.parse(raw) as PersistedBank;
        } catch {
            return null;
        }
    }

    saveBank(bank: PersistedBank): void {
        ext.storageSet(keyOf(bank.meta.id, 'bank'), JSON.stringify(bank));
    }

    deleteBank(id: string): void {
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
