// v7 上下文归档控制器：双水位（A/B/C）+ 标记块 + 硬切兜底 + 会话内单飞。
//
// 设计约束：
// - 纯逻辑 + 注入依赖：不读 Config/seal/storage；LLM（摘要+facts）与草稿存取全部由 session_runtime 注入；
// - 只操作 ContextService（同层），不 import agent/session，避免运行时依赖环；
// - 触发判定用 T = 摘要注入 token + 未归档原文 token（近似，head.unarchivedTokens 增量维护）；
// - 硬切零 LLM：只推进 archivedThrough；总结完成才写滚动摘要 + facts 并归档 M；
// - 同一会话同时最多一个总结任务；硬切不取消在飞总结。
import { COMPACT_BATCH_TOKENS, resolveArchiveWatermarks, SUMMARY_MAX_CHARS } from "../utils/context_limits";
import type { ArchiveWatermarks } from "../utils/context_limits";

import {
    renderUnitsText,
    SUMMARY_TRUNCATE_MARK,
} from "./compact/compactor";
import type { ArchiveDraft, ArchiveFactsInfo } from "./compact/compactor";
import type { ConversationEvent, RecordEntry, SummaryRecord } from "./events";
import {
    activeInjectTokens,
    injectionOf,
    isInjection,
    isReleased,
    isStaleByRecords,
    releaseBoundaryOf,
    releasedInjectTokens,
    splitInjections,
} from "./injections";
import type { ContextService } from "./service";
import { summaryIsStale } from "./view/compile";
import { applyVisibility, buildRecordIndex, latestSummary } from "./view/records";
import { ConversationUnit, estimateUnitTokens, segmentUnits } from "./view/units";

/** 归档/总结的整条消息范围（块边界只落在单元边界） */
export interface ArchiveRange {
    fromSeq: number;
    toSeq: number;
    /** 范围内可见事件的 token 估算 */
    tokens: number;
    unitCount: number;
}

/** 标记块 M：从 summarizedThrough+1 起、toSeq 固定的一整段未总结内容 */
export interface ArchiveMark extends ArchiveRange {
    /** 标记时刻（毫秒） */
    markedAt: number;
}

export interface ArchiveControllerDeps {
    service: ContextService;
    estimateEventTokens: (event: ConversationEvent) => number;
    estimateTextTokens: (text: string) => number;
    /** 单批摘要输入 token 上限（默认 COMPACT_BATCH_TOKENS） */
    batchTokens?: number;
    /** 摘要文本硬上限（字符，默认 SUMMARY_MAX_CHARS） */
    summaryMaxChars?: number;
    /** 合并摘要 + facts（同一 LLM 请求）；返回 null/空摘要视为失败 */
    summarizeAndExtract?: (input: { previousSummary: string; segmentText: string }) =>
        Promise<{ summary: string; facts: unknown[] } | null>;
    applyFacts?: (facts: unknown[], info: ArchiveFactsInfo) => Promise<void>;
    loadArchiveDraft?: () => ArchiveDraft | null;
    saveArchiveDraft?: (draft: ArchiveDraft) => void;
    clearArchiveDraft?: () => void;
    newRecordId?: (info: { epoch: number; fromSeq: number; toSeq: number; at: number }) => string;
    now?: () => number;
    log?: (message: string, error?: unknown) => void;
    /** 观测钩子（#163 D9）：前缀 rebase 原因、注入预算越界等；不注入则静默 */
    observe?: (event: string, detail: Record<string, unknown>) => void;
    /**
     * 归档/总结提交成功后同步回调（#163 REQ-D7-05：`reason='archive'`）。
     *
     * **必须在 `commitArchive`/`commitSummary` 的同 tick 内调用**：前缀 rebase 的语义是
     * "水位推进了 ⇒ 旧请求体基线作废"，晚一个 tick 就会让下一轮拿旧基线判漂移。
     */
    onRebase?: (reason: string, throughSeq: number) => void;
    /** 读取前缀 rebase 记账（#163 REQ-D9-02：`status()` 展示用；不注入则报 0/空） */
    getRebaseStats?: () => { count: number; reason: string };
}

export interface ArchiveRequestInfo {
    /** L = 预算 − 固定提示词 token（由请求组装处计算） */
    L: number;
    retainPercent: number;
}

