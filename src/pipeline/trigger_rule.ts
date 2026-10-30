// 规则链编排（L4）：把触发域纯能力（eval/store/pending）接到会话与起轮上。
//
// 唯一编排点（方案 §5.3/§5.5）：
// - 选规则（enabled/过期/次数/作用域）→ 按门求值 → delay 挂起或整链通过；
// - 只有 wake 返回 fired 才提交 fired++/lastFiredAt；counter 计数增量随求值持久化；
// - 消息路径用认领表保证一条消息最多一个触发对象（链规则之间、链与判定之间）；
// - 自主源（timer 到点）经 runChain({ruleId, sourceSatisfied:true}) 复用同一求值/起轮路径。
import { EVENT_TRIGGER_KNOWN_EVENTS, matchEventTrigger } from "../event/trigger";
import type { EventView } from "../event/trigger";
import { logger } from "../logger";
import type { Session } from "../session/session";
import type { ChatOutcome } from "../session/session";
import { createGateRuntime, evaluateGates, GATE_META, PendingDelays, pickWakePrompt, ruleMatchesScope, ruleSkipReason, ruleWakePrompts, TriggerRuleStore } from "../trigger";
import type { Gate, GateInput, RuleStateShard, TriggerRule } from "../trigger";
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
}

export type ChainStatus = 'fired' | 'suspended' | 'claimed' | 'no-match' | ChatOutcome;

export interface ChainResult {
    status: ChainStatus;
    ruleId?: string;
}

let storeInstance: TriggerRuleStore | null = null;
export function getRuleStore(): TriggerRuleStore {
    if (!storeInstance) {
        storeInstance = new TriggerRuleStore({ knownEvents: EVENT_TRIGGER_KNOWN_EVENTS });
    }
    return storeInstance;
}

const pending = new PendingDelays<{ session: Session; ctx: seal.MsgContext; msg: seal.Message }>();
export function getPendingDelays() {
    return pending;
}

/** 仅测试：重置单例（规则库 + 挂起槽） */
export function resetTriggerRuleStateForTest(): void {
    storeInstance = null;
    pending.clear();
}

function stateOf(rule: TriggerRule, sessionId: string): RuleStateShard {
    const map = getRuleStore().readState(rule.id);
    return map[sessionId] || { fired: 0, lastFiredAt: 0, gates: {} };
}

/** 把运行时 counter 合并进 shard 并落盘（counter 增量必须准，force 跳过节流） */
function persistCounters(rule: TriggerRule, sessionId: string, shard: RuleStateShard, counters: Record<number, number>): void {
    const gates = { ...(shard.gates || {}) };
    for (const [index, count] of Object.entries(counters)) {
        if (count > 0) gates[index] = { count, lastPassAt: Date.now() };
        else delete gates[index];
    }
    const next: RuleStateShard = { ...shard, gates };
    const map = getRuleStore().readState(rule.id);
    map[sessionId] = next;
    getRuleStore().writeState(rule.id, map, true);
}

function persistFired(rule: TriggerRule, sessionId: string, shard: RuleStateShard, now: number): void {
    const next: RuleStateShard = { fired: shard.fired + 1, lastFiredAt: now, gates: {} };
    const map = getRuleStore().readState(rule.id);
    map[sessionId] = next;
    getRuleStore().writeState(rule.id, map, true);
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

async function fireRule(rule: TriggerRule, input: ChainInput, shard: RuleStateShard, counters: Record<number, number>): Promise<ChainResult> {
    const wakeText = pickWakePrompt(ruleWakePrompts(rule)) || DEFAULT_RULE_WAKE_TEXT;
    const outcome = await wakeSession(input.session, input.ctx, input.msg, {
        kind: 'rule',
        wakeText,
        reason: '触发规则',
        raw: { ruleId: rule.id },
    });
    if (outcome === 'fired') {
        persistFired(rule, input.session.sessionId, shard, input.now ?? Date.now());
        if (input.claimIdentity) {
            claimTable.claim(input.session.sessionId, messageClaimKey(input.session.sessionId, input.claimIdentity), 'chain');
        }
        return { status: 'fired', ruleId: rule.id };
    }
    // 未真正起轮：计数保留（已按求值增量落盘），不记 fired
    persistCounters(rule, input.session.sessionId, shard, counters);
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

/** delay 到期续算：规则可能已被删除/停用 */
async function evaluateRuleFrom(ruleId: string, session: Session, ctx: seal.MsgContext, msg: seal.Message, startIndex: number, original: ChainInput): Promise<void> {
    const rule = getRuleStore().getById(ruleId);
    if (!rule || !rule.enabled) return;
    applyLastMessageRef(session, ctx, msg);
    await evaluateRule(rule, { ...original, session, ctx, msg }, startIndex);
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
        // 源门类型必须与入口匹配：消息入口只跑 regex/event/active_time 源；自主入口只跑 timer 源
        const source = rule.gates[0];
        if (!source) continue;
        if (input.sourceSatisfied) {
            if (source.type !== 'timer') continue;
        } else if (source.type === 'timer') {
            continue;
        } else if (source.type === 'event' && !input.event) {
            continue;
        } else if (source.type === 'regex' && input.text === undefined) {
            continue;
        }
        const result = await evaluateRule(rule, input);
        if (result.status === 'fired' || result.status === 'suspended') return result;
        if (result.status === 'gated' || result.status === 'deferred') return result;
    }
    return { status: 'no-match' };
}

/** 事件入口：把 EventView 转成链求值输入（v1 条件命中后 matched=true） */
export async function runChainForEvent(session: Session, view: EventView, ctx: seal.MsgContext, msg: seal.Message): Promise<ChainResult> {
    return runChain({
        session,
        ctx,
        msg,
        event: { eventType: view.eventType, matched: true, view },
        userId: view.userId,
        platform: view.platform,
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
