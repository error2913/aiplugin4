// 门控链规则（L2 纯能力）：门元数据（校验/摘要/位置约束）与规则校验。
//
// 目标：校验逻辑只有一份，AI 工具 / 命令 / v1 编译 / 运行时都调它；错误按路径一次性返回。
// 位置约束见方案 §4.2：源门（regex/event/active_time/timer）至多一个且必须在 gates[0]；
// 自主源（active_time/timer）之后只允许 user/counter/prob（不允许 delay）。
import { parseTimeSegment } from "../utils/time_window";
import { summarizeTimerSpec, validateTimerSpec } from "../utils/timer_spec";

import type {
    ActiveTimeGate,
    CounterGate,
    DelayGate,
    EventGate,
    Gate,
    GateType,
    ProbGate,
    RegexGate,
    RuleScope,
    TimerGate,
    TriggerRule,
    UserGate,
} from "./types";

/** 规则数量/规模上限（方案 §4.1） */
export const RULE_LIMITS = {
    /** 单会话规则条数 */
    sessionRules: 200,
    /** 全局规则条数 */
    globalRules: 64,
    /** 单条规则门数 */
    gates: 6,
    /** 唤醒词条数 */
    wakePrompts: 10,
    /** 单条唤醒词字数 */
    wakePromptChars: 500,
    /** 正则源码长度 */
    regexChars: 200,
    /** scope 列表长度 */
    scopeList: 200,
    /** 单条规则序列化字节数 */
    ruleBytes: 2048,
    /** 事件条件条数（与 v1 一致） */
    eventMatch: 10,
} as const;

export type GateCategory = 'source' | 'filter' | 'timing';

export interface GateMeta {
    type: GateType;
    category: GateCategory;
    /** positional：source=只能 gates[0] 且至多一个；any=任意位置 */
    position: 'source' | 'any';
    /** 校验单个门，返回错误文案（空数组=通过） */
    validate(gate: Gate, ctx: GateValidateContext): string[];
    /** 单行摘要（工具/命令回显） */
    summary(gate: Gate): string;
}

export interface GateValidateContext {
    /** 规则 scope（active_time/timer 门要求 sessions 非空） */
    scope: RuleScope;
    /** 已知事件名（由 event 层注入，trigger 不 import event/config，保持纯能力） */
    knownEvents?: readonly string[];
    /** 当前时间（毫秒，target 定时器校验用） */
    now: number;
}

function err(path: string, message: string): string[] {
    return [`${path}：${message}`];
}

