// 注入去重判定（#163 REQ-D3-17~20）。
//
// 三套键：
// - `k`（条目键，稳定身份）→ `r`（内容修订号）：判 new / dup / updated / re-inject
// - `h`（正文哈希）→ `k`（首个持有者）：判跨 bank 同文 dup-text
//
// **不持久化**：索引每轮从活动注入块现算（memoize 见 `activeIndexFor`）。
// 理由（REQ-D3-19）：若持久化 `k → r`，归档推进 `archivedThrough` 后集合不更新 ⇒
// 该条目永远判 `dup` ⇒ 归档后模型再也看不到它（静默失能）。活动块是唯一事实源。
import { isReleased, isStaleByRecords } from "./injections";
import type { InjectionItem, InjectionRef } from "./injections";
import type { RedactLike } from "./injections";

export type DedupVerdict = 'new' | 'dup' | 'updated' | 'dup-text' | 're-inject';

/**
 * 活动块派生索引。
 *
 * - `byKey`：活动块里的条目 `k → r`
 * - `byText`：活动块里的正文 `h → k`（首个持有者，用于 dup-text 定位）
 * - `releasedKeys`：已释放块的条目 `k → r`（**只**用于 re-inject 判定）
 */
export interface ActiveIndex {
    byKey: Map<string, number>;
    byText: Map<number, string>;
    releasedKeys: Map<string, number>;
}

export interface ActiveIndexKey {
    /** 注入块事件数 */
    injectionCount: number;
    /** 注入块最大 seq（0 = 没有块） */
    injectionMaxSeq: number;
    /** 释放水位 = max(summarizedThrough, archivedThrough) */
    boundary: number;
}

/** 从注入块引用派生索引（纯函数，不碰 IO） */
export function buildActiveIndex(
    injections: readonly InjectionRef[],
    released: readonly InjectionRef[],
    boundary: number,
    opts: { isStale?: (meta: InjectionRef['meta']) => boolean } = {},
): ActiveIndex {
    const byKey = new Map<string, number>();
    const byText = new Map<number, string>();
    const releasedKeys = new Map<string, number>();
    // 已释放（水位越过 / redact 失效）的块只记 key，供 re-inject 判定；不进活动集合
    for (const ref of released) {
        for (const item of ref.meta.items) {
            if (!releasedKeys.has(item.k)) releasedKeys.set(item.k, item.r);
        }
    }
    for (const ref of injections) {
        if (isReleased(ref.meta, boundary)) continue;
        if (opts.isStale && opts.isStale(ref.meta)) continue;
        for (const item of ref.meta.items) {
            byKey.set(item.k, item.r);           // 后写覆盖 = 更晚的块版本
            if (!byText.has(item.h)) byText.set(item.h, item.k);
        }
    }
    return { byKey, byText, releasedKeys };
}

/**
 * 判定单个条目（纯函数，无副作用）。
 *
 * 五分支（REQ-D3-18）：
 * | 判定 | 写块 | 行首 |
 * |---|---|---|
 * | new      | ✅ | 原文 |
 * | dup      | ❌ | — |
 * | updated  | ✅ | `(updated) `（新块只装变化项） |
 * | dup-text | ❌ | — |
 * | re-inject| ✅ | 原文（不是"内容更新"，是"归档后重新讲一遍"） |
 *
 * **`updated` 必须用活动块的 `r`**，不能用 `releasedKeys` 的 `r`；否则
 *「已释放 → 重新注入 → 内容又变」会被误判成 dup。
 * **`dup` 优先于 `dup-text`**：同 key 命中先返回，不落到正文比较。
 */
export function classifyItem(item: InjectionItem, index: ActiveIndex): DedupVerdict {
    const activeR = index.byKey.get(item.k);
    if (activeR !== undefined) return activeR === item.r ? 'dup' : 'updated';
    const textOwner = index.byText.get(item.h);
    if (textOwner !== undefined && textOwner !== item.k) return 'dup-text';
    return index.releasedKeys.has(item.k) ? 're-inject' : 'new';
}

/** 判定并分组：把候选条目按"要写 / 要跳过"切开，并给 updated 条目打标记 */
export interface ClassifiedDraft {
    /** 实际要写入的条目（new / updated / re-inject） */
    items: InjectionItem[];
    /** 与 `items` 同序的判定（供"超预算时延后 updated"用） */
    verdicts: WriteVerdict[];
    /** new + re-inject 的条数（用于统计） */
    fresh: number;
    /** updated 条数 */
    updated: number;
    /** dup + dup-text 跳过条数（**不是**"跳注"：内容已在活动块里） */
    skipped: number;
}

/** 实际会被写入的三种判定（dup / dup-text 被剔除，不出现） */
export type WriteVerdict = 'new' | 'updated' | 're-inject';

