// M1-A 单测：触发域纯能力层（timer_spec / time_window / mention / rule / eval）。
// 只测纯函数，不依赖 seal/宿主；事件白名单通过 opts 注入，trigger 不 import event/config。
import assert from 'node:assert/strict';

import { GATE_META, pickWakePrompt, ruleMatchesScope, ruleSkipReason, summarizeGates, validateRule } from '../src/trigger/rule';
import { createGateRuntime, evaluateGates } from '../src/trigger/eval';
import { COMMAND_ALIASES, VERB_ALIASES } from '../src/config/static_config/alias';
import { MODES, MODE_TOKENS, TRIGGER_CONFIG_KEYS, modeByToken } from '../src/config/static_config/trigger_meta';
import { aliasToCmd, resolveCmdChain } from '../src/utils/alias';
import { validateTimerSpec } from '../src/utils/timer_spec';
import { activeSegmentIndex, nextActivePoint, parseTimeSegments } from '../src/utils/time_window';
import { detectBotMention } from '../src/utils/mention';
import type { GateInput, TriggerRule } from '../src/trigger/types';

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

function baseRule(gates: any[], extra: Record<string, unknown> = {}): any {
    return {
        id: 'tr_test',
        enabled: true,
        source: 'ai',
        createdAt: NOW,
        wake_prompts: ['醒醒'],
        gates,
        scope: {},
        limits: { max_triggers: -1, expire_at: 0 },
        ...extra,
    };
}

function input(partial: Partial<GateInput> = {}): GateInput {
    return { sessionId: 'QQ-Group:1', now: NOW, ...partial };
}