const NON_EMPTY_STR = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** 门元数据（唯一事实源：新增门类型只改这里 + types.ts） */
export const GATE_META: Record<GateType, GateMeta> = {
    regex: {
        type: 'regex',
        category: 'source',
        position: 'source',
        validate(gate) {
            const g = gate as RegexGate;
            if (!NON_EMPTY_STR(g.pattern)) return err('pattern', '不能为空');
            if (g.pattern.length > RULE_LIMITS.regexChars) return err('pattern', `长度不能超过 ${RULE_LIMITS.regexChars}`);
            if (g.flags && !/^[ims]{0,3}$/.test(g.flags)) return err('flags', '只支持 i/m/s 组合');
            try {
                new RegExp(g.pattern, g.flags || '');
            } catch (e) {
                return err('pattern', `正则非法：${e instanceof Error ? e.message : String(e)}`);
            }
            return [];
        },
        summary(gate) {
            const g = gate as RegexGate;
            return `regex(${g.pattern}${g.flags ? `/${g.flags}` : ''})`;
        },
    },
    event: {
        type: 'event',
        category: 'source',
        position: 'source',
        validate(gate, ctx) {
            const g = gate as EventGate;
            if (!NON_EMPTY_STR(g.on)) return err('on', '必须指定事件类型');
            if (ctx.knownEvents && !ctx.knownEvents.includes(g.on)) {
                return err('on', `未知事件类型：${g.on}`);
            }
            if (g.match !== undefined) {
                if (!Array.isArray(g.match)) return err('match', '必须是数组');
                if (g.match.length > RULE_LIMITS.eventMatch) return err('match', `最多 ${RULE_LIMITS.eventMatch} 条条件`);
            }
            return [];
        },
        summary(gate) {
            const g = gate as EventGate;
            return `event(${g.on}${g.match && g.match.length ? ` ×${g.match.length}` : ''})`;
        },
    },
    active_time: {
        type: 'active_time',
        category: 'source',
        position: 'source',
        validate(gate, ctx) {
            const g = gate as ActiveTimeGate;
            const errors: string[] = [];
            if (!ctx.scope.sessions || ctx.scope.sessions.length === 0) {
                errors.push('active_time：自主源规则必须显式指定会话列表（禁止全局）');
            }
            const parsed = parseTimeSegment(`${g.start}-${g.end}${g.segs !== undefined ? `-${g.segs}` : ''}`);
            if (parsed.error) errors.push(parsed.error);
            return errors;
        },
        summary(gate) {
            const g = gate as ActiveTimeGate;
            return `active_time(${g.start}-${g.end}${g.segs && g.segs > 1 ? `×${g.segs}` : ''})`;
        },
    },
    timer: {
        type: 'timer',
        category: 'source',
        position: 'source',
        validate(gate, ctx) {
            const g = gate as TimerGate;
            const errors: string[] = [];
            if (!ctx.scope.sessions || ctx.scope.sessions.length === 0) {
                errors.push('timer：自主源规则必须显式指定会话列表（禁止全局）');
            }
            const result = validateTimerSpec(g, ctx.now);
            errors.push(...result.errors.map(item => `timer.${item}`));
            return errors;
        },
        summary(gate) {
            const g = gate as TimerGate;
            const result = validateTimerSpec(g);
            return `timer(${result.ok && result.spec ? summarizeTimerSpec(result.spec) : g.types})`;
        },
    },
    user: {
        type: 'user',
        category: 'filter',
        position: 'any',
        validate(gate) {
            const g = gate as UserGate;
            const errors: string[] = [];
            if (!Array.isArray(g.ids) || g.ids.length === 0) {
                errors.push('ids：必须是非空数组');
            } else if (g.ids.some(item => !NON_EMPTY_STR(item) || item.length > 20)) {
                errors.push('ids：每项必须是 ≤20 字的非空字符串');
            }
            if (g.exclude !== undefined) {
                if (!Array.isArray(g.exclude)) errors.push('exclude：必须是数组');
                else if (g.exclude.some(item => !NON_EMPTY_STR(item) || item.length > 20)) {
                    errors.push('exclude：每项必须是 ≤20 字的非空字符串');
                }
            }
            return errors;
        },
        summary(gate) {
            const g = gate as UserGate;
            return `user(${g.ids.join(',')}${g.exclude && g.exclude.length ? ` 排除${g.exclude.length}` : ''})`;
        },
    },
    counter: {
        type: 'counter',
        category: 'filter',
        position: 'any',
        validate(gate) {
            const g = gate as CounterGate;
            if (!Number.isInteger(g.n) || g.n < 1 || g.n > 1000) return err('n', '必须是 1~1000 的整数');
            return [];
        },
        summary(gate) {
            return `counter(${(gate as CounterGate).n})`;
        },
    },
    prob: {
        type: 'prob',
        category: 'filter',
        position: 'any',
        validate(gate) {
            const g = gate as ProbGate;
            if (typeof g.percent !== 'number' || !Number.isFinite(g.percent) || g.percent < 1 || g.percent > 100) {
                return err('percent', '必须是 1~100');
            }
            return [];
        },
        summary(gate) {
            return `prob(${(gate as ProbGate).percent}%)`;
        },
    },
    delay: {
        type: 'delay',
        category: 'timing',
        position: 'any',
        validate(gate) {
            const g = gate as DelayGate;
            if (!Number.isInteger(g.delay_sec) || g.delay_sec < 1 || g.delay_sec > 86400) {
                return err('delay_sec', '必须是 1~86400 秒的整数');
            }
            return [];
        },
        summary(gate) {
            return `delay(${(gate as DelayGate).delay_sec}s)`;
        },
    },
};

export function isSourceGate(gate: Gate): boolean {
    return GATE_META[gate.type]?.category === 'source';
}

