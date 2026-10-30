// 触发域链规则工具（M4）：set_trigger_rule / list_trigger_rules / delete_trigger_rule。
//
// 方案 §7：schema/description 英文、返回中文；校验一次报全（类型/位置/范围/自主源禁全局/上限）；
// 规则存储走 L2 `trigger/runtime` 单例（与编排/命令共享），timer 门经 L0 端口注册。
import { addRuleTimer, listRuleTimers, removeRuleTimers } from "../../../core/ports/trigger_timer";
import { EVENT_TRIGGER_KNOWN_EVENTS } from "../../../event/trigger";
import type { Session } from "../../../session/session";
import { GATE_META, RULE_LIMITS, ruleWakePrompts, summarizeGates, validateRule } from "../../../trigger";
import type { TriggerRule } from "../../../trigger";
import { getRuleStore, pendingDelays } from "../../../trigger/runtime";
import { fmtDate } from "../../../utils/string";
import { validateTimerSpec } from "../../../utils/timer_spec";
import Tool from "../../tool";


const GATE_TYPES = Object.keys(GATE_META);

function newRuleId(): string {
    return `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function parseScope(raw: unknown, session: Session): { ok: true; scope: TriggerRule['scope'] } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, scope: { sessions: [session.sessionId] } };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'scope 必须是对象' };
    const obj = raw as Record<string, unknown>;
    const scope: TriggerRule['scope'] = {};
    for (const key of ['platforms', 'sessions', 'exclude'] as const) {
        const value = obj[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
            return { ok: false, error: `scope.${key} 必须是非空字符串数组` };
        }
        scope[key] = value as string[];
    }
    // 未显式给 sessions 时默认当前会话（避免 AI 无意间建全局规则）
    if (scope.sessions === undefined) scope.sessions = [session.sessionId];
    return { ok: true, scope };
}

/**
 * timer 源门规则创建后注册定时器：只对「当前会话」注册（epId 来自 ctx）；
 * 其它会话由各自会话恢复/下次消息时的对账补齐（timer 条目需要 epId）。
 */
function registerRuleTimers(rule: TriggerRule, ctx: seal.MsgContext, session: Session): void {
    const gates = rule.gates;
    if (gates.length === 0 || gates[0].type !== 'timer') return;
    const timerGate = gates[0];
    const parsed = validateTimerSpec(timerGate);
    if (!parsed.ok || !parsed.spec) return;
    const spec = parsed.spec;
    const sessions = rule.scope.sessions || [];
    for (const sid of sessions) {
        if (sid !== session.sessionId) continue;
        addRuleTimer({ sid, isPrivate: ctx.isPrivate, epId: ctx.endPoint.userId }, {
            ruleId: rule.id,
            modeTag: 'rule',
            type: spec.types,
            target: spec.types === 'target' ? spec.targetAt : undefined,
            interval: spec.types === 'interval' ? spec.intervalSec : undefined,
            count: spec.types === 'target' ? 1 : (spec.count ?? 1),
            prompts: spec.prompts,
        });
    }
}

function formatRule(rule: TriggerRule, state: { fired: number; lastFiredAt: number } | undefined, timerNext?: number): string {
    const max = rule.limits.max_triggers === -1 ? '无限' : String(rule.limits.max_triggers);
    const fired = state?.fired ?? 0;
    const prompts = ruleWakePrompts(rule);
    const scope = rule.scope.sessions && rule.scope.sessions.length > 0
        ? (rule.scope.sessions.length === 1 ? rule.scope.sessions[0] : `${rule.scope.sessions.length}个会话`)
        : '全局';
    const parts = [
        `${rule.id}｜${summarizeGates(rule.gates)}`,
        `唤醒${prompts.length}条｜次数${fired}/${max}`,
        `范围${scope}`,
        rule.limits.expire_at > 0 ? `到期${fmtDate(Math.floor(rule.limits.expire_at / 1000))}` : '不过期',
        state?.lastFiredAt ? `上次${fmtDate(Math.floor(state.lastFiredAt / 1000))}` : '未触发',
        timerNext ? `下次${fmtDate(timerNext)}` : '',
    ];
    return parts.filter(Boolean).join('｜');
}

export function registerTriggerRuleTools() {
    const setTool = new Tool({
        type: 'function',
        function: {
            name: 'set_trigger_rule',
            description: 'Create a trigger rule (condition chain). When all gates pass, the bot proactively speaks with one of the wake prompts. Gates: first gate must be a source gate (regex / event / active_time / timer), later gates are filters (user / counter / prob) or a timing gate (delay).',
            parameters: {
                type: 'object',
                properties: {
                    wake_prompts: {
                        type: 'array',
                        description: '1-10 wake prompts; one is picked randomly when the rule fires (required unless the source gate is timer, whose prompts live in the gate)',
                        items: { type: 'string' },
                    },
                    gates: {
                        type: 'array',
                        description: `1-${RULE_LIMITS.gates} gates. Gate types: ${GATE_TYPES.join(', ')}. `
                            + 'regex: {type:"regex",pattern,flags?} | event: {type:"event",on,match?} | active_time: {type:"active_time",start:"HH:mm",end:"HH:mm",segs?} | '
                            + 'timer: {type:"timer",types:"target|interval",years?,months?,days?,hours?,minutes,count?,prompts:[...]} | '
                            + 'user: {type:"user",ids:[...],exclude?} | counter: {type:"counter",n} | prob: {type:"prob",percent} | delay: {type:"delay",delay_sec}',
                        items: {
                            type: 'object',
                            properties: { type: { type: 'string', enum: GATE_TYPES } },
                            additionalProperties: true,
                        },
                    },
                    scope: {
                        type: 'object',
                        description: 'Optional scope; defaults to the current session. sessions=[] means global (limited to 64 rules)',
                        properties: {
                            platforms: { type: 'array', items: { type: 'string' } },
                            sessions: { type: 'array', items: { type: 'string' } },
                            exclude: { type: 'array', items: { type: 'string' } },
                        },
                        additionalProperties: false,
                    },
                    max_triggers: { type: 'integer', description: 'Max total fires; -1 = unlimited (default -1)' },
                    expires_in_sec: { type: 'integer', description: 'Rule expires after N seconds; -1 = never (default -1)' },
                },
                required: ['wake_prompts', 'gates'],
            },
        },
    });
    setTool.solve = async (_ctx, _msg, session, args) => {
        const scopeResult = parseScope(args.scope, session);
        if ('error' in scopeResult) return scopeResult.error;
        const scope = scopeResult.scope;

        // 上限：会话规则 200 / 全局 64
        const rules = getRuleStore().list();
        const isGlobal = !scope.sessions || scope.sessions.length === 0;
        if (isGlobal) {
            const count = rules.filter(rule => !rule.scope.sessions || rule.scope.sessions.length === 0).length;
            if (count >= RULE_LIMITS.globalRules) return `全局规则已达上限（${RULE_LIMITS.globalRules} 条），请先删除（delete_trigger_rule）`;
        } else {
            const sid = session.sessionId;
            const count = rules.filter(rule => rule.scope.sessions?.includes(sid)).length;
            if (count >= RULE_LIMITS.sessionRules) return `本会话规则已达上限（${RULE_LIMITS.sessionRules} 条），请先删除（delete_trigger_rule）`;
        }

        const maxTriggers = args.max_triggers === undefined ? -1 : Number(args.max_triggers);
        if (!Number.isInteger(maxTriggers) || maxTriggers < -1) return 'max_triggers 必须是 ≥-1 的整数';
        const expiresIn = args.expires_in_sec === undefined ? -1 : Number(args.expires_in_sec);
        if (!Number.isInteger(expiresIn) || (expiresIn !== -1 && expiresIn <= 0)) return 'expires_in_sec 必须是正整数或 -1';

        const raw = {
            id: newRuleId(),
            enabled: true,
            source: 'ai',
            createdAt: Date.now(),
            wake_prompts: args.wake_prompts,
            gates: args.gates,
            scope,
            limits: {
                max_triggers: maxTriggers,
                expire_at: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
            },
        };
        const result = validateRule(raw, { scope, knownEvents: EVENT_TRIGGER_KNOWN_EVENTS, now: Date.now() });
        if ('errors' in result) return `规则校验失败（${result.errors.length} 处）：\n${result.errors.map(item => `- ${item}`).join('\n')}`;
        const rule = result.rule;
        getRuleStore().upsert(rule);
        registerRuleTimers(rule, _ctx, session);
        return `已创建规则 ${rule.id}：${summarizeGates(rule.gates)}；唤醒词${ruleWakePrompts(rule).length}条；次数=${maxTriggers === -1 ? '无限' : maxTriggers}；范围=${isGlobal ? '全局' : '会话'}`;
    };

    const listTool = new Tool({
        type: 'function',
        function: {
            name: 'list_trigger_rules',
            description: 'List trigger rules with progress. scope: current (default) / global / all',
            parameters: {
                type: 'object',
                properties: {
                    scope: { type: 'string', enum: ['current', 'global', 'all'], description: 'Which rules to list' },
                },
            },
        },
    });
    listTool.solve = async (_ctx, _msg, session, args) => {
        const scope = args.scope === 'global' || args.scope === 'all' ? args.scope : 'current';
        const sid = session.sessionId;
        const rules = getRuleStore().list().filter(rule => {
            const sessions = rule.scope.sessions || [];
            if (scope === 'all') return true;
            if (scope === 'global') return sessions.length === 0;
            return sessions.includes(sid);
        });
        if (rules.length === 0) return '没有匹配的触发规则';
        const lines = rules.slice(0, 50).map(rule => {
            const state = getRuleStore().readState(rule.id)[sid];
            const next = listRuleTimers(rule.id)[0]?.target;
            return `- ${formatRule(rule, state, next)}`;
        });
        return `触发规则（${rules.length} 条${rules.length > 50 ? '，仅显示前 50' : ''}）：\n${lines.join('\n')}`;
    };

    const deleteTool = new Tool({
        type: 'function',
        function: {
            name: 'delete_trigger_rule',
            description: 'Delete trigger rules by id, or all rules of the current session. Cleans their pending delays and timers.',
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'Rule ids to delete' },
                    all: { type: 'boolean', description: 'Delete all rules of the current session' },
                },
            },
        },
    });
    deleteTool.sensitive = true;
    deleteTool.solve = async (_ctx, _msg, session, args) => {
        const store = getRuleStore();
        const ids: string[] = Array.isArray(args.ids) ? args.ids.map((item: unknown) => String(item)) : [];
        let targets: TriggerRule[] = [];
        if (args.all === true) {
            targets = store.list().filter(rule => rule.scope.sessions?.includes(session.sessionId));
        } else if (ids.length > 0) {
            targets = ids.map(id => store.getById(id)).filter((rule): rule is TriggerRule => !!rule);
        } else {
            return '请提供 ids 或 all=true';
        }
        let removed = 0;
        for (const rule of targets) {
            removeRuleTimers(rule.id);
            pendingDelays.cancelRule(rule.id);
            if (store.remove(rule.id)) removed++;
        }
        return removed > 0 ? `已删除 ${removed} 条触发规则（并清理对应 delay 挂起与定时器）` : '没有删除任何规则（未找到匹配 id）';
    };
}
