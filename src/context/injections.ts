// 增量注入块契约（L0 零 import 叶子）：只放类型、常量与纯函数。
//
// 约束：
// - 不得 import 任何模块（包括 events.ts 的类型，用结构类型适配）；
// - 不得读取 Config / session / storage / 当前时刻（渲染只依赖事件内冻结值 + 传入水位）。
//
// 位置约定：本文件按 #163 D3a 属 **L0**，规则由 scripts/lib/deps.mjs 的 LAYER_RULES 显式声明
//（否则会落到 `^src/context/` 的 L3 规则上，产生 context → context 的同层边与反向违规）。

export const INJECTION_META_VERSION = 1;
/** 单块 [system:inject-*] 包装的 token 上界（与正文估算相加得 meta.tokens） */
export const INJECTION_WRAP_TOKENS = 12;
/** 单块条目数上限（防御脏数据） */
export const INJECTION_MAX_ITEMS = 256;

/** 一条注入条目（冻结正文 + 去重/修订/同文三套键） */
export interface InjectionItem {
    /** 去重键；memory = `${bankId}|${kind}|${id}`，time = `time:<seq>`，mcp = `mcp:<server>`，wake = 固定串 */
    k: string;
    /** 内容修订 = fnv1a32(规范化正文)；用于 updated 判定 */
    r: number;
    /** 文本哈希 = fnv1a32(规范化正文)；用于跨 bank 同文去重 */
    h: number;
    /** 冻结正文（写入后不可变） */
    text: string;
    /** 来源事件 seq（redact 失效判定用，可选） */
    refSeq?: number;
}

/** 写入事件的 `raw.injection` 元数据（落盘结构，**不得新增 ContextHead 字段**） */
export interface InjectionMeta {
    v: number;
    kind: string;
    /** 创建时刻的 lastSentSeq，经 clampAnchor 夹紧；永不改写 */
    afterSeq: number;
    /** 冻结正文 token 估算（正文 + INJECTION_WRAP_TOKENS） */
    tokens: number;
    items: InjectionItem[];
    createdAt: number;
    banks?: string[];
}

/** 适配 ConversationEvent 的结构子集（L0 不能 import events.ts） */
export interface InjectionEventLike {
    kind?: unknown;
    seq?: unknown;
    at?: unknown;
    systemName?: unknown;
    raw?: unknown;
    parts?: unknown;
}
export interface InjectionRef<E extends InjectionEventLike = InjectionEventLike> { event: E; meta: InjectionMeta }
export interface RedactLike { fromSeq: number; toSeq: number; target?: string }
export interface SplitOptions { isStale?: (meta: InjectionMeta) => boolean }
export interface SplitResult<E extends InjectionEventLike = InjectionEventLike> {
    /** 非注入事件（喂 segmentUnits） */
    conversation: E[];
    /** 活跃注入块：未释放、未 stale，按 (afterSeq, seq) 升序 */
    injections: InjectionRef<E>[];
    /** 已释放/stale 注入块（不渲染、不计 token、退出去重集合；事件本身不删） */
    released: InjectionRef<E>[];
}

/** FNV-1a（32 位，按 UTF-16 码元）：与 memory/v2/templates.ts 同算法（L0 不能 import L1，故就地复制） */
export function fnv1a32(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function finiteInt(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.floor(n);
}

function nonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** 防御式解析：任何字段非法 → null（当作普通 system 事件，绝不抛错） */
export function injectionOf(event: InjectionEventLike | null | undefined): InjectionMeta | null {
    if (!event || typeof event !== 'object') return null;
    if (event.kind !== 'event') return null;
    const raw = event.raw;
    if (!raw || typeof raw !== 'object') return null;
    const meta = (raw as { injection?: unknown }).injection;
    if (!meta || typeof meta !== 'object') return null;
    const m = meta as Record<string, unknown>;
    if (finiteInt(m.v) !== INJECTION_META_VERSION) return null;
    const kind = nonEmptyString(m.kind);
    const afterSeq = finiteInt(m.afterSeq);
    const tokens = finiteInt(m.tokens);
    const createdAt = finiteInt(m.createdAt);
    if (!kind || afterSeq === null || afterSeq < 0 || tokens === null || tokens < 0) return null;
    if (!Array.isArray(m.items)) return null;
    const items: InjectionItem[] = [];
    for (const rawItem of m.items.slice(0, INJECTION_MAX_ITEMS)) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const it = rawItem as Record<string, unknown>;
        const k = nonEmptyString(it.k);
        const text = nonEmptyString(it.text);
        const r = finiteInt(it.r);
        const h = finiteInt(it.h);
        if (!k || !text || r === null || h === null) continue;
        const refSeq = finiteInt(it.refSeq);
        items.push({ k, r, h, text, ...(refSeq !== null && refSeq >= 1 ? { refSeq } : {}) });
    }
    if (items.length === 0) return null;
    const banks = Array.isArray(m.banks)
        ? m.banks.filter((b): b is string => typeof b === 'string').slice(0, 16)
        : undefined;
    return {
        v: INJECTION_META_VERSION, kind, afterSeq, tokens,
        items, createdAt: createdAt ?? 0, ...(banks && banks.length > 0 ? { banks } : {}),
    };
}