/** 注入块观测快照（#163 REQ-D9-02）：`.ai ctx` 展示当前窗口内的块及其释放状态 */
export interface ArchiveInjectionBlockStatus {
    seq: number;
    kind: string;
    afterSeq: number;
    tokens: number;
    itemCount: number;
    /** released = 已随归档释放（含被 redact/edit 判 stale 的块） */
    state: 'active' | 'released';
}

export interface ArchiveControllerStatus {
    watermarks: ArchiveWatermarks | null;
    T: number;
    archivedThrough: number;
    summarizedThrough: number;
    summarizing: boolean;
    mark: ArchiveMark | null;
    lastReason?: string;
    /** 活跃注入 token 合计（= T 的第三项；REQ-D9-02） */
    activeInjectTokens: number;
    /** 当前内存窗口内的全部注入块（含已释放，供 `.ai ctx` 展示） */
    blocks: ArchiveInjectionBlockStatus[];
    /** 前缀 rebase 次数 / 最近原因（由 session_runtime 注入读取器） */
    rebases: number;
    lastRebaseCause: string;
}

interface RequestSnapshot {
    watermarks: ArchiveWatermarks;
    T: number;
    /** 本轮硬切掉的块（Cb）；null = 未硬切 */
    cut: ArchiveRange | null;
    wasOverLimit: boolean;
}

const MAX_SUMMARY_BATCHES = 64;
const MAX_IDLE_CUTS = 64;

export class ArchiveController {
    private readonly deps: ArchiveControllerDeps;
    private readonly batchTokens: number;
    private readonly summaryMaxChars: number;
    private readonly now: () => number;
    private lastSnapshot: RequestSnapshot | null = null;
    private mark: ArchiveMark | null = null;
    private task: Promise<void> | null = null;
    /** 最近一次任务实际执行的批次数（手动 archive 返回给命令层展示） */
    private lastBatches = 0;
    /** 最近一次会话请求算出的 L / 保留强度（待机归档复用） */
    private lastWatermarks: ArchiveWatermarks | null = null;
    private lastReason: string | undefined;

    constructor(deps: ArchiveControllerDeps) {
        this.deps = deps;
        this.batchTokens = Math.max(1, Math.floor(deps.batchTokens ?? COMPACT_BATCH_TOKENS));
        this.summaryMaxChars = Math.max(1, Math.floor(deps.summaryMaxChars ?? SUMMARY_MAX_CHARS));
        this.now = deps.now ?? (() => Date.now());
    }

    /** 本轮请求开始：清掉上一轮残留快照（请求失败/旧路径回退时不会误触发总结）。 */
    beginRequest(): void {
        this.lastSnapshot = null;
    }

    /**
     * 请求编译前调用（同步）：T ≥ L 时先硬切最旧块到 T ≤ L（零 LLM），并记下被切块 Cb。
     * 有标记块时同样硬切其活动部分（在飞总结不受影响）。
     */
    beforeRequest(info: ArchiveRequestInfo): void {
        const L = Math.max(0, Math.floor(Number(info.L) || 0));
        if (L <= 0) {
            this.lastSnapshot = null;
            return;
        }
        const wm = resolveArchiveWatermarks(L, info.retainPercent);
        this.lastWatermarks = wm;
        const before = this.estimateT();
        const snapshot: RequestSnapshot = { watermarks: wm, T: before, cut: null, wasOverLimit: before >= wm.L };
        if (snapshot.wasOverLimit) {
            const cut = this.selectCut(wm.L);
            if (cut) {
                this.deps.service.commitArchive(cut.toSeq);
                snapshot.cut = cut;
                // #163 REQ-D7-05：归档是唯一 rebase 点 —— 水位推进后旧前缀基线立刻作废
                this.deps.onRebase?.('archive', cut.toSeq);
                this.persist();
            }
            snapshot.T = this.estimateT();
        }
        this.lastSnapshot = snapshot;
    }

    /**
     * 主对话请求发出后调用（同步返回，总结任务并发执行）：
     * - 硬切后 T<B → 只把 Cb 总结掉；硬切后 B≤T<L → 从最旧未总结处（含 Cb）总结到剩余 ≤A；
     * - 未硬切且 B≤T<L → 标记 M（最旧未总结段）并总结到剩余 ≤A；
     * - 其余不总结。
     * 单飞：已有总结任务时不会重复启动。
     */
    afterRequestSent(): void {
        const snapshot = this.lastSnapshot;
        this.lastSnapshot = null;
        if (!snapshot || this.task) return;
        const { A, B } = snapshot.watermarks;
        let mark: ArchiveMark | null = null;
        if (snapshot.wasOverLimit) {
            if (snapshot.cut) {
                if (snapshot.T < B) {
                    mark = this.selectMarkTo(snapshot.cut.toSeq);
                } else {
                    mark = this.selectMarkForTarget(A) ?? this.selectMarkTo(snapshot.cut.toSeq);
                }
            } else {
                // 极端：单条最新消息自身超 L，切不动；仍按剩余目标尝试总结
                mark = this.selectMarkForTarget(A);
            }
        } else if (snapshot.T >= B) {
            mark = this.selectMarkForTarget(A);
        }
        if (!mark) return;
        if (mark.toSeq <= this.deps.service.head().summarizedThrough) return;
        this.mark = mark;
        this.startSummary(mark);
    }

