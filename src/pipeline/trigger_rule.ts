// 规则链编排（L4）：把触发域纯能力（eval/store/pending）接到会话与起轮上。
//
// 唯一编排点（方案 §5.3/§5.5）：
// - 选规则（enabled/过期/次数/作用域）→ 按门求值 → delay 挂起或整链通过；
// - 只有 wake 返回 fired 才提交 fired++/lastFiredAt；counter 计数增量随求值持久化；
// - 消息路径用认领表保证一条消息最多一个触发对象（链规则之间、链与判定之间）；
// - 自主源（timer 到点）经 runChain({ruleId, sourceSatisfied:true}) 复用同一求值/起轮路径。
import { matchEventTrigger } from "../event/trigger";
import type { EventView } from "../event/trigger";
import { logger } from "../logger";
import type { Session } from "../session/session";
import type { ChatOutcome } from "../session/session";
import { createGateRuntime, evaluateGates, GATE_META, PendingDelays, pickWakePrompt, ruleMatchesScope, ruleSkipReason, ruleWakePrompts } from "../trigger";
import type { Gate, GateInput, RuleStateShard, TriggerRule } from "../trigger";
import { getRuleStore, pendingDelays, resetTriggerRuntimeForTest } from "../trigger/runtime";
import { applyLastMessageRef } from "../utils/seal";

import { claimTable, messageClaimKey } from "./claim_table";
import { wakeSession } from "./wake";


/** 规则 timer 源门缺省唤醒文本（方案：prompt 优先 → 门内 prompts → 内置默认） */
export const DEFAULT_RULE_WAKE_TEXT = 'The trigger rule matched. Say something natural and brief.';

export interface ChainInput {
    session: Session;
    ctx: seal.MsgContext;
    msg: seal.Message;
    /** 当前时间（毫秒；测试注入） */
    now?: number;
    /** 已格式化文本（正则门用） */
    text?: string;
    /** 事件源（事件入口） */
    event?: { eventType: string; matched?: boolean; view?: EventView };
    userId?: string;
    platform?: string;
    /** 自主源：只求值指定规则，timer 门直接放行 */
    ruleId?: string;
    sourceSatisfied?: boolean;
    /** 消息认领身份（通常是 rawId）；不传=不认领（事件/自主源） */
    claimIdentity?: string;
    /** 随机源（prob 门） */
    random?: () => number;
    /** 只求值不起轮：返回 parked + wakeText，由调用方挂起（忙时消息/事件入口用） */
    deferWake?: boolean;
    /** 起轮不 await：返回 detached，fired/计数记账在异步回调里完成（事件入口防阻塞 ob11 分发） */
    detachedWake?: boolean;
    /** delay 到期遇忙的内部重试次数（不持久化） */
    pendingRetry?: number;
}

export type ChainStatus = 'fired' | 'suspended' | 'claimed' | 'no-match' | 'parked' | 'detached' | ChatOutcome;

export interface ChainResult {
    status: ChainStatus;
    ruleId?: string;
    /** status='parked' 时给调用方挂起用的唤醒文本（恢复时经 wake 写入） */
    wakeText?: string;
}

/** 规则级跳过原因再导出：定时器续期与链求值共用同一实现（供 trigger_timer_impl 使用） */
export { ruleSkipReason } from "../trigger";

/** 规则库/挂起槽单例来自 L2 runtime（工具/命令/编排共享；L4 只再导出保持调用点不变） */
export { getRuleStore } from "../trigger/runtime";

/** delay 挂起槽（本编排使用的 payload 形状；runtime 单例为 unknown 泛型） */
const pending = pendingDelays as PendingDelays<{ session: Session; ctx: seal.MsgContext; msg: seal.Message }>;
export function getPendingDelays() {
    return pending;
}

/** 仅测试：重置单例（规则库 + 挂起槽） */
export function resetTriggerRuleStateForTest(): void {
    resetTriggerRuntimeForTest();
}

function stateOf(rule: TriggerRule, sessionId: string): RuleStateShard {
    const map = getRuleStore().readState(rule.id);
    return map[sessionId] || { fired: 0, lastFiredAt: 0, gates: {} };
}

/**
 * 把运行时 counter 合并进 shard 并落盘：
 * - 无 counter 变化时直接跳过（不产生一次全表读+写）；
 * - 有变化时必须写穿（计数器归零/递增是下一次求值的输入，节流会导致同一进程内读到旧值而多触发）。
 */
function persistCounters(rule: TriggerRule, sessionId: string, shard: RuleStateShard, counters: Record<number, number>): void {
    if (Object.keys(counters).length === 0) return;
    const store = getRuleStore();
    const map = store.readState(rule.id);
    const fresh = map[sessionId] || shard;
    const gates = { ...(fresh.gates || {}) };
    for (const [index, count] of Object.entries(counters)) {
        if (count > 0) gates[index] = { count, lastPassAt: Date.now() };
        else delete gates[index];
    }
    map[sessionId] = { ...fresh, gates };
    store.writeState(rule.id, map, true);
}