export const tests = {
    // ---------- timer_spec（配置/set_timer/链门共用） ----------
    testTimerSpecInterval(): void {
        const result = validateTimerSpec({ types: 'interval', hours: 12, count: -1, prompts: ['a'] }, NOW);
        assert.equal(result.ok, true);
        assert.equal(result.spec!.intervalSec, 12 * 3600);
    },
    testTimerSpecTargetRequiresYmd(): void {
        const missing = validateTimerSpec({ types: 'target', minutes: 30, prompts: ['a'] }, NOW);
        assert.equal(missing.ok, false);
        assert.ok(missing.errors.some(e => e.includes('years')));
        const past = validateTimerSpec({ types: 'target', years: 2000, months: 1, days: 1, minutes: 0, prompts: ['a'] }, NOW);
        assert.equal(past.ok, false);
    },
    testTimerSpecPromptsAndCountRules(): void {
        assert.equal(validateTimerSpec({ types: 'interval', hours: 1, prompts: [] }, NOW).ok, false);
        assert.equal(validateTimerSpec({ types: 'interval', hours: 1, prompts: Array.from({ length: 11 }, () => 'a') }, NOW).ok, false);
        assert.equal(validateTimerSpec({ types: 'interval', hours: 1, count: 0, prompts: ['a'] }, NOW).ok, false);
        assert.equal(validateTimerSpec({ types: 'interval', hours: 1, count: 31, prompts: ['a'] }, NOW).ok, false);
        assert.equal(validateTimerSpec({ types: 'interval', hours: 12, count: -1, prompts: ['a'] }, NOW).ok, true);
        assert.equal(validateTimerSpec({ types: 'interval', minutes: 30, count: -1, prompts: ['a'] }, NOW).ok, false);
    },

    // ---------- time_window ----------
    testTimeWindowParseAndOverlap(): void {
        const parsed = parseTimeSegments(['09:00-12:00-3', '', '11:00-13:00', 'abc']);
        assert.equal(parsed.segments.length, 1);
        assert.equal(parsed.segments[0].segs, 3);
        assert.ok(parsed.warnings.some(w => w.includes('重叠')));
        assert.ok(parsed.warnings.some(w => w.includes('格式错误')));
    },
    testTimeWindowIndexAndNextPoint(): void {
        const { segments } = parseTimeSegments(['09:00-18:00-2']);
        assert.equal(activeSegmentIndex(segments, new Date(2026, 9, 31, 10, 0, 0)), 0);
        assert.equal(activeSegmentIndex(segments, new Date(2026, 9, 31, 20, 0, 0)), -1);
        const next = nextActivePoint(segments, new Date(2026, 9, 31, 20, 0, 0).getTime(), () => 0);
        assert.ok(next > 0);
        const nextDate = new Date(next * 1000);
        assert.equal(nextDate.getDate(), 1); // 次日 09:00
    },

    // ---------- mention ----------
    testDetectBotMention(): void {
        const ctx = { isPrivate: false, endPoint: { userId: 'QQ:10000', platform: 'qq' } } as any;
        const at = (qq: string) => ({ type: 'at', data: { qq } }) as any;
        assert.equal(detectBotMention([at('10000')], ctx), true);
        assert.equal(detectBotMention([at('QQ:10000')], ctx), true);
        assert.equal(detectBotMention([at('all')], ctx), false);
        assert.equal(detectBotMention([at('99999')], ctx), false);
        assert.equal(detectBotMention([], ctx), false);
        assert.equal(detectBotMention([at('10000')], { ...ctx, isPrivate: true } as any), false);
    },

    // ---------- rule 校验 ----------
    testValidateRuleOk(): void {
        const result = validateRule(baseRule([{ type: 'regex', pattern: '考试' }, { type: 'counter', n: 3 }]), { scope: {}, now: NOW });
        assert.equal(result.ok, true);
        const rule = (result as { ok: true; rule: TriggerRule }).rule;
        assert.equal(rule.gates.length, 2);
        assert.equal(rule.limits.max_triggers, -1);
    },
    testValidateRuleSourcePosition(): void {
        const noSource = validateRule(baseRule([{ type: 'counter', n: 3 }]), { scope: {}, now: NOW });
        assert.equal(noSource.ok, false);
        const twoSources = validateRule(baseRule([{ type: 'regex', pattern: 'a' }, { type: 'regex', pattern: 'b' }]), { scope: {}, now: NOW });
        assert.equal(twoSources.ok, false);
    },
    testValidateRuleAutonomousNeedsSessions(): void {
        const result = validateRule(baseRule([{ type: 'active_time', start: '09:00', end: '12:00' }]), { scope: {}, now: NOW });
        assert.equal(result.ok, false);
        assert.ok((result as { ok: false; errors: string[] }).errors.some(e => e.includes('会话列表')));
        // 自主源链后不允许 delay
        const withDelay = validateRule(
            baseRule([{ type: 'active_time', start: '09:00', end: '12:00' }, { type: 'delay', delay_sec: 60 }], { scope: { sessions: ['QQ-Group:1'] } }),
            { scope: { sessions: ['QQ-Group:1'] }, now: NOW },
        );
        assert.equal(withDelay.ok, false);
    },
    testValidateRuleTimerSourceUsesGatePrompts(): void {
        const rule = baseRule([{ type: 'timer', types: 'interval', hours: 12, count: -1, prompts: ['提醒一下'] }]);
        rule.wake_prompts = [];
        rule.scope = { sessions: ['QQ-Group:1'] };
        const result = validateRule(rule, { scope: { sessions: ['QQ-Group:1'] }, knownEvents: ['poke'], now: NOW });
        assert.equal(result.ok, true);
    },
    testValidateRuleUnknownEventRejected(): void {
        const result = validateRule(baseRule([{ type: 'event', on: 'nope' }]), { scope: {}, knownEvents: ['poke'], now: NOW });
        assert.equal(result.ok, false);
    },
    testSummarizeAndPick(): void {
        assert.equal(summarizeGates([{ type: 'regex', pattern: 'x' }, { type: 'counter', n: 2 }]), 'regex(x) → counter(2)');
        assert.equal(pickWakePrompt(['a', 'b'], () => 0.9), 'b');
        assert.equal(pickWakePrompt(undefined), '');
    },
    testScopeAndSkipReason(): void {
        const rule = baseRule([{ type: 'regex', pattern: 'a' }]) as TriggerRule;
        rule.scope = { sessions: ['QQ-Group:1'], exclude: ['QQ-Group:9'] };
        assert.equal(ruleMatchesScope(rule, { sessionId: 'QQ-Group:1' }), true);
        assert.equal(ruleMatchesScope(rule, { sessionId: 'QQ-Group:2' }), false);
        assert.equal(ruleMatchesScope(rule, { sessionId: 'QQ-Group:9' }), false);
        assert.equal(ruleSkipReason(rule, 0, NOW), null);
        rule.limits.max_triggers = 2;
        assert.equal(ruleSkipReason(rule, 2, NOW), 'exhausted');
    },

    // ---------- eval ----------
    testEvalRegexAndCounter(): void {
        const rule = validateRule(
            baseRule([{ type: 'regex', pattern: '考试' }, { type: 'counter', n: 2 }, { type: 'prob', percent: 100 }]),
            { scope: {}, now: NOW },
        );
        assert.equal(rule.ok, true);
        const gates = (rule as { ok: true; rule: TriggerRule }).rule.gates;
        const runtime = createGateRuntime();
        const first = evaluateGates(gates, input({ text: '明天考试' }), runtime);
        assert.equal(first.status, 'fail');
        assert.equal(runtime.counters[1], 1);
        const second = evaluateGates(gates, input({ text: '考试加油' }), runtime);
        assert.equal(second.status, 'pass');
        assert.equal(runtime.counters[1], 0);
    },
    testEvalFailedChainKeepsCounterIncrement(): void {
        const rule = validateRule(
            baseRule([{ type: 'regex', pattern: '考试' }, { type: 'user', ids: ['QQ:999'] }, { type: 'counter', n: 5 }]),
            { scope: {}, now: NOW },
        ) as { ok: true; rule: TriggerRule };
        const runtime = createGateRuntime();
        const result = evaluateGates(rule.rule.gates, input({ text: '考试', userId: 'QQ:1' }), runtime);
        assert.equal(result.status, 'fail');
        // user 门在 counter 之前失败：counter 未执行
        assert.equal(runtime.counters[2], undefined);
    },
    testEvalDelaySuspend(): void {
        const rule = validateRule(
            baseRule([{ type: 'regex', pattern: 'x' }, { type: 'delay', delay_sec: 300 }, { type: 'prob', percent: 100 }]),
            { scope: {}, now: NOW },
        ) as { ok: true; rule: TriggerRule };
        const result = evaluateGates(rule.rule.gates, input({ text: 'x' }), createGateRuntime());
        assert.equal(result.status, 'suspend');
        if (result.status === 'suspend') {
            assert.equal(result.index, 1);
            assert.equal(result.delaySec, 300);
        }
    },
    testEvalTimerNeedsSourceSatisfied(): void {
        const rule = validateRule(
            baseRule([{ type: 'timer', types: 'interval', hours: 12, count: -1, prompts: ['p'] }], { scope: { sessions: ['QQ-Group:1'] } }),
            { scope: { sessions: ['QQ-Group:1'] }, now: NOW },
        ) as { ok: true; rule: TriggerRule };
        assert.equal(evaluateGates(rule.rule.gates, input(), createGateRuntime()).status, 'fail');
        assert.equal(evaluateGates(rule.rule.gates, input({ sourceSatisfied: true }), createGateRuntime()).status, 'pass');
    },
    testEvalProbBoundary(): void {
        const rule = validateRule(baseRule([{ type: 'regex', pattern: 'x' }, { type: 'prob', percent: 50 }]), { scope: {}, now: NOW }) as { ok: true; rule: TriggerRule };
        assert.equal(evaluateGates(rule.rule.gates, input({ text: 'x', random: () => 0.49 }), createGateRuntime()).status, 'pass');
        assert.equal(evaluateGates(rule.rule.gates, input({ text: 'x', random: () => 0.5 }), createGateRuntime()).status, 'fail');
    },
    testGateMetaCoverage(): void {
        const types = Object.keys(GATE_META).sort();
        assert.deepEqual(types, ['active_time', 'counter', 'delay', 'event', 'prob', 'regex', 'timer', 'user']);
        for (const meta of Object.values(GATE_META)) {
            assert.equal(typeof meta.summary, 'function');
        }
    },
    /** 作者修正：@ 触发是触发页配置开关，不再是 `.ai trg` 命令模式 */
    testAtTriggerIsConfigSwitch(): void {
        assert.ok(!MODE_TOKENS.includes('at' as never), 'at 不应出现在命令模式 token 里');
        assert.ok(!MODES.some(mode => mode.token === 'at'), 'at 不应出现在 MODES 里');
        const key = TRIGGER_CONFIG_KEYS.find(item => item.id === 'atTrigger');
        assert.ok(key, '触发页必须有 atTrigger 配置键');
        assert.equal(key!.type, 'boolean');
        assert.equal(key!.default, true, '默认开启');
    },
    /** 别名表按用途域拆分：触发模式 p=prob，命令参数 p=private，互不污染 */
    testAliasScopes(): void {
        assert.equal(modeByToken('p')?.token, 'prob', '`.ai trg p` 应为概率');
        assert.equal(modeByToken('pb'), null, '不再保留双字母 pb');
        for (const [alias, token] of Object.entries({ a: 'active', c: 'counter', d: 'delay', e: 'event', j: 'judge', p: 'prob', r: 'regex', t: 'timer' })) {
            assert.equal(modeByToken(alias)?.token, token, `别名 ${alias} 应映射到 ${token}`);
        }
        assert.deepEqual(resolveCmdChain(['trg', 'p', 'on']), ['trg', 'prob', 'on'], 'trg 模式位走触发模式表');
        assert.deepEqual(resolveCmdChain(['trg', 'rule', 'lst']), ['trg', 'rule', 'list'], '参数动词位走动词表');
        assert.deepEqual(resolveCmdChain(['memo', 'mm', 'lst']), ['memory', 'mm', 'list'], '命令位先归一');
        assert.deepEqual(resolveCmdChain(['memory', 'p']), ['memory', 'private'], '非 trg 的 p 仍是旧 private 语义');
        assert.equal(aliasToCmd('priv'), 'privilege');
        assert.equal(aliasToCmd('md'), 'media');
    },
    /**
     * 回归（4.30.0 `8d810db` 引入）：第 1 段可能是**子命令名**而非动词，
     * 只按动词表归一会让 `.ai tk lst` / `.ai memo lst` / `.ai md list` 等在权限链里保持原值 → 按命令不存在拒绝。
     */
    testAliasChainSubCommandPosition(): void {
        // 9 个命令别名表键：出现在第 1 段（子命令位）时必须归一
        const cases: [string, string][] = [
            ['priv', 'privilege'], ['ses', 'session'], ['memo', 'memory'], ['img', 'image'],
            ['md', 'media'], ['mda', 'media'], ['tk', 'token'], ['ass', 'assistant'],
        ];
        for (const [alias, canonical] of cases) {
            assert.deepEqual(resolveCmdChain(['ai', alias]), ['ai', canonical], `第 1 段 ${alias} 必须归一为 ${canonical}`);
            assert.deepEqual(resolveCmdChain([alias, 'lst']), [canonical, 'list'], `第 0/1 段 ${alias} 都要归一`);
        }
        // 命令表与动词表键不重叠 ⇒ 对第 1 段改用 aliasToCmd 是纯增量（不会改写既有动词解析）
        const cmdKeys = Object.keys(COMMAND_ALIASES).filter(k => k !== 'AI');
        assert.equal(cmdKeys.filter(k => k in VERB_ALIASES).length, 0, '命令表与动词表键必须不重叠');
        for (const [alias, canonical] of Object.entries(VERB_ALIASES)) {
            assert.deepEqual(resolveCmdChain(['model', alias]), ['model', canonical], `动词 ${alias} 仍按动词表归一`);
        }
        // trg 的模式位不受影响（p=prob 而非 private）
        assert.deepEqual(resolveCmdChain(['trg', 'p']), ['trg', 'prob'], 'trg 模式位仍走触发模式表');
        assert.deepEqual(resolveCmdChain(['trg', 'rule', 'lst']), ['trg', 'rule', 'list'], 'trg 深层段仍走动词表');
    },
};