    /**
     * 待机路径（PR-C）：无在飞总结、T ≥ C 时零 LLM 归档最旧块直到 T ≤ L。
     *
     * #163 REQ-D3-20（AUDIT-003，P0）：**T 在循环外取基准，循环内只做增量修正**。
     * 旧实现每轮重调 `estimateT()` 两次，而 `commitArchive` 每次都 `version++`
     * ⇒ 任何按 `store.version` 做的 memo 在 64 轮里一次都命不中（每轮 = 2× 全量遍历 + 2× 排序
     * + 1× O(n) 重算 + 1× `segmentUnits`），全部同步跑在 Goja 单线程的"每条消息入库"路径上。
     *
     * 现在：`T` 只算 1 次；被释放块的 token 用 `releasedInjectTokens`（只扫注入块，O(块数)）扣减，
     * 原文部分直接取 `commitArchive` 已重算好的 `head.unarchivedTokens`。
     * @returns 是否发生了归档
     */
    onIdleAppend(): boolean {
        if (this.task || this.mark) return false;
        const wm = this.lastWatermarks;
        if (!wm) return false;
        let archived = false;
        // 第 1 次算准（此刻 T 的三个分量都是最新值）
        let T = this.estimateT();
        for (let i = 0; i < MAX_IDLE_CUTS; i++) {
            if (T < wm.C) break;
            const cut = this.selectCut(wm.L);
            if (!cut) break;
            const headBefore = this.deps.service.head();
            const before = headBefore.archivedThrough;
            this.deps.service.commitArchive(cut.toSeq);
            const headAfter = this.deps.service.head();
            const after = headAfter.archivedThrough;
            if (after <= before) break;                 // 没切动，别空转
            archived = true;
            // #163 REQ-D7-05：待机归档同样是前缀 rebase 点
            this.deps.onRebase?.('archive', after);
            // 增量修正（全程 O(块数)，不重扫全量事件）：
            // ① 被释放块的 token；② 原文部分减少量 = commitArchive 已重算的 unarchivedTokens 差
            T -= releasedInjectTokens(this.snapshotEvents(), before, after);
            T -= Math.max(0, headBefore.unarchivedTokens - headAfter.unarchivedTokens);
            T = Math.max(0, T);
            if (T <= wm.L) break;
        }
        if (archived) this.persist();
        return archived;
    }

    isSummarizing(): boolean {
        return this.task !== null;
    }

    /**
     * `context_too_long` 纠错路径：把活动上下文硬切到 `T ≤ target`（零 LLM，可能多次切）。
     *
     * 为什么必须有这个入口（#163 PR-09 行为变更）：
     * 历史层改成**全量渲染**后，`budgetTokens` 不再参与"渲染多少单元"的决策
     * （REQ-D2-10：预算只用于 `needsArchive` 观测）。因此旧实现「模型报超长 → 收紧本轮
     * 编译预算 → 直接重发」会**逐字节重发同一个请求体**，必然再次超长（纯空转）。
     * 唯一能真正缩短请求的方式是**归档**——这也正好符合 R3（归档是唯一 rebase 点）：
     * 水位前移 ⇒ 显式记一次 `archive` rebase ⇒ 下一代前缀合法重建。
     *
     * 与 `onIdleAppend` 的区别：那里的触发线是 `C`（约 1.65L）且每轮最多切到 `T ≤ L`；
     * 这里是**纠错**，目标由报错报文解析，必须切到目标以下且允许多次切。
     * @returns 是否真的推进了水位（false = 切不动：只剩一个单元 / 单条自身超目标）
     */
    forceCutBelow(targetTokens: number): boolean {
        const target = Math.max(0, Math.floor(Number(targetTokens) || 0));
        if (target <= 0) return false;
        let cut = false;
        for (let i = 0; i < MAX_IDLE_CUTS; i++) {
            if (this.estimateT() <= target) break;
            // 直接把 target 当 L 传：`selectCut` 内部已按「L − 摘要注入 − 活动注入」算目标，
            // 因此切完恰好满足 T = 剩余原文 + 摘要 + 注入 ≤ target。
            const range = this.selectCut(target);
            if (!range) break;
            const before = this.deps.service.head().archivedThrough;
            this.deps.service.commitArchive(range.toSeq);
            const after = this.deps.service.head().archivedThrough;
            if (after <= before) break;                 // 没切动，别空转
            cut = true;
            // REQ-D7-05：硬切推进水位 ⇒ 显式 rebase（否则下一轮还在用旧前缀基线）
            this.deps.onRebase?.('archive', after);
        }
        if (cut) this.persist();
        return cut;
    }

