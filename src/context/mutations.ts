// Context v2 的编辑/去重变更原语：只追加记录，不改事件（context_edit_* 等工具后续调用）。
import type { Part, RecordEntry } from "./events";
import type { ContextStore } from "./store";
import { applyEdit, buildRecordIndex } from "./view/records";

function nowSec(now?: number): number {
    return Math.floor(now ?? Date.now() / 1000);
}

/** 找到当前可见的事件（按 seq） */
function findEvent(store: ContextStore, seq: number) {
    return store.snapshot().events.find(event => event.seq === seq) ?? null;
}

/**
 * 整体替换某条事件的展示 parts（EditRecord）。只影响视图/召回，不改原文。
 * 返回是否找到事件。
 */
export function editEventParts(store: ContextStore, seq: number, parts: Part[], now?: number): boolean {
    if (!findEvent(store, seq)) return false;
    const at = nowSec(now);
    const record: RecordEntry = {
        kind: 'edit',
        id: `edit:${seq}:${at}`,
        at,
        seq,
        parts: parts.map(part => ({ ...part })),
    };
    store.appendRecord(record);
    return true;
}

/**
 * 文本替换（等价旧 context_edit_replace 的正文替换）：只改 text part。
 * 返回替换次数（0 表示没命中/不存在）。
 */
export function replaceEventText(
    store: ContextStore,
    seq: number,
    find: string,
    replacement: string,
    options: { all?: boolean; now?: number } = {},
): number {
    const event = findEvent(store, seq);
    if (!event || !find) return 0;
    const index = buildRecordIndex(store.snapshot().records);
    const current = applyEdit(event, index);
    let count = 0;
    const next: Part[] = current.map(part => {
        if (part.type !== 'text') return { ...part };
        if (options.all) {
            const pieces = part.text.split(find);
            if (pieces.length > 1) {
                count += pieces.length - 1;
                return { type: 'text', text: pieces.join(replacement) };
            }
            return { ...part };
        }
        const at = part.text.indexOf(find);
        if (at < 0) return { ...part };
        count++;
        return { type: 'text', text: part.text.slice(0, at) + replacement + part.text.slice(at + find.length) };
    });
    if (count > 0) editEventParts(store, seq, next, options.now);
    return count;
}

/**
 * 去重"后到覆盖先到"：同 dedupKey 只保留 seq 最大者（SupersedeRecord）。
 * 用于事件去重/同 msgId 覆盖；不影响被覆盖事件原文。
 */
export function supersedeEvent(store: ContextStore, dedupKey: string, seq: number, now?: number): void {
    if (!dedupKey) return;
    const at = nowSec(now);
    store.appendRecord({
        kind: 'supersede',
        id: `supersede:${dedupKey}:${seq}:${at}`,
        at,
        dedupKey,
        seq,
    });
}
