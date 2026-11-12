// 增量注入写入口（#163 D3a 框架骨架 + D3b 去重/预算逻辑，L3）。
//
// 两个方案各写了一份 `injection_writer.ts`（执行方案 §3 冲突 1），裁决：
// **以 D3a 的 `writeInjectionBlocks` 为唯一骨架，D3b 的算法落地为它调用的两个钩子**
//（`createInjectionPlanHooks`），不再保留两份流程。
//
// 职责边界：
// - provider 只产候选条目（`src/prompt/injections/**`）；
// - 本文件负责「收集 → 合并 → 去重 → 三层额度 → 预算闸 → 先归档后写块 → 唯一写入口」。
//
// 三条硬约束（用户明令 + 缓存不变量）：
// 1. **禁止跳注**：预算不足不是跳过理由。只有"内容全部已在活动块里"（dup/dup-text）才不写块，
//    这不叫跳注。真正的跳注计数 `injectionsSkipped` 恒为 0。
// 2. **先归档后写块**：归档把 `archivedThrough` 推过 `afterSeq` 会让新块立刻被释放（等于没注入），
//    所以 anchor 必须在归档**之后**用新水位重算。
// 3. **绝不删除已写入的块**：没有 `deleteEvent/removeInjection/truncateInjections` 路径；
//    "消失"只能是归档释放（水位越过）或 redact 失效 —— 两者本身就是白名单 rebase。
import {
    INJECT_ACTIVE_MAX_TOKENS,
    INJECT_ACTIVE_WINDOW_TOKENS,
    INJECT_COLD_START_MAX_TOKENS,
    INJECT_PER_TURN_MAX_TOKENS,
} from "../utils/context_limits";

import { activeIndexFor, activeIndexKeyOf, classifyItems } from "./injection_dedup";
import type { ActiveIndex, WriteVerdict } from "./injection_dedup";
import {
    activeInjectTokens,
    INJECTION_WRAP_TOKENS,
    isStaleByRecords,
    releaseBoundaryOf,
    splitInjections,
} from "./injections";
import type { InjectionItem } from "./injections";
import type { ContextService } from "./service";

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/** provider 产出的候选 draft（未去重） */
export interface RawInjectionDraft {
    kind: string;
    items: InjectionItem[];
    /** 外部插件块（如已有 provider 侧 tokens 则原样带入） */
    tokens?: number;
    extension?: boolean;
}

/** 去重分类后的 draft（`updated` 条目已加 `(updated) ` 行首） */
export interface InjectionWriteDraft {
    kind: string;
    items: InjectionItem[];
    /** 与 `items` 同序的判定（供"超预算时延后 updated"用） */
    verdicts?: WriteVerdict[];
    /** Σ estimateTokens(text) + INJECTION_WRAP_TOKENS */
    tokens: number;
    /** 是否为外部插件块（单块字符上限 2000） */
    extension?: boolean;
}

/** 归档侧最小依赖（避免 context 层耦合 ArchiveController 具体类） */
export interface InjectionArchivePort {
    estimateT(): number;
    beforeRequest(info: { L: number; retainPercent: number }): void;
}

export interface InjectionWriteDeps {
    service: ContextService;
    archive: InjectionArchivePort;
    /** 与编译同口径的文本 token 估算（`utils/token_estimate.estimateTextTokens`） */
    estimateTokens: (text: string) => number;
    /** 与编译同口径的 L 计算（D7 抽出）：L = 预算 − 固定提示词 − 工具 JSON */
    computeL(info: { prefixTokens: number; toolsReserveTokens: number; permanentBudget: number }): number;
    observe?: (event: string, detail: Record<string, unknown>) => void;
    /** 需要强制 rebase 时通知会话层（`inject-overflow`，10 个白名单原因之一） */
    notePrefixRebase?: (reason: string, seq: number) => void;
}

export interface InjectionWriteBudget {
    prefixTokens: number;
    toolsReserveTokens: number;
    permanentBudget: number;
    retainPercent: number;
}

export interface InjectionWriteResult {
    /** 实际写入的块数 */
    blocks: number;
    /** 实际写入的条目数 */
    items: number;
    /** 实际写入的 token 估算 */
    tokens: number;
    /** 本次写入的块事件 seq */
    seqs: number[];
    /** 因"内容已在活动块里"跳过的条目数（**不是**跳注） */
    duplicates: number;
    /** 真正的跳注数：恒为 0（保留字段用于断言/观测） */
    skipped: number;
    /** 归档是否被触发 */
    archived: boolean;
}