/** 规则的唤醒文本候选（timer 源门规则可省略规则级 wake_prompts，文本来自门内 prompts） */
export function ruleWakePrompts(rule: TriggerRule): string[] {
    if (rule.wake_prompts && rule.wake_prompts.length > 0) return rule.wake_prompts;
    const first = rule.gates[0];
    if (first && first.type === 'timer') return first.prompts || [];
    return [];
}

/** 随机抽取一条唤醒文本（空数组返回空串，由调用方回退内置文案） */
export function pickWakePrompt(prompts: readonly string[] | undefined, random: () => number = Math.random): string {
    if (!prompts || prompts.length === 0) return '';
    const index = Math.min(prompts.length - 1, Math.max(0, Math.floor(random() * prompts.length)));
    return prompts[index];
}

/** 单行摘要（工具/命令展示） */
export function summarizeGates(gates: readonly Gate[]): string {
    return gates.map(gate => GATE_META[gate.type]?.summary(gate) ?? gate.type).join(' → ');
}

function validateScope(raw: unknown, errors: string[]): RuleScope {
    const scope: RuleScope = {};
    if (raw === undefined) return scope;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('scope：必须是对象');
        return scope;
    }
    const obj = raw as Record<string, unknown>;
    for (const key of ['platforms', 'sessions', 'exclude'] as const) {
        const value = obj[key];
        if (value === undefined) continue;
        if (!Array.isArray(value)) {
            errors.push(`scope.${key}：必须是数组`);
            continue;
        }
        if (value.length > RULE_LIMITS.scopeList) {
            errors.push(`scope.${key}：最多 ${RULE_LIMITS.scopeList} 项`);
            continue;
        }
        if (value.some(item => !NON_EMPTY_STR(item))) {
            errors.push(`scope.${key}：每项必须是非空字符串`);
            continue;
        }
        scope[key] = value as string[];
    }
    return scope;
}

function validateWakePrompts(raw: unknown, errors: string[], path = 'wake_prompts'): string[] {
    if (!Array.isArray(raw)) {
        errors.push(`${path}：必须是数组`);
        return [];
    }
    if (raw.length > RULE_LIMITS.wakePrompts) {
        errors.push(`${path}：最多 ${RULE_LIMITS.wakePrompts} 条`);
        return [];
    }
    const out: string[] = [];
    for (const item of raw) {
        if (!NON_EMPTY_STR(item)) {
            errors.push(`${path}：每条必须是非空字符串`);
            continue;
        }
        if (item.length > RULE_LIMITS.wakePromptChars) {
            errors.push(`${path}：每条不能超过 ${RULE_LIMITS.wakePromptChars} 字`);
            continue;
        }
        out.push(item);
    }
    return out;
}

/**
 * 校验一条规则（外部输入 → 规范化规则）。
 * @returns 失败时 errors 为**路径级**多条错误（一次报全）
 */