    /** 等待当前总结任务结束（测试/诊断用；无任务时立即返回） */
    async waitForSummary(): Promise<void> {
        await this.task;
    }

    status(): ArchiveControllerStatus {
        const head = this.deps.service.head();
        const snapshot = this.deps.service.snapshot();
        const boundary = releaseBoundaryOf(head);
        const rebase = this.deps.getRebaseStats?.() ?? { count: 0, reason: '' };
        return {
            watermarks: this.lastWatermarks,
            T: this.estimateT(),
            archivedThrough: head.archivedThrough,
            summarizedThrough: head.summarizedThrough,
            summarizing: this.task !== null,
            mark: this.mark,
            lastReason: this.lastReason,
            // #163 REQ-D9-02：注入块观测（只遍历内存窗口，命令偶发调用，成本可接受）
            activeInjectTokens: this.activeInjectTokens(),
            blocks: this.injectionBlockStatuses(snapshot.events, boundary),
            rebases: rebase.count,
            lastRebaseCause: rebase.reason,
        };
    }

    /** 当前窗口内注入块的观测视图（含已释放：前端据此显示"已随归档释放"） */
    private injectionBlockStatuses(
        events: readonly ConversationEvent[],
        boundary: number,
    ): ArchiveInjectionBlockStatus[] {
        const out: ArchiveInjectionBlockStatus[] = [];
        for (const event of events) {
            const meta = injectionOf(event);
            if (!meta) continue;
            out.push({
                seq: event.seq,
                kind: meta.kind,
                afterSeq: meta.afterSeq,
                tokens: meta.tokens,
                itemCount: meta.items.length,
                state: isReleased(meta, boundary) ? 'released' : 'active',
            });
        }
        return out;
    }

    // ------------------------------------------------------------------
    // 水位与范围选择
    // ------------------------------------------------------------------

    /**
     * T = 摘要注入 token + 未归档原文 token + **活跃注入 token**（与 L 同口径；不含固定提示词）。
     *
     * #163 REQ-D3-31 公式 1（AUDIT-005，P1）：第三项必须在这里就位，否则 `ensureBudget`
     * 在"注入块已写、但 unarchivedTokens 不含它"的窗口里低估 T ⇒ 注入把预算挤爆后才归档。
     * 注入 token **不落 head**（D3-13 四处隔离），所以只能每轮从事件现算。
     */
    estimateT(): number {
        const head = this.deps.service.head();
        const raw = Math.max(0, head.unarchivedTokens);
        return raw + this.summaryInjectTokens() + this.activeInjectTokens();
    }

    /**
     * `T` 的第三项：活动注入块 token 合计。
     * 走 `injections.ts` 的零分配实现（含单槽 memo；**不用 `store.version`**，见 AUDIT-003）。
     */
    private activeInjectTokens(): number {
        const snapshot = this.deps.service.snapshot();
        return activeInjectTokens(snapshot.events, snapshot.head);
    }

    private summaryInjectTokens(): number {
        const summary = this.latestValidSummary();
        if (!summary) return 0;
        const body = summary.text.length > this.summaryMaxChars
            ? summary.text.slice(0, this.summaryMaxChars)
            : summary.text;
        // +8 对齐编译层摘要块的基础开销（近似；只影响触发精度，不影响正确性）
        return this.deps.estimateTextTokens(body) + 8;
    }

    private latestValidSummary(): SummaryRecord | null {
        const index = buildRecordIndex(this.visibleRecords());
        const latest = latestSummary(index, Number.MAX_SAFE_INTEGER);
        if (!latest) return null;
        if (latest.toSeq < index.epochStartSeq) return null;
        if (summaryIsStale(index, latest)) return null;
        return latest;
    }

