// 链求值（L2 纯能力）：按门顺序求值，只读输入 + 显式运行时计数，不产生任何副作用。
//
// 事务语义（方案 §5.3）：
// - "前序门通过次数" 的 counter 计数在每次求值后写回 runtime，由调用方在链结束后统一提交；
// - 只有整链通过（由调用方起轮成功）才提交计数归零；
// - delay 门只返回 suspend，由调用方（trigger/pending）负责挂起与到期续算；
// - 自主源（active_time/timer）由调度器在到点后置 sourceSatisfied=true 再求值。
import { activeSubSegmentIndex, parseTimeSegment } from "../utils/time_window";

import { GATE_META } from "./rule";
import type { Gate, GateDelta, GateEvalResult, GateInput } from "./types";

export interface GateRuntime {
    /** 门内计数（index → 计数）；调用方读它做持久化 */
    counters: Record<number, number>;
    /** 随机源（默认 Math.random） */
    random: () => number;
}

export function createGateRuntime(initial?: Record<number, number>): GateRuntime {
    return { counters: { ...(initial || {}) }, random: Math.random };
}

/** 归一化用户 id：比较时忽略平台前缀差异（`QQ:123` 与 `123` 视为同一人） */
function sameUser(a: string | undefined, b: string): boolean {
    if (!a) return false;
    const strip = (value: string): string => value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
    return a === b || strip(a) === strip(b);
}

function activeTimePass(gate: Gate, now: number): boolean {
    if (gate.type !== 'active_time') return false;
    const parsed = parseTimeSegment(`${gate.start}-${gate.end}${gate.segs && gate.segs > 1 ? `-${gate.segs}` : ''}`);
    if (!parsed.segment) return false;
    return activeSubSegmentIndex(parsed.segment, new Date(now)) >= 0;
}

/**
 * 按顺序求值一条规则的所有门。
 * 返回：
 * - pass：整链通过，deltas 为需要提交的计数变更（counter 归零）
 * - fail：某门不通过（之前的 counter 增量已写回 runtime，调用方决定是否持久化）
 * - suspend：delay 门命中，调用方必须挂起并在到期后从 index+1 继续
 */
export function evaluateGates(gates: readonly Gate[], input: GateInput, runtime: GateRuntime): GateEvalResult {
    if (gates.length === 0) return { status: 'fail', index: -1, reason: 'empty' };
    const deltas: GateDelta[] = [];
    for (let index = 0; index < gates.length; index++) {
        const gate = gates[index];
        const meta = GATE_META[gate.type];
        if (!meta) return { status: 'fail', index, reason: `unknown-gate:${gate.type}` };

        if (gate.type === 'delay') {
            return { status: 'suspend', index, delaySec: gate.delay_sec };
        }

        if (gate.type === 'regex') {
            if (!input.text) return { status: 'fail', index, reason: 'no-text' };
            let re: RegExp;
            try {
                re = new RegExp(gate.pattern, gate.flags || '');
            } catch {
                return { status: 'fail', index, reason: 'bad-regex' };
            }
            if (!re.test(input.text)) return { status: 'fail', index, reason: 'regex-miss' };
            continue;
        }

        if (gate.type === 'event') {
            if (!input.event) return { status: 'fail', index, reason: 'no-event' };
            if (input.event.eventType !== gate.on) return { status: 'fail', index, reason: 'event-type-miss' };
            // match 条件由 event 层求值后通过 input.event.matched 传入（undefined=未求值按通过）
            const matched = (input.event as { matched?: boolean }).matched;
            if (matched === false) return { status: 'fail', index, reason: 'event-condition-miss' };
            continue;
        }

        if (gate.type === 'active_time') {
            if (!activeTimePass(gate, input.now)) return { status: 'fail', index, reason: 'outside-active-time' };
            continue;
        }

        if (gate.type === 'timer') {
            if (!input.sourceSatisfied) return { status: 'fail', index, reason: 'timer-not-due' };
            continue;
        }

        if (gate.type === 'user') {
            if (!gate.ids.some(id => sameUser(input.userId, id))) return { status: 'fail', index, reason: 'user-miss' };
            if (gate.exclude && gate.exclude.some(id => sameUser(input.userId, id))) {
                return { status: 'fail', index, reason: 'user-excluded' };
            }
            continue;
        }

        if (gate.type === 'counter') {
            const base = runtime.counters[index] ?? input.state?.gates?.[index]?.count ?? 0;
            const next = base + 1;
            if (next >= gate.n) {
                runtime.counters[index] = 0;
                deltas.push({ index, counter: 0 });
            } else {
                runtime.counters[index] = next;
                return { status: 'fail', index, reason: 'counter-pending' };
            }
            continue;
        }

        if (gate.type === 'prob') {
            const roll = (input.random || runtime.random)() * 100;
            if (!(roll < gate.percent)) return { status: 'fail', index, reason: 'prob-miss' };
            continue;
        }

        return { status: 'fail', index, reason: 'unhandled-gate' };
    }
    return { status: 'pass', deltas };
}
