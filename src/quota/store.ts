// 用量限制存储（L2）：内存为准 + 合并写 + 31 天裁剪 + 时钟回拨保护。
//
// 为什么自己声明 SAVE_MIN_INTERVAL_MS 而不 import `session/persistence`：
// 后者是 L3（`src/(context|session|prompt|tool|agent|subagent)/`），L2 import L3 会被
// `scripts/lib/deps.mjs` 的 ratchet 判为跨层违规。这里重声明同值常量并注释来由。
//
// 硬约束（需求 D8/D9）：
// - `record` 路径**永不抛**，写失败只 warning 并保留 dirty，下次 tick 退避重试；
// - 海豹 `ext.storageGet` 在 key 不存在时必然抛 ⇒ 读侧全 try/catch，缺键/空串/坏 JSON/版本不符都重建；
// - 合并写：开启时 5s 一次、关闭时 60s 一次（关闭态只记账不拦截，没必要高频落盘）。
import { getHost } from '../core/host';
import { logger } from '../logger';

import type { Counter, DimEntry, QuotaStore, WinCounter, WindowKey } from './types';

/** 插件存储键（与 usageMap 完全隔离，互不影响） */
export const QUOTA_STORAGE_KEY = 'quotaUsage';

/** 合并写最小间隔；与 src/session/persistence.ts:7 的 SAVE_MIN_INTERVAL_MS 同值（此处重声明避免 L2→L3） */
export const SAVE_MIN_INTERVAL_MS = 5000;

/** 总开关关闭时的落盘间隔：只统计不拦截，降频减少叠加式存储膨胀 */
export const SAVE_MIN_INTERVAL_DISABLED_MS = 60_000;

/** 维度条目空闲多久后裁剪（毫秒）：31 天 */
export const TRIM_IDLE_MS = 31 * 24 * 60 * 60 * 1000;

function emptyCounter(): Counter {
    return { k: '', v: 0 };
}

function emptyWinCounter(): WinCounter {
    return { h: emptyCounter(), w: emptyCounter(), m: emptyCounter() };
}

function emptyDimEntry(): DimEntry {
    return { ...emptyWinCounter(), seen: 0 };
}

/** 空 store（version 固定 1，lastNow 取当前时刻） */
export function emptyStore(now: number): QuotaStore {
    return {
        version: 1,
        lastNow: now,
        total: emptyWinCounter(),
        sessions: {},
        users: {},
        purposes: {},
    };
}

let cache: QuotaStore | null = null;
let dirty = false;
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function isCounter(value: unknown): value is Counter {
    if (!value || typeof value !== 'object') return false;
    const c = value as Counter;
    return typeof c.k === 'string' && typeof c.v === 'number' && Number.isFinite(c.v);
}

function isDimEntry(value: unknown): value is DimEntry {
    if (!value || typeof value !== 'object') return false;
    const e = value as DimEntry;
    return isCounter(e.h) && isCounter(e.w) && isCounter(e.m) && typeof e.seen === 'number';
}

/** 结构校验：任何字段缺失/类型不符都返回 null（交给调用方重建，避免读到半坏数据后 NaN 传染） */
function reviveStore(text: string, now: number): QuotaStore | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const raw = parsed as Partial<QuotaStore>;
    if (raw.version !== 1) return null;
    if (!isCounter((raw.total as WinCounter | undefined)?.h ?? null)) return null;
    const store = emptyStore(typeof raw.lastNow === 'number' ? raw.lastNow : now);
    store.total = raw.total as WinCounter;
    for (const key of ['sessions', 'users', 'purposes'] as const) {
        const source = raw[key];
        if (!source || typeof source !== 'object') continue;
        for (const [name, entry] of Object.entries(source)) {
            if (!name) continue;
            if (!isDimEntry(entry)) continue;
            store[key][name] = entry;
        }
    }
    return store;
}

/**
 * 读 store（模块级缓存）。任何异常都退化为空 store 并 warning，**永不抛**。
 *
 * 注意：`storageGet` 在 key 不存在时抛错是海豹的既定行为（见 `src/context/archive_store.ts`），
 * 首次运行必然走这条路径，因此这里把「缺键」当正常情况静默处理。
 */