/** 去重账本快照（不持久化，从活动块现算） */
export interface InjectionLedgerSnapshot {
    index: ActiveIndex;
    duplicates: number;
}

/** `writeInjectionBlocks` 的两个决策钩子（由 `createInjectionPlanHooks` 提供） */
export interface InjectionPlanHooks {
    /** 去重过滤：返回本轮实际要写的 draft（只含 new/updated/re-inject 条目） */
    filterByDedupe(drafts: readonly RawInjectionDraft[]): InjectionWriteDraft[];
    /** 预算闸（**禁止跳注**）：必要时先归档；返回 false 表示整块放弃（仅极端兜底使用） */
    ensureBudget(kind: string, tokens: number, budget: InjectionWriteBudget): Promise<boolean>;
}

/** 外部插件单块字符上限（REQ-D3-06）；超出逐条截断，整块不超 */
export const EXTENSION_INJECTION_MAX_CHARS = 2000;

// ---------------------------------------------------------------------------
// 去重派生
// ---------------------------------------------------------------------------

/** 从当前快照派生去重索引（不持久化；memo 键见 `injection_dedup.ts`） */
export function readInjectionLedger(
    service: ContextService,
): { index: ActiveIndex; boundary: number; activeTokens: number } {
    const snapshot = service.snapshot();
    const boundary = releaseBoundaryOf(snapshot.head);
    const redacts = snapshot.records.filter(record => record.kind === 'redact');
    const split = splitInjections(snapshot.events, boundary, {
        isStale: meta => isStaleByRecords(meta, redacts),
    });
    const key = activeIndexKeyOf(split.injections, split.released, boundary);
    return {
        index: activeIndexFor(split.injections, split.released, key, redacts),
        boundary,
        activeTokens: activeInjectTokens(snapshot.events, snapshot.head),
    };
}

/**
 * 把候选 draft 分类成"要写"的 draft（剔除 dup/dup-text，`updated` 打行首标记）。
 * `tokens` 按分类后的实际条目重算，保证与自己写入的块口径一致（I-06 三处同口径）。
 */
export function classifyDrafts(
    drafts: readonly RawInjectionDraft[],
    index: ActiveIndex,
    estimateTokens: (text: string) => number,
): { drafts: InjectionWriteDraft[]; duplicates: number } {
    const out: InjectionWriteDraft[] = [];
    let duplicates = 0;
    for (const draft of drafts) {
        const classified = classifyItems(draft.items, index);
        duplicates += classified.skipped;
        if (classified.items.length === 0) continue;
        let tokens = INJECTION_WRAP_TOKENS;
        for (const item of classified.items) tokens += Math.max(1, estimateTokens(item.text));
        out.push({
            kind: draft.kind,
            items: classified.items,
            verdicts: classified.verdicts,
            tokens,
            extension: draft.extension === true,
        });
    }
    return { drafts: out, duplicates };
}

/** 同 kind 合并成一个块（REQ-D3-05：同 provider/同 kind 一轮只产一个块） */
export function mergeDraftsByKind(drafts: readonly RawInjectionDraft[]): RawInjectionDraft[] {
    const byKind = new Map<string, RawInjectionDraft>();
    for (const draft of drafts) {
        const existing = byKind.get(draft.kind);
        if (!existing) {
            byKind.set(draft.kind, { ...draft, items: draft.items.slice() });
            continue;
        }
        existing.items = existing.items.concat(draft.items);
        if (draft.extension) existing.extension = true;
    }
    return Array.from(byKind.values());
}

// ---------------------------------------------------------------------------
// 三层额度
// ---------------------------------------------------------------------------

/**
 * 按**条目**累加到单轮上限。
 *
 * 绝不截断条目正文：截断会让同一 `k` 的 `r` 与完整正文的哈希不一致 ⇒ 下一轮判 `updated`
 * ⇒ 无限重写（d3b G.2）。单条目自身超上限时**单独成批**写入，否则它永远写不进去。
 */
export function clampToPerTurnBudget(
    drafts: readonly InjectionWriteDraft[],
    maxTokens: number,
    estimateTokens: (text: string) => number,
): InjectionWriteDraft[] {
    const out: InjectionWriteDraft[] = [];
    let used = 0;
    for (const draft of drafts) {
        const items: InjectionItem[] = [];
        const verdicts: WriteVerdict[] = [];
        for (let i = 0; i < draft.items.length; i++) {
            const item = draft.items[i];
            const itemTokens = Math.max(1, estimateTokens(item.text));
            if (items.length > 0 && used + itemTokens > maxTokens) break;
            items.push(item);
            if (draft.verdicts && draft.verdicts[i]) verdicts.push(draft.verdicts[i]);
            used += itemTokens;
            if (used >= maxTokens) break;
        }
        if (items.length === 0) continue;
        let tokens = INJECTION_WRAP_TOKENS;
        for (const item of items) tokens += Math.max(1, estimateTokens(item.text));
        out.push({
            ...draft,
            items,
            tokens,
            verdicts: verdicts.length === items.length ? verdicts : undefined,
        });
    }
    return out;
}

