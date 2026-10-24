// Context v2 记录应用（纯函数）：把"只追加的记录"解释成视图可见性与展示内容。
//
// 契约：
// - 记录是唯一事实源的**补充层**：`Summary / Edit / Supersede / Redact / EpochReset` 只追加不改写事件。
// - 本文件不读 storage / 不依赖 seal/Config；输入是已加载的记录数组，输出是只读索引与纯函数。
// - **当前 epoch 规则**：先取最新 `EpochResetRecord`（epoch 最大；同 epoch 取 at/id 最新）。
//   - 事件：`seq < epochStartSeq` 一律不可见；
//   - `RedactRecord` / `SummaryRecord`：仅 `record.epoch === 当前 epoch` 生效（旧 epoch 记录只做审计）；
//   - `SupersedeRecord` / `EditRecord`：无 epoch 字段，按目标 seq 是否落在当前 epoch 自然失效。
// - **摘要选择**（设计 X4）：每 epoch 只认一条 rolling summary —— `toSeq` 最大且 `fromSeq <= epochStartSeq`
//   且 `toSeq <= toSeqLimit` 者；旧摘要仅审计，不参与视图。
// - **缺口判定**（INV-C）：`[epochStartSeq, firstSelectedSeq-1]` 必须被该摘要连续覆盖，否则返回缺口区间，
//   由编译层注入"更早 N 条已省略 + read_raw 指针"。
// - 未实现（留给编译层/后续任务）：X3"编辑/去重命中已摘要范围 → 摘要 stale 重算"；本索引暴露
//   `edits`/`supersededSeqByKey`/`summaries` 供其判定，但不在本文件定义策略。
import type {
    ConversationEvent,
    EditRecord,
    EpochResetRecord,
    Part,
    RecordEntry,
    RedactRecord,
    SummaryRecord,
} from "../events";

/** 只读记录索引（buildRecordIndex 的产物；字段不暴露可变引用） */
export interface RecordIndex {
    /** 当前世代号（无 EpochReset 时为 1） */
    readonly epoch: number;
    /** 当前 epoch 的起点 seq（含）；事件 seq 小于它的都不可见 */
    readonly epochStartSeq: number;
    /** 构造当前 epoch 的那条记录（无则为 null） */
    readonly epochRecord: EpochResetRecord | null;
    /** 当前 epoch 生效的 redact 区间（已规范化顺序，不保证排序） */
    readonly redacts: readonly RedactRecord[];
    /** dedupKey → 该 key 当前应保留的最大 seq（已做确定性覆盖：seq 最大者胜） */
    readonly supersededSeqByKey: ReadonlyMap<string, number>;
    /** 事件 seq → 展示 parts（同一 seq 多次编辑时取 at/id 最新者） */
    readonly edits: ReadonlyMap<number, readonly Part[]>;
    /** 当前 epoch 的 rolling summary 候选（已过滤 epoch / fromSeq<=epochStartSeq） */
    readonly summaries: readonly SummaryRecord[];
}