function persistFired(rule: TriggerRule, sessionId: string, shard: RuleStateShard, now: number): void {
    const store = getRuleStore();
    const map = store.readState(rule.id);
    const fresh = map[sessionId] || shard;
    map[sessionId] = { fired: fresh.fired + 1, lastFiredAt: now, gates: {} };
    store.writeState(rule.id, map, true);
}

function buildGateInput(input: ChainInput, shard: RuleStateShard): GateInput {
    return {
        sessionId: input.session.sessionId,
        now: input.now ?? Date.now(),
        text: input.text,
        event: input.event ? { sid: input.session.sessionId, ...input.event } : undefined,
        userId: input.userId,
        platform: input.platform,
        random: input.random,
        state: shard,
        sourceSatisfied: input.sourceSatisfied,
    };
}

/** 门事件条件是否命中（复用 v1 条件匹配；空 match 视为命中） */
function gateEventMatches(view: EventView, gate: Gate): boolean {
    if (gate.type !== 'event') return true;
    if (!gate.match || gate.match.length === 0) return true;
    const synthetic = [{
        on: gate.on,
        match: gate.match as never[],
        scope: { platforms: [], sessions: [], exclude: [] },
    }];
    return matchEventTrigger(synthetic as never, view) !== null;
}

/** 起轮结果记账：fired 才提交 fired++/认领；其它结果只保留计数增量（且不再写提示） */
function settleOutcome(rule: TriggerRule, input: ChainInput, shard: RuleStateShard, counters: Record<number, number>, outcome: ChatOutcome): void {
    if (outcome === 'fired') {
        persistFired(rule, input.session.sessionId, shard, input.now ?? Date.now());
        if (input.claimIdentity) {
            claimTable.claim(input.session.sessionId, messageClaimKey(input.session.sessionId, input.claimIdentity), 'chain');
        }
        return;
    }
    // 未真正起轮：计数保留（已按求值增量落盘），不记 fired
    persistCounters(rule, input.session.sessionId, shard, counters);
}

async function fireRule(rule: TriggerRule, input: ChainInput, shard: RuleStateShard, counters: Record<number, number>): Promise<ChainResult> {
    const wakeText = pickWakePrompt(ruleWakePrompts(rule)) || DEFAULT_RULE_WAKE_TEXT;
    // 忙时/事件入口：只求值不起轮，由调用方挂起或异步起轮（避免 await 整轮 AI）
    if (input.deferWake) {
        return { status: 'parked', ruleId: rule.id, wakeText };
    }
    const wake = wakeSession(input.session, input.ctx, input.msg, {
        kind: 'rule',
        wakeText,
        reason: '触发规则',
        raw: { ruleId: rule.id },
    });
    if (input.detachedWake) {
        void wake.then(outcome => settleOutcome(rule, input, shard, counters, outcome)).catch((e: unknown) => {
            logger.withTag('trigger-rule').warning(`规则起轮记账失败 ${rule.id}: ${e instanceof Error ? e.message : String(e)}`);
        });
        return { status: 'detached', ruleId: rule.id };
    }
    const outcome = await wake;
    settleOutcome(rule, input, shard, counters, outcome);
    return { status: outcome, ruleId: rule.id };
}

async function evaluateRule(rule: TriggerRule, input: ChainInput, startIndex = 0): Promise<ChainResult> {
    const sid = input.session.sessionId;
    const shard = stateOf(rule, sid);
    const counters: Record<number, number> = {};
    for (const [index, gateState] of Object.entries(shard.gates || {})) counters[Number(index)] = gateState.count;
    const runtime = createGateRuntime(counters);
    const gateInput = buildGateInput(input, shard);
    // 事件条件：先按 v1 条件匹配，不命中直接跳过（源门 event）
    if (input.event && rule.gates[0] && rule.gates[0].type === 'event') {
        const view = (input.event as unknown as { view?: EventView }).view;
        if (view && !gateEventMatches(view, rule.gates[0])) return { status: 'no-match' };
    }
    const result = evaluateGates(rule.gates, gateInput, runtime, startIndex);
    if (result.status === 'suspend') {
        // 链 delay：同规则同会话只留一个挂起槽；到期从 index+1 续算（跳过已过的门）
        pending.arm(`${rule.id}@${sid}`, {
            ruleId: rule.id,
            sessionId: sid,
            gateIndex: result.index,
            payload: { session: input.session, ctx: input.ctx, msg: input.msg },
        }, result.delaySec, () => {
            evaluateRuleFrom(rule.id, input.session, input.ctx, input.msg, result.index + 1, input).catch((e: unknown) => {
                logger.withTag('trigger-rule').warning(`delay 续算失败 ${rule.id}: ${e instanceof Error ? e.message : String(e)}`);
            });
        });
        persistCounters(rule, sid, shard, runtime.counters);
        return { status: 'suspended', ruleId: rule.id };
    }
    if (result.status === 'fail') {
        persistCounters(rule, sid, shard, runtime.counters);
        return { status: 'no-match', ruleId: rule.id };
    }
    return fireRule(rule, input, shard, runtime.counters);
}

