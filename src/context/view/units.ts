// Context v2 视图单元（纯函数）：把事件切成"可选择的原子单元"。
//
// 契约：
// - 输入必须是**已完成可见性过滤**的事件（即 `records.applyVisibility()` 的结果）；本文件不读记录，
//   否则"被 redact/supersede 的工具结果"会让调用误判为不完整组。
// - 不依赖 seal / storage / Config / utils：token 估算由调用方注入（renderer 口径必须一致）。
// - **工具组原子**：同一 `turnId` 的全部 `tool_call` 与它们的全部 `tool_result` 合成**一个**单元，
//   编译层只能整组选择/整组丢弃，不会拆成两个可选单元。
// - 不完整组（设计 gap-review X1）：
//   - call 无结果 → 仍为该 turn 的 `tool_group` 单元，`complete=false`，`missingCallIds` 列出缺结果的调用；
//     编译层负责降级为"调用未完成"文本（不产生 tool_calls，避免请求 400）。
//   - orphan result（找不到同 turn/同 group 的 call）→ 单独的 `orphan_result` 文本型单元。
// - 排序：按 `seq` 升序（`seq` 是会话内单调唯一序号）；乱序到达（例如结果先于调用落盘）不影响成组。
// - 合并：相邻（原始 seq 连续）且 `origin` 相同的 user 事件合并为一个 user 单元；assistant / event
//   各自单独成单元（v2 中 system 事件已是独立 kind，不再混进 user 单元）。
import type { ConversationEvent, ToolCallEvent, ToolResultEvent } from "../events";

/** 单元类型：user / assistant / tool_group / event，以及"孤儿工具结果"文本型单元 */
export type UnitKind = 'user' | 'assistant' | 'tool_group' | 'event' | 'orphan_result';

export interface ConversationUnit {
    kind: UnitKind;
    /** 单元覆盖的最小 seq（含） */
    fromSeq: number;
    /** 单元覆盖的最大 seq（含；工具组可能晚于后续单元到达，见文件头说明） */
    toSeq: number;
    /**
     * 渲染顺序的事件：
     * - 工具组 = 全部调用（按 seq 升序）+ 每个调用对应的结果（按 seq 升序）；
     * - 其余单元 = 按 seq 升序。
     */
    events: ConversationEvent[];
    /** 仅工具类单元可能为 false：工具组缺结果 / 孤儿结果（由编译层降级为文本） */
    complete: boolean;
    /** 工具类单元：产生这些事件的模型调用轮次 id */
    turnId?: string;
    /** 工具组：缺少结果的调用 id（编译层渲染为"调用未完成"） */
    missingCallIds?: string[];
}

/** 注入的事件 token 估算函数（renderer/能力相关，本模块不关心口径） */
export type EventTokenEstimator = (event: ConversationEvent) => number;

