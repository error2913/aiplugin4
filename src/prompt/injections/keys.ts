// 注入条目的三套键（#163 REQ-D3-17）：provider 侧构造口径，框架侧判定（injection_dedup.ts）。
//
// | 键 | 构造 | 例子 |
// |---|---|---|
// | `k` | `<bankId>|<kind>|<id>` | `user_QQ:123|mental_model|mm_1` |
// | `r` | `fnv1a32(normalize(text))` | 内容修订 |
// | `h` | 同 `r`（当前口径相同，保留独立字段以便将来 `r` 加版本前缀） | 文本哈希 |
//
// `normalize` 与 `src/memory/v2/prompt.ts` 的去重口径**完全一致**，否则会出现
// 「记忆渲染层已去重、注入层仍判为不同」的重复块。
import { fnv1a32 } from "../../context/injections";
import type { InjectionItem } from "../../context/injections";

/** 与 memory/v2 渲染层一致的正规化：压空白、去首尾、小写 */
export function normalizeForHash(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 内容修订号（= 文本哈希；保留为独立函数以便将来给 `r` 加版本前缀） */
export function contentRevision(text: string): number {
    return fnv1a32(normalizeForHash(text));
}

/** 文本哈希（跨 bank 同文去重） */
export function textHash(text: string): number {
    return fnv1a32(normalizeForHash(text));
}

/**
 * 构造一条注入条目：`r` 与 `h` 由 `text` 派生，**调用方不得自己填**。
 *
 * `text` 是**冻结正文**（写入后不可变）。若正文含易变内容（如当前时间），
 * 该 provider 必须用"按 k 只注入一次"的策略（见 `core:time`），否则每轮 `r` 变 ⇒ 每轮
 * 写新块 ⇒ 注入风暴。
 */
export function makeItem(
    key: string,
    text: string,
    refSeq?: number,
): InjectionItem {
    const trimmed = text.trim();
    const hash = textHash(trimmed);
    return {
        k: key,
        r: hash,
        h: hash,
        text: trimmed,
        ...(typeof refSeq === 'number' && refSeq > 0 ? { refSeq } : {}),
    };
}

/** 内容键：`<bankId>|<kind>|<id>`（memory）；其余 kind 用 provider 自己的前缀 */
export function memoryItemKey(bankId: string, kind: string, id: string): string {
    return `${bankId}|${kind}|${id}`;
}