export function loadStore(now: number): QuotaStore {
    if (cache) return cache;
    let text: string | null = null;
    try {
        text = getHost().storage.get(QUOTA_STORAGE_KEY);
    } catch {
        // 首次运行（key 不存在）走这里：静默，不刷 warning
        cache = emptyStore(now);
        return cache;
    }
    if (!text) {
        cache = emptyStore(now);
        return cache;
    }
    const revived = reviveStore(text, now);
    if (!revived) {
        logger.warning(`「${QUOTA_STORAGE_KEY}」数据损坏或版本不符，已重置为空（历史用量记录不受影响）`);
        cache = emptyStore(now);
        return cache;
    }
    cache = revived;
    return cache;
}

/** 标记有未落盘的改动（`record` 后调用；不启 timer，落盘由 scheduleFlush 决定） */
export function markDirty(): void {
    dirty = true;
}

/** 是否有未落盘改动（测试/诊断用） */
export function isDirty(): boolean {
    return dirty;
}

/**
 * 安排一次合并写。
 *
 * @param isEnabled 读取总开关；开启 5s、关闭 60s（关闭态只记账，降频）
 */
export function scheduleFlush(isEnabled: () => boolean, now: () => number = Date.now): void {
    if (!dirty || flushTimer) return;
    const interval = isEnabled() ? SAVE_MIN_INTERVAL_MS : SAVE_MIN_INTERVAL_DISABLED_MS;
    const elapsed = now() - lastFlushAt;
    const delay = elapsed >= interval ? 0 : interval - elapsed;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNow(now());
    }, Math.max(0, delay));
    // 不阻止进程退出（单测/CLI 场景）
    const timer = flushTimer as unknown as { unref?: () => void };
    if (typeof timer?.unref === 'function') timer.unref();
}

/**
 * 立即落盘（仅当有 dirty 改动）。
 *
 * 写失败：warning + 保留 dirty（下次 tick 重试），**永不抛**。
 * 成功：顺带裁剪 31 天未活动的 sessions/users 条目（purposes 只有 4 个键，不裁）。
 *
 * @returns 是否真的写入了存储
 */
export function flushNow(now: number = Date.now()): boolean {
    if (!dirty || !cache) return false;
    const store = cache;
    store.lastNow = Math.max(store.lastNow, now);
    trimIdle(store, now);
    try {
        getHost().storage.set(QUOTA_STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
        logger.warning(`写入「${QUOTA_STORAGE_KEY}」失败，稍后重试：${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    dirty = false;
    lastFlushAt = now;
    return true;
}

/** 裁剪空闲维度（`seen` 早于 31 天前） */
function trimIdle(store: QuotaStore, now: number): void {
    const cutoff = now - TRIM_IDLE_MS;
    for (const key of ['sessions', 'users'] as const) {
        const bucket = store[key];
        for (const name of Object.keys(bucket)) {
            if (bucket[name].seen < cutoff) delete bucket[name];
        }
    }
}

/**
 * 清空（`.ai tk quota clear`）：写空串并丢弃缓存。
 *
 * 写 `''` 而不是删除键：海豹没有删除存储的 API，读侧把空串当空 store（需求 FR-DATA-04）。
 */
export function resetStore(now: number): void {
    cache = emptyStore(now);
    dirty = false;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    lastFlushAt = now;
    try {
        getHost().storage.set(QUOTA_STORAGE_KEY, '');
    } catch (error) {
        logger.warning(`清空「${QUOTA_STORAGE_KEY}」失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 测试专用：丢弃内存缓存与 dirty 状态（下次读会重新走 storage） */
export function resetStoreCacheForTest(): void {
    cache = null;
    dirty = false;
    lastFlushAt = 0;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}

/** 测试专用：直接替换内存 store（不走 storage） */
export function setStoreForTest(store: QuotaStore): void {
    cache = store;
}

/** 取三窗口计数器的可写引用（不存在则建；`now` 用于 `seen`） */
export function ensureDimEntry(
    bucket: { [name: string]: DimEntry },
    name: string,
    now: number,
): DimEntry {
    if (!Object.prototype.hasOwnProperty.call(bucket, name)) bucket[name] = emptyDimEntry();
    const entry = bucket[name];
    entry.seen = Math.max(entry.seen, now);
    return entry;
}

/** 取某维度的三窗口计数器（窗口键不符视为该窗口 0） */
export function counterOf(entry: WinCounter, window: WindowKey, key: string): number {
    const counter = entry[window];
    return counter.k === key ? counter.v : 0;
}

/** 写某窗口计数（键变了直接从新值起算，等价于窗口重置） */
export function setCounter(entry: WinCounter, window: WindowKey, key: string, value: number): void {
    const counter = entry[window];
    counter.k = key;
    counter.v = value;
}