    private latestSummaryText(): string {
        const index = buildRecordIndex(this.visibleRecords());
        const latest = latestSummary(index, Number.MAX_SAFE_INTEGER);
        if (!latest || latest.toSeq < index.epochStartSeq) return '';
        return typeof latest.text === 'string' ? latest.text.trim() : '';
    }

    /** 硬切/待机：选最旧的一段可见单元（不切最后一个单元），使剩余原文 ≤ L − 摘要 token − 活动注入 token。 */
    private selectCut(L: number): ArchiveRange | null {
        const units = this.visibleUnits();
        if (units.length <= 1) return null;
        // #163 REQ-D3-31 公式 3：注入块不会被切掉（不是单元）⇒ 目标里必须先扣掉它们，
        // 否则切得不够狠 ⇒ 切完仍超 L。
        const targetRaw = Math.max(0, L - this.summaryInjectTokens() - this.activeInjectTokens());
        const total = units.reduce((n, u) => n + this.unitTokens(u), 0);
        if (total <= targetRaw) return null;
        let cutTokens = 0;
        let cutEnd = 0;
        for (let i = 0; i < units.length - 1; i++) {
            cutTokens += this.unitTokens(units[i]);
            cutEnd = units[i].toSeq;
            if (total - cutTokens <= targetRaw) {
                return { fromSeq: units[0].fromSeq, toSeq: cutEnd, tokens: cutTokens, unitCount: i + 1 };
            }
        }
        // 单条最新单元自身超目标：切掉除最新外的全部（允许剩余仍略高于 L）
        const last = units.length - 1;
        if (last <= 0) return null;
        return { fromSeq: units[0].fromSeq, toSeq: units[last - 1].toSeq, tokens: cutTokens, unitCount: last };
    }

    /** 总结范围：从 summarizedThrough+1 起，覆盖到「未归档原文剩余 + 活动注入 ≤ A」为止。 */
    private selectMarkForTarget(A: number): ArchiveMark | null {
        const units = this.allVisibleUnits();
        const head = this.deps.service.head();
        const start = head.summarizedThrough + 1;
        const candidates = units.filter(unit => unit.toSeq >= start);
        if (candidates.length === 0) return null;
        // #163 REQ-D3-31 公式 4：注入块不会被总结切掉（不是单元）⇒ 它们必然留在活动区，
        // 必须计入"归档后还剩多少活动内容"，否则会高估切分效果、剩余降不到 A 以下。
        const injectTokens = this.activeInjectTokens();
        // d3b G.4 下限保护：注入本身就 ≥ A 时再怎么总结也降不下来 ⇒ 直接放弃，
        // 否则每轮都返回"需要总结"⇒ 总结风暴。
        if (injectTokens >= A) {
            this.deps.observe?.('inject-exceeds-retain-target', { injectTokens, A });
            return null;
        }
        // 可见（未归档）token 的后缀和：用于判断"剩余活动上下文"
        const visibleCount = units.filter(unit => unit.toSeq > head.archivedThrough).length;
        const visibleStartIndex = units.length - visibleCount;
        let visibleRemaining = units.slice(visibleStartIndex).reduce((n, u) => n + this.unitTokens(u), 0)
            + injectTokens;
        if (visibleRemaining <= A) return null;
        let covered = 0;
        for (const unit of candidates) {
            const idx = units.indexOf(unit);
            covered += this.unitTokens(unit);
            if (idx >= visibleStartIndex) visibleRemaining -= this.unitTokens(unit);
            if (visibleRemaining <= A) {
                return {
                    fromSeq: start,
                    toSeq: unit.toSeq,
                    tokens: covered,
                    unitCount: candidates.indexOf(unit) + 1,
                    markedAt: this.now(),
                };
            }
        }
        return null;
    }

    /** 只总结到指定 seq（硬切后 T<B 的「只把 Cb 总结掉」）。 */
    private selectMarkTo(toSeq: number): ArchiveMark | null {
        const head = this.deps.service.head();
        const fromSeq = head.summarizedThrough + 1;
        if (toSeq <= head.summarizedThrough) return null;
        let tokens = 0;
        for (const event of this.snapshotEvents()) {
            if (event.seq < fromSeq || event.seq > toSeq) continue;
            // #163 REQ-D3-31 公式 5：注入块不参与总结 ⇒ 不计入总结区间 token
            if (isInjection(event)) continue;
            tokens += Math.max(0, this.deps.estimateEventTokens(event));
        }
        return { fromSeq, toSeq, tokens, unitCount: 0, markedAt: this.now() };
    }