/** 冷启动上限：活动块为空（新会话首次注入）时放宽到 4×单轮，但不超过冷启动常量 */
export function coldStartCap(activeTokens: number, perTurn: number = INJECT_PER_TURN_MAX_TOKENS): number {
    if (activeTokens > 0) return perTurn;
    return Math.max(perTurn, Math.min(INJECT_COLD_START_MAX_TOKENS, perTurn * 4));
}

/** 外部插件块字符上限：逐条截断到整块 ≤ 2000 字符（不劈条目、不改条目哈希以外的语义） */
function clampExtensionDraft(draft: InjectionWriteDraft): InjectionWriteDraft {
    if (!draft.extension) return draft;
    let used = 0;
    const items: InjectionItem[] = [];
    const verdicts: WriteVerdict[] = [];
    for (let i = 0; i < draft.items.length; i++) {
        const item = draft.items[i];
        const room = EXTENSION_INJECTION_MAX_CHARS - used;
        if (room <= 0) break;
        const text = item.text.length > room ? item.text.slice(0, room) : item.text;
        items.push({ ...item, text });
        if (draft.verdicts && draft.verdicts[i]) verdicts.push(draft.verdicts[i]);
        used += text.length;
    }
    return { ...draft, items, verdicts: verdicts.length === items.length ? verdicts : undefined };
}

// ---------------------------------------------------------------------------
// 钩子实现（D3b 算法）
// ---------------------------------------------------------------------------

/**
 * 构造两个决策钩子。`ensureBudget` 就是 D3b `commitDrafts` 里的预算闸那段：
 * 算 `T + tokens >= L` → 调 `deps.archive.beforeRequest({L})` → 归档未切动则
 * `observe('injection-over-budget')` 后**仍返回 true**（禁止跳注）。
 */
export function createInjectionPlanHooks(deps: InjectionWriteDeps): InjectionPlanHooks {
    return {
        filterByDedupe(drafts: readonly RawInjectionDraft[]): InjectionWriteDraft[] {
            if (drafts.length === 0) return [];
            const ledger = readInjectionLedger(deps.service);
            const { drafts: classified } = classifyDrafts(drafts, ledger.index, deps.estimateTokens);
            const activeTokens = ledger.activeTokens;
            const capped = clampToPerTurnBudget(
                classified,
                coldStartCap(activeTokens),
                deps.estimateTokens,
            );
            return capped.map(clampExtensionDraft);
        },

        async ensureBudget(_kind: string, tokens: number, budget: InjectionWriteBudget): Promise<boolean> {
            const L = Math.max(0, Math.floor(deps.computeL(budget)));
            if (L <= 0) {
                // 预算未知（首次装配前）：不做预算闸，直接写，避免"因预算不明而不注入"
                deps.observe?.('injection-budget-unknown', { tokens });
                return true;
            }
            const T = deps.archive.estimateT();
            if (T + tokens < L) return true;
            const before = deps.service.head().archivedThrough;
            deps.archive.beforeRequest({ L, retainPercent: budget.retainPercent });
            const after = deps.service.head().archivedThrough;
            if (after <= before) {
                // 切不动（单条最新消息自身超 L 等）：记边界事件，继续写块，不重试、不跳过
                deps.observe?.('injection-over-budget', { T, L, tokens });
            }
            return true;                 // **永远 true**：禁止跳注
        },
    };
}

// ---------------------------------------------------------------------------
// 唯一写入口（D3a 骨架）
// ---------------------------------------------------------------------------

/**
 * 写入一批 draft。保证：要么写入，要么"先归档再写入"；**绝不因预算不足跳过**。
 *
 * 顺序（REQ-D3-27，错一步就前功尽弃）：
 * ① 去重（dup/dup-text 剔除；不是跳注）→ ② 单轮额度拆批 → ③ `ensureBudget`（必要时硬切）
 * → ④ `anchor = max(lastSentSeq, archivedThrough)`（用归档后的**新**水位）
 * → ⑤ `appendInjection(afterSeq = anchor)`（唯一写入口）→ ⑥ 硬上界观测 + 强制 rebase
 */