export function isInjection(event: InjectionEventLike | null | undefined): boolean {
    return injectionOf(event) !== null;
}

/**
 * 释放水位：`max(summarizedThrough, archivedThrough)`
 *（与 `compile.ts` 的 `hiddenBoundarySeq` 同口径）。
 *
 * 只有落在水位**以内**（`afterSeq <= 水位`）的注入块才算已释放：它的文本已经被摘要覆盖，
 * 再渲染就是重复内容；但事件本身不删、不改（append-only）。
 */
export function releaseBoundaryOf(head: { summarizedThrough?: unknown; archivedThrough?: unknown } | null | undefined): number {
    const s = Math.max(0, finiteInt(head && head.summarizedThrough) ?? 0);
    const a = Math.max(0, finiteInt(head && head.archivedThrough) ?? 0);
    return Math.max(s, a);
}

export function isReleased(meta: InjectionMeta, releaseBoundary: number): boolean {
    const boundary = finiteInt(releaseBoundary);
    return meta.afterSeq <= Math.max(0, boundary ?? 0);
}

/** 锚点夹紧（防御：并发快照/草稿重放/水位连推）；主逻辑是 isReleased */
export function clampAnchor(afterSeq: number, nextSeq: number, archivedThrough: number): number {
    const maxSeq = Math.max(0, (finiteInt(nextSeq) ?? 1) - 1);
    const low = Math.max(0, finiteInt(archivedThrough) ?? 0);
    const a = Math.max(0, finiteInt(afterSeq) ?? 0);
    return Math.min(maxSeq, Math.max(low, a));
}

function collectActive<E extends InjectionEventLike>(
    events: readonly E[],
    hiddenBoundarySeq: number,
    opts: SplitOptions = {},
): { injections: InjectionRef<E>[]; released: InjectionRef<E>[]; conversation: E[] } {
    const injections: InjectionRef<E>[] = [];
    const released: InjectionRef<E>[] = [];
    const conversation: E[] = [];
    for (const event of events) {
        const meta = injectionOf(event);
        if (!meta) { conversation.push(event); continue; }
        const ref: InjectionRef<E> = { event, meta };
        if (isReleased(meta, hiddenBoundarySeq) || (opts.isStale ? opts.isStale(meta) : false)) released.push(ref);
        else injections.push(ref);
    }
    injections.sort((a, b) => {
        const byAnchor = a.meta.afterSeq - b.meta.afterSeq;
        if (byAnchor !== 0) return byAnchor;
        const sa = finiteInt(a.event.seq) ?? 0;
        const sb = finiteInt(b.event.seq) ?? 0;
        return sa - sb;
    });
    return { injections, released, conversation };
}

/**
 * 拆出注入块：`conversation` 喂 segmentUnits，`injections` 参与渲染与去重，`released` 只做统计。
 *
 * **必须**先于 `segmentUnits` 调用：注入块永不进单元、永不进摘要、永不进 facts。
 */
export function splitInjections<E extends InjectionEventLike>(
    events: readonly E[], hiddenBoundarySeq: number, opts: SplitOptions = {},
): SplitResult<E> {
    return collectActive(events, hiddenBoundarySeq, opts);
}

/**
 * 活跃注入 token 合计（零分配版，`estimateT` 每轮多次调用）。
 *
 * 审核修订（AUDIT-002）：初版要求调用方自己算释放水位，导致与 `activeInjectTokens` 口径分裂。
 * 现在 `sumActiveInjectionTokens` 是纯内层函数，对外只暴露 `activeInjectTokens(events, head)`。
 *
 * 审核修订（AUDIT-003）：加单槽 memo（数组身份 + 水位），**绝不用 `store.version`**——
 * `commitArchive` 每次都 `version++`，而绝大多数轮次并没有块被释放 ⇒ 用 version 做键必然失效。
 * 单槽强引用最多持有 1 个事件数组（编译期间本就存活），不做无界缓存。
 */