    private visibleUnits(): ConversationUnit[] {
        const snapshot = this.deps.service.snapshot();
        const index = buildRecordIndex(snapshot.records);
        // #163 REQ-D3-15 ②：注入块永不进单元（先 split 再 segment）
        const { conversation } = splitInjections(
            applyVisibility(snapshot.events, index),
            releaseBoundaryOf(snapshot.head),
            { isStale: meta => isStaleByRecords(meta, index.redacts) },
        );
        return segmentUnits(conversation)
            .filter(unit => unit.toSeq > snapshot.head.archivedThrough);
    }

    private allVisibleUnits(): ConversationUnit[] {
        const snapshot = this.deps.service.snapshot();
        const index = buildRecordIndex(snapshot.records);
        // #163 REQ-D3-15 ③：同上；这里不按 archivedThrough 过滤（总结范围要覆盖全部）
        const { conversation } = splitInjections(
            applyVisibility(snapshot.events, index),
            releaseBoundaryOf(snapshot.head),
            { isStale: meta => isStaleByRecords(meta, index.redacts) },
        );
        return segmentUnits(conversation);
    }

    private unitTokens(unit: ConversationUnit): number {
        return Math.max(0, estimateUnitTokens(unit, this.deps.estimateEventTokens));
    }

    private snapshotEvents(): readonly ConversationEvent[] {
        return this.deps.service.snapshot().events;
    }

    private visibleRecords(): readonly RecordEntry[] {
        return this.deps.service.snapshot().records;
    }

    // ------------------------------------------------------------------
    // 总结任务（单飞）
    // ------------------------------------------------------------------

    /**
     * 手动 `.ai ctx archive`：与自动总结共用同一条单飞/分批/提交/草稿链路，
     * 目标仍是「未归档原文剩余 ≤ A」（A = L × 保留强度）。L 缺省用最近一次会话请求算出的值。
     */
    async archiveNow(info: { L?: number; retainPercent: number }): Promise<{ advanced: boolean; reason?: string; batches?: number }> {
        if (this.task) return { advanced: false, reason: 'running' };
        // 草稿重放（facts 失败/崩溃恢复）不依赖是否有新内容
        await this.replayArchiveDraft();
        const rawL = Number(info.L);
        const L = Math.max(0, Math.floor(Number.isFinite(rawL) && rawL > 0 ? rawL : (this.lastWatermarks?.L ?? 0)));
        if (L <= 0) return { advanced: false, reason: 'no-budget' };
        const wm = resolveArchiveWatermarks(L, info.retainPercent);
        this.lastWatermarks = wm;
        const mark = this.selectMarkForTarget(wm.A);
        if (!mark) return { advanced: false, reason: 'nothing-to-do' };
        this.mark = mark;
        return this.launchSummary(mark);
    }

    private startSummary(mark: ArchiveMark): void {
        void this.launchSummary(mark);
    }

    private launchSummary(mark: ArchiveMark): Promise<{ advanced: boolean; reason?: string; batches?: number }> {
        const run = (async () => {
            try {
                await this.replayArchiveDraft();
                await this.runSummary(mark);
                this.lastReason = 'ok';
                return { advanced: true as const, batches: this.lastBatches };
            } catch (error) {
                this.lastReason = error instanceof Error ? error.message : String(error);
                this.failSummary(mark, error);
                return { advanced: false as const, reason: this.lastReason, batches: 0 };
            } finally {
                this.mark = null;
                this.task = null;
            }
        })();
        this.task = run.then(() => undefined, () => undefined);
        return run;
    }