export async function writeInjectionBlocks(input: {
    deps: InjectionWriteDeps;
    drafts: readonly RawInjectionDraft[];
    /** 上次编译覆盖到的最大 seq（= `CompileStats.lastSelectedSeq`；编译输出时记录） */
    lastSentSeq: number;
    budget: InjectionWriteBudget;
    hooks?: InjectionPlanHooks;
}): Promise<InjectionWriteResult> {
    const { deps, budget } = input;
    const hooks = input.hooks ?? createInjectionPlanHooks(deps);
    const result: InjectionWriteResult = {
        blocks: 0, items: 0, tokens: 0, seqs: [], duplicates: 0, skipped: 0, archived: false,
    };
    const merged = mergeDraftsByKind(input.drafts);
    if (merged.length === 0) return result;
    const ledger = readInjectionLedger(deps.service);
    const rawCount = merged.reduce((n, draft) => n + draft.items.length, 0);
    const pending = hooks.filterByDedupe(merged);
    const keptCount = pending.reduce((n, draft) => n + draft.items.length, 0);
    result.duplicates = Math.max(0, rawCount - keptCount);
    void ledger;
    if (pending.length === 0) return result;         // 全是 dup：不写块，但不是"跳注"

    // ③ 预算闸：先归档（anchor 会因此抬高，避免新块立刻被释放）
    for (const draft of pending) {
        const before = deps.service.head().archivedThrough;
        const ok = await hooks.ensureBudget(draft.kind, draft.tokens, budget);
        if (!ok) continue;                            // 只有钩子明确放弃才不写（当前实现恒为 true）
        if (deps.service.head().archivedThrough > before) result.archived = true;
    }

    // ②b REQ-D3-28b：归档后仍在超预算 ⇒ `updated` 延后到下一轮（new/re-inject 永不延后）
    const L = Math.max(0, Math.floor(deps.computeL(budget)));
    const totalTokens = pending.reduce((n, draft) => n + draft.tokens, 0);
    const stillOver = L > 0 && deps.archive.estimateT() + totalTokens >= L;
    const writable: InjectionWriteDraft[] = [];
    for (const draft of pending) {
        if (!stillOver) {
            writable.push(draft);
            continue;
        }
        const kept = draft.verdicts
            ? draft.items.filter((_item, i) => draft.verdicts?.[i] !== 'updated')
            : draft.items;
        if (kept.length === 0) continue;               // 全是 updated：本轮不写（不是跳注）
        writable.push({ ...draft, items: kept });
    }
    if (stillOver) deps.observe?.('injection-updated-deferred', { candidate: pending.length, written: writable.length });

    // ④ + ⑤ 逐块写；anchor 每次都用**当前** head 重算（归档可能已推进水位）
    for (const draft of writable) {
        if (draft.items.length === 0) continue;
        const head = deps.service.head();
        const anchor = Math.max(
            Math.max(0, Math.floor(input.lastSentSeq) || 0),
            Math.max(0, head.archivedThrough),
        );
        const seqs = deps.service.appendInjection({
            kind: draft.kind,
            items: draft.items,
            afterSeq: anchor,
        });
        if (seqs.length === 0) continue;               // eventId 去重命中
        result.blocks += 1;
        result.items += draft.items.length;
        result.tokens += draft.tokens;
        for (const seq of seqs) result.seqs.push(seq);
    }

    // ⑥ 硬上界：只观测 + 强制一次 rebase，**绝不删块**（REQ-D3-28b 补救 2）
    const snapshot = deps.service.snapshot();
    const activeTokens = activeInjectTokens(snapshot.events, snapshot.head);
    if (activeTokens > INJECT_ACTIVE_MAX_TOKENS) {
        deps.observe?.('inject-window-violated', {
            activeTokens,
            window: INJECT_ACTIVE_WINDOW_TOKENS,
            max: INJECT_ACTIVE_MAX_TOKENS,
        });
        // rebase 后活动块随前缀关系一起"作废"（R1 只约束无 rebase 的连续轮次），
        // 因此这里不必删块：下一次编译会按新水位把它们判为已释放。
        deps.notePrefixRebase?.('inject-overflow', snapshot.head.archivedThrough);
        if (L > 0) deps.archive.beforeRequest({ L, retainPercent: budget.retainPercent });
    }

    result.skipped = 0;                                // 硬约束自检：真正的跳注数恒为 0
    return result;
}