export function validateRule(raw: unknown, ctx: GateValidateContext): { ok: true; rule: TriggerRule } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, errors: ['规则必须是对象'] };
    }
    const obj = raw as Record<string, unknown>;

    if (!NON_EMPTY_STR(obj.id)) errors.push('id：必须是非空字符串');
    const enabled = obj.enabled === undefined ? true : obj.enabled;
    if (typeof enabled !== 'boolean') errors.push('enabled：必须是布尔值');
    const source = obj.source === undefined ? 'ai' : obj.source;
    if (source !== 'ai' && source !== 'mode') errors.push('source：必须是 ai 或 mode');
    const createdAt = typeof obj.createdAt === 'number' ? obj.createdAt : ctx.now;
    const scope = validateScope(obj.scope, errors);

    if (!Array.isArray(obj.gates) || obj.gates.length === 0) {
        errors.push('gates：必须是非空数组');
        return { ok: false, errors };
    }
    if (obj.gates.length > RULE_LIMITS.gates) errors.push(`gates：最多 ${RULE_LIMITS.gates} 个门`);
    const gates: Gate[] = [];
    obj.gates.forEach((item, index) => {
        const path = `gates[${index}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push(`${path}：必须是对象`);
            return;
        }
        const type = (item as Record<string, unknown>).type;
        if (typeof type !== 'string' || !(type in GATE_META)) {
            errors.push(`${path}.type：未知门类型 ${String(type)}`);
            return;
        }
        const gate = item as Gate;
        const meta = GATE_META[gate.type];
        if (meta.position === 'source') {
            if (index !== 0) errors.push(`${path}.type：源门只能出现在 gates[0]`);
            else if (gates.some(g => isSourceGate(g))) errors.push(`${path}.type：源门只能有一个`);
        } else if (index === 0) {
            errors.push(`${path}.type：gates[0] 必须是源门（regex/event/active_time/timer）`);
        }
        errors.push(...meta.validate(gate, { scope, knownEvents: ctx.knownEvents, now: ctx.now }).map(text => `${path}.${text}`));
        gates.push(gate);
    });

    // 自主源链约束：active_time/timer 之后只允许 user/counter/prob（不允许 delay）
    const first = gates[0];
    if (first && (first.type === 'active_time' || first.type === 'timer')) {
        for (let i = 1; i < gates.length; i++) {
            const type = gates[i]?.type;
            if (type === 'delay') errors.push(`gates[${i}].type：自主源链不允许 delay`);
            else if (type === 'regex' || type === 'event' || type === 'active_time' || type === 'timer') {
                errors.push(`gates[${i}].type：自主源链只允许 user/counter/prob`);
            }
        }
    }

    const wakeRaw = obj.wake_prompts;
    const isTimerSource = first && first.type === 'timer';
    let wakePrompts: string[] = [];
    const wakeEmpty = wakeRaw === undefined || (Array.isArray(wakeRaw) && wakeRaw.length === 0);
    if (isTimerSource && wakeEmpty) {
        // timer 源门：规则级 wake_prompts 可省略（或空数组），文本来自门内 prompts（避免两处文本）
    } else {
        wakePrompts = validateWakePrompts(wakeRaw, errors);
        if (wakePrompts.length === 0) errors.push('wake_prompts：至少需要 1 条唤醒文本');
    }

    const limitsRaw = obj.limits && typeof obj.limits === 'object' ? obj.limits as Record<string, unknown> : {};
    const maxTriggers = limitsRaw.max_triggers === undefined ? -1 : Number(limitsRaw.max_triggers);
    if (!Number.isInteger(maxTriggers) || maxTriggers < -1) errors.push('limits.max_triggers：必须是 ≥-1 的整数');
    const expireAt = limitsRaw.expire_at === undefined ? 0 : Number(limitsRaw.expire_at);
    if (!Number.isFinite(expireAt) || expireAt < 0) errors.push('limits.expire_at：必须是 ≥0 的毫秒时间戳');

    if (errors.length > 0) return { ok: false, errors };

    const rule: TriggerRule = {
        id: String(obj.id),
        enabled: enabled as boolean,
        source: source as 'ai' | 'mode',
        createdAt,
        wake_prompts: wakePrompts,
        gates,
        scope,
        limits: { max_triggers: maxTriggers, expire_at: expireAt },
    };
    const bytes = JSON.stringify(rule).length;
    if (bytes > RULE_LIMITS.ruleBytes) {
        return { ok: false, errors: [`规则过大：${bytes} > ${RULE_LIMITS.ruleBytes} 字`] };
    }
    return { ok: true, rule };
}

/** scope 是否覆盖当前会话/平台（空值=不限） */
export function ruleMatchesScope(rule: TriggerRule, input: { sessionId: string; platform?: string }): boolean {
    const { platforms, sessions, exclude } = rule.scope;
    if (exclude && exclude.includes(input.sessionId)) return false;
    if (platforms && platforms.length > 0 && input.platform && !platforms.includes(input.platform)) return false;
    if (sessions && sessions.length > 0 && !sessions.includes(input.sessionId)) return false;
    return true;
}

/** 规则级跳过原因（未启用/过期/次数用尽）；返回 null 表示可求值 */
export function ruleSkipReason(rule: TriggerRule, fired: number, now: number): string | null {
    if (!rule.enabled) return 'disabled';
    if (rule.limits.expire_at > 0 && now >= rule.limits.expire_at) return 'expired';
    if (rule.limits.max_triggers >= 0 && fired >= rule.limits.max_triggers) return 'exhausted';
    return null;
}