    private async runSummary(mark: ArchiveMark): Promise<void> {
        const deps = this.deps;
        const head = deps.service.head();
        const epoch = head.epoch;
        const epochStartSeq = head.epochStartSeq;
        const events = this.snapshotEvents();
        const minLoaded = events.reduce((n, e) => (e.seq < n ? e.seq : n), Number.POSITIVE_INFINITY);
        if (!Number.isFinite(minLoaded) || minLoaded > mark.fromSeq) {
            throw new Error('missing-history');
        }
        const index = buildRecordIndex(this.visibleRecords());
        // #163 REQ-D3-15 ①：注入块永不进摘要批次（否则注入正文会被写进摘要与 facts）
        const { conversation } = splitInjections(
            applyVisibility(events, index),
            releaseBoundaryOf(head),
            { isStale: meta => isStaleByRecords(meta, index.redacts) },
        );
        const allUnits = segmentUnits(conversation);
        let cursor = head.summarizedThrough;
        let summaryText = this.latestSummaryText();
        const facts: unknown[] = [];
        let batches = 0;
        this.lastBatches = 0;
        while (cursor < mark.toSeq) {
            const batch = this.nextBatch(allUnits, cursor, mark.toSeq);
            if (!batch) throw new Error('missing-history');
            batches += 1;
            if (batches > MAX_SUMMARY_BATCHES) throw new Error('too-many-batches');
            const segmentText = renderUnitsText(batch.units, index);
            const out = deps.summarizeAndExtract
                ? await deps.summarizeAndExtract({ previousSummary: summaryText, segmentText })
                : null;
            if (!out || typeof out.summary !== 'string' || !out.summary.trim()) {
                throw new Error('summary-error');
            }
            summaryText = out.summary.trim();
            if (Array.isArray(out.facts)) facts.push(...out.facts);
            cursor = batch.toSeq;
        }
        this.lastBatches = batches;

        // 提交：同 tick 内 commitSummary + commitArchive；flush 一次写 head
        const at = this.now();
        const covered = events.filter(e => e.seq >= mark.fromSeq && e.seq <= mark.toSeq);
        const fromAt = covered.length > 0 ? Math.min(...covered.map(e => Number(e.at) || 0)) : undefined;
        const toAt = covered.length > 0 ? Math.max(...covered.map(e => Number(e.at) || 0)) : undefined;
        const record: SummaryRecord = {
            kind: 'summary',
            id: deps.newRecordId
                ? deps.newRecordId({ epoch, fromSeq: epochStartSeq, toSeq: mark.toSeq, at })
                : `sum:${epoch}:${epochStartSeq}:${mark.toSeq}:${at}`,
            at,
            epoch,
            fromSeq: epochStartSeq,
            toSeq: mark.toSeq,
            text: this.truncateSummary(summaryText),
            ...(fromAt !== undefined ? { fromAt } : {}),
            ...(toAt !== undefined ? { toAt } : {}),
        };
        const remaining = this.remainingUnsummarized(mark.toSeq);
        if (facts.length > 0 && deps.applyFacts) {
            deps.saveArchiveDraft?.({
                info: { epoch, fromSeq: epochStartSeq, toSeq: mark.toSeq },
                summaryText: record.text,
                recordId: record.id,
                at,
                fromAt,
                toAt,
                unsummarizedTokens: remaining,
                facts,
                applied: false,
            });
        }
        deps.service.commitSummary(record, mark.toSeq, remaining);
        deps.service.commitArchive(mark.toSeq);
        // #163 REQ-D7-05：总结完成（summary + archive 同 tick）⇒ 前缀 rebase
        this.deps.onRebase?.('archive', mark.toSeq);
        if (facts.length > 0 && deps.applyFacts) {
            try {
                await deps.applyFacts(facts, { epoch, fromSeq: epochStartSeq, toSeq: mark.toSeq });
                deps.clearArchiveDraft?.();
            } catch (error) {
                // 摘要已提交、M 已归档；facts 失败保留草稿，下次总结入口重放（不影响归档）
                this.deps.log?.('归档 facts 写库失败，草稿保留待重放', error);
            }
        }
        await deps.service.flush();
        this.lastReason = 'ok';
    }

    /** 从 cursor+1 开始取一段单元，末条不超过 endSeq；优先单批 ≤ batchTokens。 */
    private nextBatch(units: readonly ConversationUnit[], cursor: number, endSeq: number): { units: ConversationUnit[]; toSeq: number } | null {
        // 单元可能跨过摘要边界（连续 user 会在 segmentUnits 里合并成一个单元）：
        // 取「toSeq > cursor」的单元，并裁掉 cursor 之前的整条消息，避免重复摘要/误判 missing-history。
        const candidates = units
            .filter(unit => unit.toSeq > cursor && unit.toSeq <= endSeq)
            .map(unit => this.trimUnitAfter(unit, cursor));
        if (candidates.length === 0) return null;
        const batch: ConversationUnit[] = [];
        let tokens = 0;
        for (const unit of candidates) {
            const t = this.unitTokens(unit);
            if (batch.length > 0 && tokens + t > this.batchTokens) break;
            batch.push(unit);
            tokens += t;
            if (tokens >= this.batchTokens) break;
        }
        return { units: batch, toSeq: batch[batch.length - 1].toSeq };
    }