export function sumActiveInjectionTokens(
    events: readonly InjectionEventLike[], hiddenBoundarySeq: number,
): number {
    const boundary = Math.max(0, finiteInt(hiddenBoundarySeq) ?? 0);
    if (tokenCache && tokenCache.events === events && tokenCache.boundary === boundary) {
        return tokenCache.total;
    }
    let total = 0;
    for (const event of events) {                 // 不 push、不 sort、不建数组
        const meta = injectionOf(event);
        if (!meta) continue;
        if (isReleased(meta, boundary)) continue;
        total += Math.max(0, meta.tokens);
    }
    tokenCache = { events, boundary, total };
    return total;
}

interface TokenCache { events: readonly InjectionEventLike[]; boundary: number; total: number }
let tokenCache: TokenCache | null = null;

/** 清空 token memo（测试 / JS 重载 / 会话切换用） */
export function resetInjectionTokenCache(): void {
    tokenCache = null;
}

/**
 * 归档把水位从 `before` 推到 `after` 后，**被释放**的块 token 合计。
 *
 * 只扫注入块（块数级，通常 < 10），不扫全量事件 ⇒ 归档循环里把 T 的修正成本从 O(n) 降到 O(块数)。
 */
export function releasedInjectTokens(
    events: readonly InjectionEventLike[], before: number, after: number,
): number {
    const from = Math.max(0, finiteInt(before) ?? 0);
    const to = Math.max(from, finiteInt(after) ?? 0);
    if (to <= from) return 0;
    let released = 0;
    for (const event of events) {
        const meta = injectionOf(event);
        if (!meta) continue;
        // 水位跨过块锚点 ⇒ 本轮由"活动"变"已释放"
        if (meta.afterSeq > from && meta.afterSeq <= to) released += Math.max(0, meta.tokens);
    }
    return released;
}

/** `T` 的第三项。`estimateT` 只调这个；禁止调用方传 `hiddenBoundarySeq`（AUDIT-002）。 */
export function activeInjectTokens(
    events: readonly InjectionEventLike[],
    head: { summarizedThrough?: unknown; archivedThrough?: unknown } | null | undefined,
): number {
    return sumActiveInjectionTokens(events, releaseBoundaryOf(head));
}

/** redact 失效：任一条目 refSeq 落在生效 redact 区间 ⇒ 整块 released（不重建、不删事件） */
export function isStaleByRecords(meta: InjectionMeta, redacts: readonly RedactLike[] | null | undefined): boolean {
    if (!Array.isArray(redacts) || redacts.length === 0) return false;
    for (const item of meta.items) {
        const seq = item.refSeq;
        if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 1) continue;
        for (const r of redacts) {
            const from = finiteInt(r && r.fromSeq);
            const to = finiteInt(r && r.toSeq);
            if (from === null || to === null) continue;
            if (seq >= from && seq <= to) return true;
        }
    }
    return false;
}

/** 去重账本派生：只收活跃块的条目（key → 内容修订号） */
export function activeInjectionItems(
    events: readonly InjectionEventLike[], hiddenBoundarySeq: number, opts: SplitOptions = {},
): Map<string, number> {
    const out = new Map<string, number>();
    for (const ref of collectActive(events, hiddenBoundarySeq, opts).injections) {
        for (const item of ref.meta.items) out.set(item.k, item.r);   // 后写覆盖 = 更晚的块版本
    }
    return out;
}

/** 同文去重集合：只收活跃块条目文本哈希 */
export function activeInjectionTextHashes(
    events: readonly InjectionEventLike[], hiddenBoundarySeq: number, opts: SplitOptions = {},
): Set<number> {
    const out = new Set<number>();
    for (const ref of collectActive(events, hiddenBoundarySeq, opts).injections) {
        for (const item of ref.meta.items) out.add(item.h);
    }
    return out;
}

/** 分 kind 派生（各 kind 独立集合，REQ-D3-35） */
export function activeInjectionsByKind(
    events: readonly InjectionEventLike[], hiddenBoundarySeq: number, opts: SplitOptions = {},
): Map<string, { keys: Map<string, number>; texts: Set<number> }> {
    const out = new Map<string, { keys: Map<string, number>; texts: Set<number> }>();
    for (const ref of collectActive(events, hiddenBoundarySeq, opts).injections) {
        const bucket = out.get(ref.meta.kind) ?? { keys: new Map<string, number>(), texts: new Set<number>() };
        for (const item of ref.meta.items) { bucket.keys.set(item.k, item.r); bucket.texts.add(item.h); }
        out.set(ref.meta.kind, bucket);
    }
    return out;
}

