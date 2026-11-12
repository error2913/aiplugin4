// `kind:'time'` 内置注入 provider（#163 D4-02/03/04）。
//
// 语义三件套（不可改）：
// 1. 阈值：距上次**真正回复**超过 1 小时才注入（基准是账本里最后一条 assistant 事件，不是 run 开始时刻）；
// 2. 去重键：`time:<上次回复的 seq>`（同一基准不重复注入 → 稳态零注入）；
// 3. 正文：写入时**冻结**的绝对时间（唯一允许绝对时间的注入块，REQ-D4-07）。
//
// 为什么必须由 provider 自己按 `k` 拒发（不能只靠框架的 `k + r` 判定）：
// 正文含"注入时刻的绝对时间"⇒ 同一 `k` 下每轮 `r` 都不同 ⇒ 框架会判 `updated` ⇒ 每轮写新块
// （注入风暴）。所以 time 属于"按 k 只注入一次"的类型：见到 `k ∈ activeKeys` 直接返回空。
import type { InjectionItem } from "../../context/injections";
import { fmtDateTz } from "../../utils/string";
import { TIME_INJECTION } from "../texts/en";
import type { InjectionContext, InjectionProvider } from "../types";

import { makeItem } from "./keys";

/** 距上次回复超过 1 小时才注入（REQ-D4-03） */
export const TIME_INJECT_GAP_SEC = 3600;

/**
 * 构造 time provider。
 *
 * `now` 是**起轮时冻结的毫秒值**（`InjectionContext.now`），不是函数：
 * 若 provider 内每次现取 `Date.now()`，同一快照两次 `build()` 会得到不同正文 ⇒ 破坏 R2。
 */
export function createTimeProvider(): InjectionProvider {
    return {
        name: 'core:time',
        kind: 'time',
        // 同 anchor 三类块渲染顺序 time → memory → mcp（与 injections.ts 的 KIND_RANK 一致）
        order: 100,
        // 缺时间不算致命：provider 抛错/不可用时不能让整轮请求失败
        optional: true,
        build(c: InjectionContext): InjectionItem[] {
            const lastAt = c.lastReplyAt > 0 ? c.lastReplyAt : 0;
            const gapMs = c.now - lastAt;
            if (gapMs <= TIME_INJECT_GAP_SEC * 1000) return [];
            const key = `time:${c.lastReplySeq > 0 ? c.lastReplySeq : 0}`;
            if (c.listActiveKeys().has(key)) return [];
            // 绝对时间：写入时冻结（这是唯一例外，见 REQ-D4-07）
            const absolute = fmtDateTz(Math.floor(c.now / 1000));
            return [makeItem(key, TIME_INJECTION(absolute), c.lastReplySeq)];
        },
    };
}
