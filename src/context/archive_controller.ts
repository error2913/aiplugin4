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
}

export interface ArchiveRequestInfo {
    /** L = 预算 − 固定提示词 token（由请求组装处计算） */
    L: number;
    retainPercent: number;
}

export interface ArchiveControllerStatus {
    watermarks: ArchiveWatermarks | null;
    T: number;
    archivedThrough: number;
    summarizedThrough: number;
    summarizing: boolean;
    mark: ArchiveMark | null;
    lastReason?: string;
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
     * @returns 是否发生了归档
     */
    onIdleAppend(): boolean {
        if (this.task || this.mark) return false;
        const wm = this.lastWatermarks;
        if (!wm) return false;
        let archived = false;
        for (let i = 0; i < MAX_IDLE_CUTS; i++) {
            const T = this.estimateT();
            if (T < wm.C) break;
            const cut = this.selectCut(wm.L);
            if (!cut) break;
            this.deps.service.commitArchive(cut.toSeq);
            archived = true;
            if (this.estimateT() <= wm.L) break;
        }
        if (archived) this.persist();
        return archived;
    }

    isSummarizing(): boolean {
        return this.task !== null;
    }

    /** 等待当前总结任务结束（测试/诊断用；无任务时立即返回） */
    async waitForSummary(): Promise<void> {
        await this.task;
    }

    status(): ArchiveControllerStatus {
        const head = this.deps.service.head();
        return {
            watermarks: this.lastWatermarks,
            T: this.estimateT(),
            archivedThrough: head.archivedThrough,
            summarizedThrough: head.summarizedThrough,
            summarizing: this.task !== null,
            mark: this.mark,
            lastReason: this.lastReason,
        };
    }

    // ------------------------------------------------------------------
    // 水位与范围选择
    // ------------------------------------------------------------------

    /** T = 摘要注入 token + 未归档原文 token（与 L 同口径的近似值；不含固定提示词）。 */
    estimateT(): number {
        const raw = Math.max(0, this.deps.service.head().unarchivedTokens);
        return raw + this.summaryInjectTokens();
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

    /** 硬切/待机：选最旧的一段可见单元（不切最后一个单元），使剩余原文 ≤ L − 摘要 token。 */
    private selectCut(L: number): ArchiveRange | null {
        const units = this.visibleUnits();
        if (units.length <= 1) return null;
        const targetRaw = Math.max(0, L - this.summaryInjectTokens());
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

    /** 总结范围：从 summarizedThrough+1 起，覆盖到「未归档原文剩余 ≤ A」为止。 */
    private selectMarkForTarget(A: number): ArchiveMark | null {
        const units = this.allVisibleUnits();
        const head = this.deps.service.head();
        const start = head.summarizedThrough + 1;
        const candidates = units.filter(unit => unit.toSeq >= start);
        if (candidates.length === 0) return null;
        // 可见（未归档）token 的后缀和：用于判断"剩余活动上下文"
        const visibleCount = units.filter(unit => unit.toSeq > head.archivedThrough).length;
        const visibleStartIndex = units.length - visibleCount;
        let visibleRemaining = units.slice(visibleStartIndex).reduce((n, u) => n + this.unitTokens(u), 0);
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
            if (event.seq >= fromSeq && event.seq <= toSeq) tokens += Math.max(0, this.deps.estimateEventTokens(event));
        }
        return { fromSeq, toSeq, tokens, unitCount: 0, markedAt: this.now() };
    }

    private visibleUnits(): ConversationUnit[] {
        const snapshot = this.deps.service.snapshot();
        const index = buildRecordIndex(snapshot.records);
        return segmentUnits(applyVisibility(snapshot.events, index))
            .filter(unit => unit.toSeq > snapshot.head.archivedThrough);
    }

    private allVisibleUnits(): ConversationUnit[] {
        const snapshot = this.deps.service.snapshot();
        const index = buildRecordIndex(snapshot.records);
        return segmentUnits(applyVisibility(snapshot.events, index));
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
        const allUnits = segmentUnits(applyVisibility(events, index));
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

    private remainingUnsummarized(toSeq: number): number {
        let total = 0;
        for (const event of this.snapshotEvents()) {
            if (event.seq > toSeq) total += Math.max(0, this.deps.estimateEventTokens(event));
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
        }
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