    /** 裁掉单元内 seq ≤ cursor 的整条消息（单元边界不动，只去掉已摘要部分）。 */
    private trimUnitAfter(unit: ConversationUnit, cursor: number): ConversationUnit {
        if (unit.fromSeq > cursor) return unit;
        const events = unit.events.filter(event => Number((event as { seq?: number }).seq) > cursor);
        if (events.length === 0) return unit;
        return {
            ...unit,
            fromSeq: Number((events[0] as { seq?: number }).seq) || unit.fromSeq,
            events,
        };
    }

    /**
     * `toSeq` 之后**未摘要**的普通事件 token 合计（作为 `commitSummary` 第三实参 → `head.unsummarizedTokens`）。
     *
     * #163 D3-13 **第 4/4 处（AUDIT-001，P0）**：必须跳过注入块。注入块是正常 `SystemEvent`、
     * 有正常 `seq`，不跳过就会计入 `unsummarizedTokens`，再经 `head.ts` 的旧档兜底
     * （`unarchivedTokens = asFiniteInt(r.unarchivedTokens, head.unsummarizedTokens)`）渗入
     * `unarchivedTokens`，使 `T = unarchived + summary + activeInject` 把同一批注入 token 算两次
     * ⇒ 提前归档 ⇒ 多出无谓 rebase，抵消 #163 的全部收益。
     */
    private remainingUnsummarized(toSeq: number): number {
        let total = 0;
        for (const event of this.snapshotEvents()) {
            if (event.seq <= toSeq) continue;
            if (isInjection(event)) continue;
            total += Math.max(0, this.deps.estimateEventTokens(event));
        }
        return total;
    }

    private truncateSummary(text: string): string {
        if (text.length <= this.summaryMaxChars) return text;
        const keep = Math.max(1, this.summaryMaxChars - SUMMARY_TRUNCATE_MARK.length);
        return text.slice(0, keep) + SUMMARY_TRUNCATE_MARK;
    }

    private failSummary(mark: ArchiveMark, error: unknown): void {
        // 契约：总结报错 → 直接归档 M（无摘要、不写记忆；原文仍可检索）
        try {
            this.deps.service.commitArchive(mark.toSeq);
            // #163 REQ-D7-05：失败归档同样是 rebase 点（水位确实推进了）
            this.deps.onRebase?.('archive', mark.toSeq);
            this.persist();
        } catch { /* ignore */ }
        this.deps.log?.(`总结失败，已归档标记块（${mark.fromSeq}-${mark.toSeq}）`, error);
    }

    /** 两阶段草稿重放：崩溃/facts 失败后不重调 LLM，补提交摘要 + 补写 facts。 */
    private async replayArchiveDraft(): Promise<void> {
        const draft = this.deps.loadArchiveDraft?.();
        if (!draft) return;
        const head = this.deps.service.head();
        if (draft.info.epoch !== head.epoch) {
            this.deps.clearArchiveDraft?.();
            return;
        }
        let committed = false;
        if (draft.info.toSeq > head.summarizedThrough) {
            this.deps.service.commitSummary({
                kind: 'summary',
                id: draft.recordId,
                at: draft.at,
                epoch: draft.info.epoch,
                fromSeq: draft.info.fromSeq,
                toSeq: draft.info.toSeq,
                text: draft.summaryText,
                ...(draft.fromAt !== undefined ? { fromAt: draft.fromAt } : {}),
                ...(draft.toAt !== undefined ? { toAt: draft.toAt } : {}),
            }, draft.info.toSeq, draft.unsummarizedTokens);
            this.deps.service.commitArchive(draft.info.toSeq);
            committed = true;
        }
        // #163 REQ-D7-05：草稿重放**确实推进了水位**才是 rebase 点；
        // 已被别的路径归档过（`toSeq <= summarizedThrough`）时水位不变 ⇒ 不记 rebase。
        if (committed) this.deps.onRebase?.('archive', draft.info.toSeq);
        if (this.deps.applyFacts && !draft.applied) {
            try {
                await this.deps.applyFacts(draft.facts, draft.info);
            } catch {
                return; // 保留草稿，下次再试
            }
        }
        this.deps.clearArchiveDraft?.();
    }

    private persist(): void {
        // 归档只改 head：尽快落盘，避免重载后丢失水位（store 内部合并并发 flush）
        void this.deps.service.flush().catch(() => { /* 失败由下一次 flush 重试 */ });
    }
}