/** 事件 seq 是否可用于排序/成组（防御脏数据：非正/非有限值视为不可用） */
function eventSeqOf(event: ConversationEvent): number | null {
    const seq = (event as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : null;
}

function turnIdOf(event: ToolCallEvent | ToolResultEvent): string {
    const turnId = typeof event.turnId === 'string' ? event.turnId : '';
    if (turnId !== '') return turnId;
    // 迁移/脏数据兜底：缺失 turnId 的调用与结果不能互相配对，各自成组（结果会变成孤儿）。
    const seq = eventSeqOf(event);
    return `${event.kind === 'tool_call' ? '__solo_call' : '__solo_result'}:${seq === null ? 'x' : seq}`;
}

/** 单次调用与其结果的配对键：groupId 优先，缺失时退回 callId */
function groupKeyOf(event: ToolCallEvent | ToolResultEvent): string {
    const groupId = typeof event.groupId === 'string' ? event.groupId : '';
    if (groupId !== '') return groupId;
    const callId = typeof event.callId === 'string' ? event.callId : '';
    if (callId !== '') return `call:${callId}`;
    const seq = eventSeqOf(event);
    return `solo:${seq === null ? 'x' : seq}`;
}

/** 去重（同 seq 只保留首个出现者）+ 稳定按 seq 升序 */
function dedupeAndSort(events: readonly ConversationEvent[]): ConversationEvent[] {
    const seen = new Set<number>();
    const out: ConversationEvent[] = [];
    for (const event of events) {
        const seq = eventSeqOf(event);
        if (seq === null || seen.has(seq)) continue;
        seen.add(seq);
        out.push(event);
    }
    out.sort((a, b) => (eventSeqOf(a) as number) - (eventSeqOf(b) as number));
    return out;
}

function unitSeqRange(events: ConversationEvent[]): { fromSeq: number; toSeq: number } {
    let fromSeq = Number.POSITIVE_INFINITY;
    let toSeq = Number.NEGATIVE_INFINITY;
    for (const event of events) {
        const seq = eventSeqOf(event);
        if (seq === null) continue;
        if (seq < fromSeq) fromSeq = seq;
        if (seq > toSeq) toSeq = seq;
    }
    return { fromSeq, toSeq };
}

function makeUnit(kind: UnitKind, events: ConversationEvent[], complete: boolean): ConversationUnit {
    const range = unitSeqRange(events);
    return {
        kind,
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
        events,
        complete,
    };
}

function sameOrigin(a: ConversationEvent, b: ConversationEvent): boolean {
    return (a as { origin?: unknown }).origin === (b as { origin?: unknown }).origin;
}

/**
 * 事件 → 单元数组（纯函数，无副作用）。
 *
 * 使用方式（编译层）：
 * `segmentUnits(applyVisibility(events, index))`。
 * 单元顺序按 `fromSeq` 升序；工具组内部事件已按"调用→各自结果"的渲染顺序重排。
 */
export function segmentUnits(events: readonly ConversationEvent[]): ConversationUnit[] {
    const sorted = dedupeAndSort(events);

    const callsByTurn = new Map<string, ToolCallEvent[]>();
    const resultsByTurnGroup = new Map<string, Map<string, ToolResultEvent[]>>();
    const simpleUnits: ConversationUnit[] = [];

    for (const event of sorted) {
        if (event.kind === 'tool_call') {
            const turnId = turnIdOf(event);
            const calls = callsByTurn.get(turnId);
            if (calls) calls.push(event);
            else callsByTurn.set(turnId, [event]);
            continue;
        }
        if (event.kind === 'tool_result') {
            const turnId = turnIdOf(event);
            const groupKey = groupKeyOf(event);
            let groups = resultsByTurnGroup.get(turnId);
            if (!groups) {
                groups = new Map<string, ToolResultEvent[]>();
                resultsByTurnGroup.set(turnId, groups);
            }
            const list = groups.get(groupKey);
            if (list) list.push(event);
            else groups.set(groupKey, [event]);
            continue;
        }

        // user 合并：前一个单元也是 user、原始 seq 连续、origin 相同
        const last = simpleUnits[simpleUnits.length - 1];
        if (event.kind === 'user' && last && last.kind === 'user') {
            const previous = last.events[last.events.length - 1];
            const previousSeq = eventSeqOf(previous);
            const seq = eventSeqOf(event);
            if (previousSeq !== null && seq !== null && seq === previousSeq + 1 && sameOrigin(previous, event)) {
                last.events.push(event);
                last.toSeq = seq;
                continue;
            }
        }

        if (event.kind === 'user') simpleUnits.push(makeUnit('user', [event], true));
        else if (event.kind === 'assistant') simpleUnits.push(makeUnit('assistant', [event], true));
        else simpleUnits.push(makeUnit('event', [event], true));
    }

    const toolUnits: ConversationUnit[] = [];

    // 1) 每个 turn 一个 tool_group（含不完整组）
    callsByTurn.forEach((calls, turnId) => {
        const groups = resultsByTurnGroup.get(turnId) || new Map<string, ToolResultEvent[]>();
        // 渲染顺序固定为"全部调用（按 seq）→ 按调用顺序排列各自结果"，与 OpenAI/Anthropic 的
        // assistant(tool_calls) 后接若干 tool 消息一致。
        const ordered: ConversationEvent[] = calls.slice();
        const attachedResults: ToolResultEvent[][] = [];
        const missingCallIds: string[] = [];
        const consumedKeys = new Set<string>();

        for (const call of calls) {
            const key = groupKeyOf(call);
            if (consumedKeys.has(key)) {
                // 同 turn 内重复 group 键（脏数据/复用）：后续调用按"缺结果"处理，避免结果被重复消费。
                missingCallIds.push(call.callId);
                continue;
            }
            consumedKeys.add(key);
            const results = (groups.get(key) || []).slice().sort(
                (a, b) => (eventSeqOf(a) as number) - (eventSeqOf(b) as number),
            );
            if (results.length === 0) {
                missingCallIds.push(call.callId);
                continue;
            }
            attachedResults.push(results);
        }
        for (const results of attachedResults) {
            for (const result of results) ordered.push(result);
        }

        const unit = makeUnit('tool_group', ordered, missingCallIds.length === 0);
        unit.turnId = turnId;
        if (missingCallIds.length > 0) unit.missingCallIds = missingCallIds;
        toolUnits.push(unit);

        // 该 turn 内没有对应 call 的结果 → 孤儿结果单元
        groups.forEach((results, key) => {
            if (consumedKeys.has(key)) return;
            const orphanEvents = results.slice().sort(
                (a, b) => (eventSeqOf(a) as number) - (eventSeqOf(b) as number),
            );
            const orphan = makeUnit('orphan_result', orphanEvents, false);
            orphan.turnId = turnId;
            toolUnits.push(orphan);
        });
    });

    // 2) 只有结果、没有任何调用的 turn（迁移占位 turnId 等）
    resultsByTurnGroup.forEach((groups, turnId) => {
        if (callsByTurn.has(turnId)) return;
        groups.forEach((results) => {
            const orphanEvents = results.slice().sort(
                (a, b) => (eventSeqOf(a) as number) - (eventSeqOf(b) as number),
            );
            const orphan = makeUnit('orphan_result', orphanEvents, false);
            orphan.turnId = turnId;
            toolUnits.push(orphan);
        });
    });

    const units = simpleUnits.concat(toolUnits);
    units.sort((a, b) => {
        if (a.fromSeq !== b.fromSeq) return a.fromSeq - b.fromSeq;
        if (a.toSeq !== b.toSeq) return a.toSeq - b.toSeq;
        return 0;
    });
    return units;
}

/** 单个单元的 token 估算：对单元内事件逐条调用注入的估算函数 */
export function estimateUnitTokens(unit: ConversationUnit, estimateEventTokens: EventTokenEstimator): number {
    let total = 0;
    for (const event of unit.events) {
        const tokens = estimateEventTokens(event);
        if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) total += tokens;
    }
    return total;
}

/** 一组单元的 token 估算合计 */
export function estimateUnitsTokens(units: readonly ConversationUnit[], estimateEventTokens: EventTokenEstimator): number {
    let total = 0;
    for (const unit of units) total += estimateUnitTokens(unit, estimateEventTokens);
    return total;
}

/** 是否为工具原子单元（选择/摘要切点不得落在其内部） */
export function isToolUnit(unit: ConversationUnit): boolean {
    return unit.kind === 'tool_group';
}

/** 是否为文本型单元（其余四类；孤儿结果也按文本渲染） */
export function isTextualUnit(unit: ConversationUnit): boolean {
    return unit.kind !== 'tool_group';
}