/** delay 到期续算：规则可能已被删除/停用/过期/用尽；会话忙时小退避重试 */
async function evaluateRuleFrom(ruleId: string, session: Session, ctx: seal.MsgContext, msg: seal.Message, startIndex: number, original: ChainInput): Promise<void> {
    const rule = getRuleStore().getById(ruleId);
    if (!rule || !rule.enabled) return;
    const sid = session.sessionId;
    // 与消息/自主入口同口径复核：delay 挂起期间规则可能被改 scope / 过期 / 次数用尽
    if (!ruleMatchesScope(rule, { sessionId: sid, platform: original.platform })) return;
    const shard = stateOf(rule, sid);
    if (ruleSkipReason(rule, shard.fired, Date.now())) return;
    applyLastMessageRef(session, ctx, msg);
    const result = await evaluateRule(rule, { ...original, session, ctx, msg }, startIndex);
    if (result.status !== 'deferred') return;
    // 到期恰逢会话忙：3s 退避重挂，最多 5 次；避免"静默 N 秒后说一句"被悄悄丢掉
    const retry = (original.pendingRetry ?? 0) + 1;
    if (retry > 5) {
        logger.withTag('trigger-rule').warning(`delay 续算连续遇忙，已放弃 ${rule.id}@${sid}`);
        return;
    }
    pending.arm(`${rule.id}@${sid}`, {
        ruleId: rule.id,
        sessionId: sid,
        gateIndex: Math.max(0, startIndex - 1),
        payload: { session, ctx, msg },
    }, 3, () => {
        evaluateRuleFrom(rule.id, session, ctx, msg, startIndex, { ...original, pendingRetry: retry }).catch((e: unknown) => {
            logger.withTag('trigger-rule').warning(`delay 重试失败 ${rule.id}: ${e instanceof Error ? e.message : String(e)}`);
        });
    });
    logger.withTag('trigger-rule').warning(`delay 续算遇忙，3s 后重试（${retry}/5）${rule.id}@${sid}`);
}

/**
 * 消息/事件路径求值全部链规则（按存储顺序=优先级）。
 * 命中并 fired 后停止；suspend 后停止（同一条消息只挂一条链）。
 */
export async function runChain(input: ChainInput): Promise<ChainResult> {
    const sid = input.session.sessionId;
    if (input.claimIdentity && claimTable.hasClaim(sid, messageClaimKey(sid, input.claimIdentity))) {
        return { status: 'claimed' };
    }
    const now = input.now ?? Date.now();
    const rules = getRuleStore().list();
    for (const rule of rules) {
        if (input.ruleId && rule.id !== input.ruleId) continue;
        if (!ruleMatchesScope(rule, { sessionId: sid, platform: input.platform })) continue;
        const shard = stateOf(rule, sid);
        if (ruleSkipReason(rule, shard.fired, now)) continue;
        // 源门类型必须与入口匹配：消息入口只跑 regex/event/active_time 源；自主入口跑 timer / active_time 源
        const source = rule.gates[0];
        if (!source) continue;
        if (input.sourceSatisfied) {
            if (source.type !== 'timer' && source.type !== 'active_time') continue;
        } else if (source.type === 'timer') {
            continue;
        } else if (source.type === 'event' && !input.event) {
            continue;
        } else if (source.type === 'regex' && input.text === undefined) {
            continue;
        }
        const result = await evaluateRule(rule, input);
        if (result.status === 'fired' || result.status === 'suspended' || result.status === 'parked' || result.status === 'detached') return result;
        // quota：用量限制拒绝（未写提示、未扣桶）——与 gated/deferred/bucket-empty 一样终止链，不再往后匹配规则
        if (result.status === 'gated' || result.status === 'deferred' || result.status === 'bucket-empty' || result.status === 'quota') return result;
    }
    return { status: 'no-match' };
}

/** 事件入口：把 EventView 转成链求值输入（v1 条件命中后 matched=true） */
export async function runChainForEvent(
    session: Session,
    view: EventView,
    ctx: seal.MsgContext,
    msg: seal.Message,
    options: { deferWake?: boolean; detachedWake?: boolean } = {},
): Promise<ChainResult> {
    return runChain({
        session,
        ctx,
        msg,
        event: { eventType: view.eventType, matched: true, view },
        userId: view.userId,
        platform: view.platform,
        deferWake: options.deferWake,
        detachedWake: options.detachedWake,
    });
}

/** 状态总览（`.ai trg status`/调试用） */
export function describePendingDelays(): Array<{ key: string; ruleId: string; sessionId: string; dueAt: number }> {
    return getPendingDelays().list().map(slot => ({ key: slot.key, ruleId: slot.ruleId, sessionId: slot.sessionId, dueAt: slot.dueAt }));
}

/** GATE_META 汇总（命令展示用；避免 cmd 层直接 import trigger 内部） */
export function gateTypes(): string[] {
    return Object.keys(GATE_META);
}

/** 单条规则文本摘要（命令展示用） */
export function summarizeRule(rule: TriggerRule): string {
    const gates = rule.gates.map(gate => GATE_META[gate.type]?.summary(gate) ?? gate.type).join(' → ');
    return `${rule.id}: ${gates}`;
}