/**
 * 按索引判定一批候选条目并打好 `(updated) ` 行首。
 *
 * 注意：这里**只**决定"写不写 / 加不加标记"，位置与预算由 writer 决定。
 */
export function classifyItems(items: readonly InjectionItem[], index: ActiveIndex): ClassifiedDraft {
    const out: InjectionItem[] = [];
    const verdicts: WriteVerdict[] = [];
    let fresh = 0;
    let updated = 0;
    let skipped = 0;
    const seenK = new Set<string>();
    for (const item of items) {
        // 同批内重复：只留第一条（provider 侧通常会去重，这里是防御）
        if (seenK.has(item.k)) { skipped++; continue; }
        seenK.add(item.k);
        const verdict = classifyItem(item, index);
        if (verdict === 'dup' || verdict === 'dup-text') { skipped++; continue; }
        if (verdict === 'updated') {
            updated++;
            out.push({ ...item, text: `(updated) ${stripUpdatedPrefix(item.text)}` });
            verdicts.push('updated');
            continue;
        }
        fresh++;
        out.push({ ...item, text: stripUpdatedPrefix(item.text) });
        verdicts.push(verdict);
    }
    return { items: out, verdicts, fresh, updated, skipped };
}

/** 去掉可能已存在的 `(updated) ` 前缀，避免重复叠加（provider 可能复用了上一次的正文） */
function stripUpdatedPrefix(text: string): string {
    return text.startsWith('(updated) ') ? text.slice('(updated) '.length) : text;
}

// ---------------------------------------------------------------------------
// memoize（REQ-D3-20 / AUDIT-003）
// ---------------------------------------------------------------------------

interface ActiveIndexCache {
    index: ActiveIndex;
    key: ActiveIndexKey;
}

let cache: ActiveIndexCache | null = null;
/** 命中/未命中计数（单测与 `.ai ctx` 观测用） */
let cacheHits = 0;
let cacheMisses = 0;

/**
 * memoize 键 = **(注入块事件数, 注入块最大 seq, 释放水位)**。
 *
 * **绝不能用 `store.version` 做键**：`commitArchive` 每次都 `version++`（AUDIT-003），
 * 而归档循环里"没有块被释放"的轮次占绝大多数 ⇒ 用 version 作键则 64 轮循环一次都命不中。
 * 但这三个量只在"真的改变活动集合"时才变：
 * - 写新块 ⇒ `injectionCount` + 1 ⇒ 自然 miss（正确，必须重建）
 * - 归档释放块 ⇒ `boundary` 变 ⇒ 自然 miss（正确）
 * - 归档但没释放任何块 ⇒ 三者都不变 ⇒ 命中（这正是 AUDIT-003 要救的关键场景）
 *
 * `dup` / `dup-text` 不写块 ⇒ 集合不变 ⇒ 命中。`updated` 写块 ⇒ count 变 ⇒ miss。
 */
export function activeIndexFor(
    injections: readonly InjectionRef[],
    released: readonly InjectionRef[],
    key: ActiveIndexKey,
    redacts?: readonly RedactLike[] | null,
): ActiveIndex {
    if (cache && cache.key.injectionCount === key.injectionCount
        && cache.key.injectionMaxSeq === key.injectionMaxSeq
        && cache.key.boundary === key.boundary) {
        cacheHits++;
        return cache.index;
    }
    cacheMisses++;
    cache = {
        index: buildActiveIndex(injections, released, key.boundary, {
            isStale: redacts && redacts.length > 0
                ? meta => isStaleByRecords(meta, redacts)
                : undefined,
        }),
        key: { ...key },
    };
    return cache.index;
}

/** 清空 memo（测试 / JS 重载 / 会话切换用） */
export function resetActiveIndexCache(): void {
    cache = null;
    cacheHits = 0;
    cacheMisses = 0;
}

/** 观测：memo 命中/未命中（`.ai ctx` 与单测 T11 用） */
export function activeIndexCacheStats(): { hits: number; misses: number } {
    return { hits: cacheHits, misses: cacheMisses };
}

/** 从注入块引用列表算出 memo 键的三分量（O(块数)，不扫全量事件） */
export function activeIndexKeyOf(
    injections: readonly InjectionRef[], released: readonly InjectionRef[], boundary: number,
): ActiveIndexKey {
    let count = 0;
    let maxSeq = 0;
    for (const ref of injections) {
        count++;
        const seq = typeof ref.event.seq === 'number' ? ref.event.seq : 0;
        if (seq > maxSeq) maxSeq = seq;
    }
    for (const ref of released) {
        count++;
        const seq = typeof ref.event.seq === 'number' ? ref.event.seq : 0;
        if (seq > maxSeq) maxSeq = seq;
    }
    return { injectionCount: count, injectionMaxSeq: maxSeq, boundary: Math.max(0, Math.floor(boundary) || 0) };
}