function finiteInt(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

/** 记录先后比较：at 升序，at 相同用 id 字典序（确定性） */
function newerRecord(a: { at: number; id: string }, b: { at: number; id: string }): boolean {
    const atA = finiteInt(a.at) ?? 0;
    const atB = finiteInt(b.at) ?? 0;
    if (atA !== atB) return atA > atB;
    return String(a.id) > String(b.id);
}

function readFromTo(record: { fromSeq?: unknown; toSeq?: unknown }): { fromSeq: number; toSeq: number } | null {
    const a = finiteInt(record.fromSeq);
    const b = finiteInt(record.toSeq);
    if (a === null || b === null || a <= 0 || b <= 0) return null;
    return a <= b ? { fromSeq: a, toSeq: b } : { fromSeq: b, toSeq: a };
}

/**
 * 由记录数组构建只读索引。
 * 输入顺序不作要求（可能来自多个记录页）；重复/乱序记录按 at+id 取最新。
 * 未知记录种类忽略（向前兼容）。
 */
export function buildRecordIndex(records: readonly RecordEntry[]): RecordIndex {
    let epochRecord: EpochResetRecord | null = null;

    // 1) 最新 epoch：epoch 号最大者；同 epoch 再按 at/id 取最后到达
    for (const record of records) {
        if (record.kind !== 'epoch') continue;
        if (finiteInt(record.epoch) === null || finiteInt(record.startSeq) === null) continue;
        if (!epochRecord) {
            epochRecord = record;
            continue;
        }
        const nextEpoch = finiteInt(record.epoch) as number;
        const currentEpoch = finiteInt(epochRecord.epoch) as number;
        if (nextEpoch > currentEpoch || (nextEpoch === currentEpoch && newerRecord(record, epochRecord))) {
            epochRecord = record;
        }
    }
    const epoch = epochRecord ? (finiteInt(epochRecord.epoch) as number) : 1;
    const rawStart = epochRecord ? (finiteInt(epochRecord.startSeq) as number) : 1;
    const epochStartSeq = Math.max(1, rawStart);

    // 2) 当前 epoch 的 redact / summary；全量的 supersede / edit
    const redacts: RedactRecord[] = [];
    const summaries: SummaryRecord[] = [];
    const supersededSeqByKey = new Map<string, number>();
    const editRecords = new Map<number, EditRecord>();

    for (const record of records) {
        if (record.kind === 'redact') {
            if (finiteInt(record.epoch) !== epoch) continue;
            const range = readFromTo(record);
            if (!range || range.toSeq < epochStartSeq) continue;
            redacts.push({
                ...record,
                fromSeq: Math.max(range.fromSeq, epochStartSeq),
                toSeq: range.toSeq,
            });
            continue;
        }
        if (record.kind === 'summary') {
            if (finiteInt(record.epoch) !== epoch) continue;
            const range = readFromTo(record);
            if (!range) continue;
            if (range.fromSeq > epochStartSeq) continue;
            summaries.push({ ...record, fromSeq: range.fromSeq, toSeq: range.toSeq });
            continue;
        }
        if (record.kind === 'supersede') {
            const seq = finiteInt(record.seq);
            const key = typeof record.dedupKey === 'string' ? record.dedupKey : '';
            if (seq === null || seq <= 0 || key === '') continue;
            const current = supersededSeqByKey.get(key);
            if (current === undefined || seq > current) supersededSeqByKey.set(key, seq);
            continue;
        }
        if (record.kind === 'edit') {
            const seq = finiteInt(record.seq);
            if (seq === null || seq <= 0 || !Array.isArray(record.parts)) continue;
            const previous = editRecords.get(seq);
            // 同一 seq 多条编辑：取最后到达（at/id 最新）的一条，避免输入顺序依赖。
            if (!previous || newerRecord(record, previous)) editRecords.set(seq, record);
            continue;
        }
    }

    const edits = new Map<number, readonly Part[]>();
    editRecords.forEach((record, seq) => {
        edits.set(seq, record.parts.slice());
    });

    return {
        epoch,
        epochStartSeq,
        epochRecord,
        redacts,
        supersededSeqByKey,
        edits,
        summaries,
    };
}

/**
 * 事件用于 supersede 匹配的去重键：
 * - system 事件的 eventId 约定为 `e:<dedupKey>`（见 events.ts:systemEventId），取冒号后的原 dedupKey；
 * - 其余事件直接用稳定 eventId（user=msgId、assistant=msgId、tool=groupId+callId）；
 * - 无 eventId 的脏数据退回 `seq:<n>`（不会被任何 supersede 命中）。
 */
export function dedupKeyOfEvent(event: ConversationEvent): string {
    const eventId = typeof (event as { eventId?: unknown }).eventId === 'string'
        ? (event as { eventId: string }).eventId
        : '';
    if (eventId === '') {
        const seq = finiteInt((event as { seq?: unknown }).seq);
        return `seq:${seq === null ? 'x' : seq}`;
    }
    if (event.kind === 'event' && eventId.indexOf('e:') === 0) return eventId.slice(2);
    return eventId;
}

/** 是否被 redact：按 seq 区间 + 目标类别命中；target=assistant 同时隐藏 tool 组（避免孤儿结果） */
export function isRedacted(event: ConversationEvent, index: RecordIndex): boolean {
    const seq = finiteInt((event as { seq?: unknown }).seq);
    if (seq === null) return false;
    for (const redact of index.redacts) {
        if (seq < redact.fromSeq || seq > redact.toSeq) continue;
        if (redact.target === 'all') return true;
        if (redact.target === 'user') {
            // 机器人自录消息（origin:'self'）属于 assistant 侧，不随 hide user 隐藏
            if (event.kind === 'user' && (event as { origin?: unknown }).origin !== 'self') return true;
            continue;
        }
        // target=assistant：assistant 文本 + 其工具调用/结果 + 机器人自录 user 消息
        if (event.kind === 'assistant' || event.kind === 'tool_call' || event.kind === 'tool_result') return true;
        if (event.kind === 'user' && (event as { origin?: unknown }).origin === 'self') return true;
    }
    return false;
}

/** 是否被 supersede（同 dedupKey 只保留最大 seq；更早的副本不可见） */
export function isSuperseded(event: ConversationEvent, index: RecordIndex): boolean {
    const seq = finiteInt((event as { seq?: unknown }).seq);
    if (seq === null) return false;
    const latest = index.supersededSeqByKey.get(dedupKeyOfEvent(event));
    return latest !== undefined && seq < latest;
}

/** 综合可见性：当前 epoch 内 + 未被 redact + 未被 supersede */
export function isVisible(event: ConversationEvent, index: RecordIndex): boolean {
    const seq = finiteInt((event as { seq?: unknown }).seq);
    if (seq === null || seq < index.epochStartSeq) return false;
    return !isRedacted(event, index) && !isSuperseded(event, index);
}

/** 过滤出模型可见事件（保持输入顺序；不排序、不改原数组） */
export function applyVisibility(events: readonly ConversationEvent[], index: RecordIndex): ConversationEvent[] {
    const out: ConversationEvent[] = [];
    for (const event of events) {
        if (isVisible(event, index)) out.push(event);
    }
    return out;
}

/**
 * 事件在视图中的展示 parts：
 * - 有 EditRecord → 返回编辑后的 parts（副本，调用方可安全渲染/修改）；
 * - 无编辑 → 返回事件自带 parts 的副本；
 * - `tool_call` 没有 parts（结构化调用不进展示文本）→ 返回空数组。
 */
export function applyEdit(event: ConversationEvent, index: RecordIndex): Part[] {
    const seq = finiteInt((event as { seq?: unknown }).seq);
    if (seq !== null) {
        const edited = index.edits.get(seq);
        if (edited) return edited.slice();
    }
    const parts = (event as { parts?: unknown }).parts;
    return Array.isArray(parts) ? (parts as Part[]).slice() : [];
}

/**
 * 选当前 epoch 的最新 rolling summary：`toSeq <= toSeqLimit` 中 `toSeq` 最大者；
 * 同 toSeq 按 at/id 最新（确定性）。候选已按 epoch + fromSeq<=epochStartSeq 过滤。
 */
export function latestSummary(index: RecordIndex, toSeqLimit: number): SummaryRecord | null {
    const limit = finiteInt(toSeqLimit);
    if (limit === null) return null;
    let best: SummaryRecord | null = null;
    for (const summary of index.summaries) {
        if (summary.toSeq > limit) continue;
        if (!best || summary.toSeq > best.toSeq) {
            best = summary;
            continue;
        }
        if (summary.toSeq === best.toSeq && newerRecord(summary, best)) best = summary;
    }
    return best;
}

/** 摘要缺口判定结果（`uncovered*` 非空即 INV-C 缺口，编译层须显式提示） */
export interface SummaryGap {
    /** 是否存在未被摘要覆盖的省略区间 */
    hasGap: boolean;
    /** 覆盖到的最深摘要（即使无缺口也返回，供编译层注入摘要正文） */
    summary: SummaryRecord | null;
    /** 被省略（未选中）的区间：`[skippedFromSeq, skippedToSeq]`；无省略时 from > to */
    skippedFromSeq: number;
    skippedToSeq: number;
    /** 已被摘要连续覆盖到的 seq（含） */
    coveredThroughSeq: number;
    /** 缺口起始 seq（无缺口为 null） */
    uncoveredFromSeq: number | null;
    /** 缺口结束 seq（无缺口为 null） */
    uncoveredToSeq: number | null;
}

/**
 * 判断"最早被选中单元之前"是否存在摘要缺口。
 * @param firstSelectedSeq 编译层选中的最早可见单元的起始 seq（其前的事件都会被省略）
 */
export function summaryGap(index: RecordIndex, firstSelectedSeq: number): SummaryGap {
    const first = finiteInt(firstSelectedSeq);
    const skippedFromSeq = index.epochStartSeq;
    const skippedToSeq = (first === null ? index.epochStartSeq : first) - 1;
    if (skippedToSeq < skippedFromSeq) {
        return {
            hasGap: false,
            summary: null,
            skippedFromSeq,
            skippedToSeq,
            coveredThroughSeq: skippedFromSeq - 1,
            uncoveredFromSeq: null,
            uncoveredToSeq: null,
        };
    }
    const summary = latestSummary(index, skippedToSeq);
    const coveredThroughSeq = summary
        ? Math.max(skippedFromSeq - 1, Math.min(skippedToSeq, summary.toSeq))
        : skippedFromSeq - 1;
    const hasGap = coveredThroughSeq < skippedToSeq;
    return {
        hasGap,
        summary,
        skippedFromSeq,
        skippedToSeq,
        coveredThroughSeq,
        uncoveredFromSeq: hasGap ? coveredThroughSeq + 1 : null,
        uncoveredToSeq: hasGap ? skippedToSeq : null,
    };
}