/** 确定性 eventId：同 kind + 同 afterSeq + 同 items(k@r 排序) ⇒ 同 id（同 run 内二次写被 store 去重） */
export function injectionEventId(kind: string, afterSeq: number, items: readonly InjectionItem[]): string {
    const fingerprint = fnv1a32(items.map(i => `${i.k}@${i.r}`).sort().join(',')).toString(16);
    return `e:inj:${kind}:${Math.max(0, finiteInt(afterSeq) ?? 0)}:${fingerprint}`;
}

// ---------------------------------------------------------------------------
// 渲染位置（#163 REQ-D3-21~25）
// ---------------------------------------------------------------------------

/**
 * kind 的渲染顺序；由 `kind` **派生**，不落盘。
 *
 * 为什么 `time` 排最前：时间提供"当前时刻"这个坐标系，记忆与 MCP 说明都在这个坐标系下被理解。
 * 为什么不落盘 rank：`kind` 是稳定业务标识，rank 是渲染偏好；落盘则改 rank 要迁移历史数据，
 * 且旧版本不认新 kind。派生 ⇒ 升级改 rank 只需一次白名单 rebase（`injection-render-v<n>`）。
 *
 * 只有 **3 个**内置 kind（执行方案 R-03 裁决）：`wake` 是普通 `SystemEvent`（真实发生的事件），
 * 不是增量注入块，因此不在此表里。
 */
const KIND_RANK: Record<string, number> = {
    time: 0,
    memory: 1,
    mcp: 2,
};

/** 未登记 kind（含 `ext:<plugin>:<id>`）排最后：插件段绝不插到内置段前面 */
export const DEFAULT_KIND_RANK = 100;

export function kindRank(kind: string): number {
    const r = KIND_RANK[kind];
    return r === undefined ? DEFAULT_KIND_RANK : r;
}

/**
 * 同一插入点上的块排序：**先 rank 后 seq**（两级稳定排序）。
 *
 * 注：两个都未登记的扩展段之间只按 `seq`（写入顺序）排，**不保证跨轮稳定**——
 * 见 d3b G.6 的显式约定；内置 3 个 kind 的顺序由 rank 表 + seq 保证。
 */
export function compareBlocks(a: { kind: string; seq: number }, b: { kind: string; seq: number }): number {
    return kindRank(a.kind) - kindRank(b.kind) || a.seq - b.seq;
}

/**
 * anchor 的有效值：不低于归档水位（已释放区画不出来），不高于已知最大 seq（不能指向未来）。
 * 与 `clampAnchor(afterSeq, nextSeq, archivedThrough)` 等价，只是入参换成 head。
 */
export function effectiveAnchor(
    afterSeq: number, head: { nextSeq?: unknown; archivedThrough?: unknown } | null | undefined,
): number {
    return clampAnchor(
        finiteInt(afterSeq) ?? 0,
        finiteInt(head ? head.nextSeq : 1) ?? 1,
        finiteInt(head ? head.archivedThrough : 0) ?? 0,
    );
}

/**
 * 注入块在"渲染序"里的插入位置。
 *
 * 返回 `i ∈ [0, units.length]`：块插在 `units[i-1]` 之后、`units[i]` 之前
 *（`i = 0` 插最前，`i = n` 插最后 ⇒ 主路径永远是末尾）。
 *
 * **必须严格大于**（`toSeq > anchor`）：`toSeq <= anchor` 的单元已完整发送过，
 * 块必须排在它们之后。写成 `>=` 会把"上一轮刚发完的最后一条"当成未发送 ⇒ 块插到它前面
 * ⇒ 已发送前缀的字节顺序改变 ⇒ R1 破裂（d3b REQ-D3-22 反例 1，每轮必坏）。
 *
 * 返回的是**单元下标**，调用方按 `slice` 拼接 ⇒ 天然不会劈开单元（REQ-D3-24）。
 */
export function slot(
    block: { kind?: string; seq?: number; afterSeq: number },
    units: readonly { toSeq: number }[],
    head: { nextSeq?: unknown; archivedThrough?: unknown } | null | undefined,
): number {
    const anchor = effectiveAnchor(block.afterSeq, head);
    let i = 0;
    while (i < units.length && units[i].toSeq <= anchor) i++;
    return i;
}

