// M1-B 单测：judge 判定内核纯能力层（features / policy / parse / context_select / prompt）。
// 为什么单独成文件：这些模块是零 LLM 纯函数，可在无 seal 环境下直接跑；M3 接线前先把
// 数学口径（S/U/τ/floor）、优先级链、三档解析与 token 预算选择钉死，避免接线时才发现语义漂移。
// 注意：本文件**不注册**到 scripts/test-unit.cjs（由 Lead 统一注册），导出 `tests` 供其收集。
import assert from 'node:assert/strict';

import { FALLBACK_PROMPT_TEXTS, getPromptTexts, setPromptTexts } from '../src/core/ports/prompt_texts';
import { selectHistoryByTokens } from '../src/judge/context_select';
import { extractFeatures, FEATURE_WINDOWS } from '../src/judge/features';
import type { JudgeContextMessage, JudgeDims } from '../src/judge/features';
import { parseDecision } from '../src/judge/parse';
import {
    computeScore,
    decide,
    DEFAULT_POLICY,
    effectiveThresholds,
    mergeDims,
} from '../src/judge/policy';
import type { PolicyWeights } from '../src/judge/policy';
import { buildDecisionRequest, buildJudgeMessages } from '../src/judge/prompt';

const ZERO_DIMS: JudgeDims = {
    addressed: 0,
    help_signal: 0,
    relevance: 0,
    friendships: 0,
    silence_gap: 0,
    interruption_risk: 0,
};

/** 只留 addressed 权重：让 S = addressed，便于精确断言阈值/floor */
const ONLY_ADDRESSED_WEIGHTS: PolicyWeights = {
    addressed: 1,
    help_signal: 0,
    relevance: 0,
    friendships: 0,
    silence_gap: 0,
    interruption_risk: 0,
};

const ZERO_WEIGHTS: PolicyWeights = {
    addressed: 0,
    help_signal: 0,
    relevance: 0,
    friendships: 0,
    silence_gap: 0,
    interruption_risk: 0,
};

function dims(partial: Partial<JudgeDims> = {}): JudgeDims {
    return { ...ZERO_DIMS, ...partial };
}

function near(actual: number, expected: number, message: string): void {
    assert.ok(Math.abs(actual - expected) < 1e-3, `${message}: 实际 ${actual}，期望 ${expected}`);
}

/** 本地时间 2026-01-01 12:00（正午，活跃窗口 10:00-14:00 内；不依赖运行时区，构造即本地正午） */
const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime();

function msg(role: string, text: string, extra: Partial<JudgeContextMessage> = {}): JudgeContextMessage {
    return { role, text, ...extra };
}

interface FeatureInputPartial {
    messages?: JudgeContextMessage[];
    msgTimes?: number[];
    senderIds?: (string | undefined)[];
    isGroup?: boolean;
    activeWindow?: { startMin: number; endMin: number };
    candidate?: JudgeContextMessage;
    botNames?: string[];
    roleSetting?: string;
    now?: number;
}

function featureInput(partial: FeatureInputPartial = {}) {
    return {
        messages: partial.messages ?? [],
        msgTimes: partial.msgTimes ?? [],
        senderIds: partial.senderIds ?? [],
        botId: 'QQ:bot',
        isGroup: partial.isGroup !== false,
        now: partial.now ?? NOW,
        activeWindow: partial.activeWindow,
        candidate: partial.candidate,
        botNames: partial.botNames,
        roleSetting: partial.roleSetting,
    };
}

export const tests = {
    // ------------------------------------------------------------------
    // policy：S = (U + W-)/(W+ + W-)，所有阈值只比 S
    // ------------------------------------------------------------------

    /** 默认权重 + 全 0 维度：U=0, W+=9.5, W-=3, S=3/12.5=0.24 */
    testPolicyComputeScoreDefault(): void {
        const score = computeScore(ZERO_DIMS);
        near(score.U, 0, 'U');
        near(score.Wplus, 9.5, 'W+');
        near(score.Wminus, 3, 'W-');
        near(score.S, 0.24, 'S');
    },

    /** 全 1 维度（interruption_risk 取 1 时权重 -3）：U=6.5, S=(6.5+3)/12.5=0.76 */
    testPolicyComputeScoreAllOnes(): void {
        const score = computeScore(dims({
            addressed: 1, help_signal: 1, relevance: 1, friendships: 1, silence_gap: 1, interruption_risk: 1,
        }));
        near(score.U, 6.5, 'U');
        near(score.S, 0.76, 'S');
    },

    /** S 必须钳制在 0~1（U 可以越界，S 不行） */
    testPolicyComputeScoreClamps(): void {
        const lowest = computeScore(dims({ interruption_risk: 1 }));
        near(lowest.U, -3, '最低 U');
        near(lowest.S, 0, '最低 S');
        const highest = computeScore(dims({
            addressed: 1, help_signal: 1, relevance: 1, friendships: 1, silence_gap: 1,
        }));
        near(highest.U, 9.5, '最高 U');
        near(highest.S, 1, '最高 S');
    },

    /** 自定义权重：W+ 只由正权重算，S 随 addressed 线性（权重 [2,0,0,0,0,0]） */
    testPolicyComputeScoreCustomWeights(): void {
        const weights: PolicyWeights = { ...ZERO_WEIGHTS, addressed: 2 };
        const half = computeScore(dims({ addressed: 0.5 }), weights);
        near(half.Wplus, 2, 'W+');
        near(half.Wminus, 0, 'W-');
        near(half.S, 0.5, 'S');
    },

    /** 权重全 0：分母为 0 时保守 S=0（没有证据 = 不发言） */
    testPolicyComputeScoreZeroWeights(): void {
        const score = computeScore(dims({ addressed: 1 }), ZERO_WEIGHTS);
        near(score.S, 0, 'S');
    },

    /** τ_eff = 0.55 + (2-aggr)*0.05；floor = τ-0.10；主动度钳制 1~3 */
    testPolicyEffectiveThresholds(): void {
        const d = effectiveThresholds();
        near(d.tau, 0.55, '默认 τ');
        near(d.floor, 0.45, '默认 floor');
        const aggressive = effectiveThresholds({ ...DEFAULT_POLICY, aggressiveness: 1 });
        near(aggressive.tau, 0.6, 'aggr=1 τ');
        near(aggressive.floor, 0.5, 'aggr=1 floor');
        const passive = effectiveThresholds({ ...DEFAULT_POLICY, aggressiveness: 3 });
        near(passive.tau, 0.5, 'aggr=3 τ');
        near(passive.floor, 0.4, 'aggr=3 floor');
        near(effectiveThresholds({ ...DEFAULT_POLICY, aggressiveness: 0 }).tau, 0.6, '越界下界钳制');
        near(effectiveThresholds({ ...DEFAULT_POLICY, aggressiveness: 9 }).tau, 0.5, '越界上界钳制');
    },

    /** 硬否决：interruption_risk ≥ veto(0.8) → WAIT，即使模型 decision=SPEAK */
    testPolicyVetoInterruptionRisk(): void {
        const below = decide({
            dims: dims({ addressed: 1 }),
            decision: 'SPEAK',
            hard: { interruptionRisk: 0.79 },
        });
        assert.equal(below.action, 'SPEAK');
        const vetoed = decide({
            dims: dims({ addressed: 1 }),
            decision: 'SPEAK',
            hard: { interruptionRisk: 0.8 },
        });
        assert.equal(vetoed.action, 'WAIT');
        assert.equal(vetoed.veto, 'interruption_risk');
        assert.equal(vetoed.reason, 'hard:interruption_risk');
    },

    /** 硬否决：精力/冷却/忙/计时器挂起/WAIT 轮 → 全部不 SPEAK */
    testPolicyHardVetoFlags(): void {
        const cases: { flag: 'energy' | 'inCooldown' | 'busy' | 'pendingTimer' | 'waitRound'; expected: string }[] = [
            { flag: 'energy', expected: 'no_energy' },
            { flag: 'inCooldown', expected: 'cooldown' },
            { flag: 'busy', expected: 'busy' },
            { flag: 'pendingTimer', expected: 'timer_pending' },
            { flag: 'waitRound', expected: 'wait_round' },
        ];
        for (const item of cases) {
            const hard = item.flag === 'energy' ? { energy: 0 } : { [item.flag]: true };
            const result = decide({ dims: dims({ addressed: 1 }), decision: 'SPEAK', hard });
            assert.equal(result.action, 'WAIT', item.flag);
            assert.equal(result.veto, item.expected, item.flag);
        }
        // 精力 > 0 不否决
        const ok = decide({ dims: dims({ addressed: 1 }), decision: 'SPEAK', hard: { energy: 0.5 } });
        assert.equal(ok.action, 'SPEAK');
    },

    /** 模型 SPEAK 需过收益地板：S=0.5 ≥ floor(0.45) 但 < τ(0.55) 仍 SPEAK */
    testPolicyModelSpeakPassesFloorBelowTau(): void {
        const result = decide({ dims: dims({ addressed: 0.5 }), decision: 'SPEAK', weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(result.action, 'SPEAK');
        assert.equal(result.reason, 'model:speak');
    },

    /** 模型 SPEAK 低于地板 → WAIT(floor_fail)；低置信度地板 +0.05 */
    testPolicyModelSpeakFloorFail(): void {
        const fail = decide({ dims: dims({ addressed: 0.4 }), decision: 'SPEAK', weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(fail.action, 'WAIT');
        assert.equal(fail.reason, 'floor_fail');
        // 0.48 在默认 floor(0.45) 上但低于低置信度地板(0.50) → WAIT
        const low = decide({
            dims: dims({ addressed: 0.48 }),
            decision: 'SPEAK',
            confidence: 'low',
            weights: ONLY_ADDRESSED_WEIGHTS,
        });
        assert.equal(low.action, 'WAIT');
        assert.equal(low.reason, 'floor_fail');
        const medium = decide({
            dims: dims({ addressed: 0.48 }),
            decision: 'SPEAK',
            confidence: 'medium',
            weights: ONLY_ADDRESSED_WEIGHTS,
        });
        assert.equal(medium.action, 'SPEAK');
    },

    /** 模型 IGNORE/WAIT 直通（不看 S 高低） */
    testPolicyDecisionPassthrough(): void {
        const ignore = decide({ dims: dims({ addressed: 1 }), decision: 'IGNORE', weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(ignore.action, 'IGNORE');
        assert.equal(ignore.reason, 'model:ignore');
        const wait = decide({ dims: dims({ addressed: 1 }), decision: 'WAIT', weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(wait.action, 'WAIT');
        assert.equal(wait.reason, 'model:wait');
    },

    /** 无 decision（纯评分型）：S≥τ SPEAK / S<ignore_threshold IGNORE / 其余 WAIT */
    testPolicyNoDecisionThresholds(): void {
        const speak = decide({ dims: dims({ addressed: 0.9 }), weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(speak.action, 'SPEAK');
        assert.equal(speak.reason, 'threshold:speak');
        const ignore = decide({ dims: dims({ addressed: 0.1 }), weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(ignore.action, 'IGNORE');
        assert.equal(ignore.reason, 'threshold:ignore');
        const wait = decide({ dims: dims({ addressed: 0.5 }), weights: ONLY_ADDRESSED_WEIGHTS });
        assert.equal(wait.action, 'WAIT');
        assert.equal(wait.reason, 'threshold:wait');
    },

    /** 失败/无 dims → 失败即 WAIT（即使模型 decision=SPEAK） */
    testPolicyFailureWaits(): void {
        const failed = decide({ failed: true, decision: 'SPEAK' });
        assert.equal(failed.action, 'WAIT');
        assert.equal(failed.reason, 'failure');
        const noDims = decide({});
        assert.equal(noDims.action, 'WAIT');
        assert.equal(noDims.reason, 'failure');
    },

    /** mergeDims：Addressed/Interruption max，Help/Relevance 只取 LLM，Friendships/SilenceGap 只取规则 */
    testPolicyMergeDimsAuthority(): void {
        const features = dims({
            addressed: 0.2, help_signal: 0.1, relevance: 0.2, friendships: 0.3, silence_gap: 0.4, interruption_risk: 0.1,
        });
        const merged = mergeDims(features, {
            addressed: 0.9, help_signal: 0.8, relevance: 0.7, friendships: -1, silence_gap: 0, interruption_risk: 0.95,
        });
        near(merged.addressed, 0.9, 'addressed=max');
        near(merged.help_signal, 0.8, 'help=llm');
        near(merged.relevance, 0.7, 'relevance=llm');
        near(merged.friendships, 0.3, 'friendships=rule');
        near(merged.silence_gap, 0.4, 'silence_gap=rule');
        near(merged.interruption_risk, 0.95, 'interruption=max');
        // 无 LLM：只有规则值；Help/Relevance 记 0
        const ruleOnly = mergeDims(features);
        near(ruleOnly.addressed, 0.2, '仅规则 addressed');
        near(ruleOnly.help_signal, 0, '仅规则 help');
        near(ruleOnly.relevance, 0, '仅规则 relevance');
        near(ruleOnly.interruption_risk, 0.1, '仅规则 interruption');
    },

    // ------------------------------------------------------------------
    // parse：三档容错 + 范围钳制 + 永不抛异常
    // ------------------------------------------------------------------

    /** 纯 JSON：全部字段正常读取 */
    testParsePureJson(): void {
        const raw = JSON.stringify({
            dims: {
                addressed: 0.8, help_signal: 0.4, relevance: 0.3, friendships: 0.2, silence_gap: 0.1, interruption_risk: 0.6,
            },
            decision: 'SPEAK',
            confidence: 'high',
            reason: '在问 bot 问题',
            evidence: [0, 2],
        });
        const result = parseDecision(raw);
        assert.ok(result.ok);
        if (!result.ok) return;
        assert.equal(result.source, 'json');
        near(result.value.dims.addressed, 0.8, 'addressed');
        assert.equal(result.value.decision, 'SPEAK');
        assert.equal(result.value.confidence, 'high');
        assert.equal(result.value.reason, '在问 bot 问题');
        assert.deepEqual(result.value.evidence, [0, 2]);
    },

    /** ```json 围栏：source=fenced */
    testParseFencedJson(): void {
        const raw = '```json\n{"dims":{"addressed":0.5},"decision":"WAIT"}\n```';
        const result = parseDecision(raw);
        assert.ok(result.ok);
        if (!result.ok) return;
        assert.equal(result.source, 'fenced');
        near(result.value.dims.addressed, 0.5, 'addressed');
        assert.equal(result.value.decision, 'WAIT');
    },

    /** 文本中截取首个平衡对象：JSON 字符串内的花括号不影响配对 */
    testParseEmbeddedBalancedObject(): void {
        const raw = '好的，结果如下：{"dims":{"addressed":0.6},"decision":"SPEAK","reason":"他说的是 { 主题 } 相关"} 请查收';
        const result = parseDecision(raw);
        assert.ok(result.ok);
        if (!result.ok) return;
        assert.equal(result.source, 'embedded');
        near(result.value.dims.addressed, 0.6, 'addressed');
        assert.ok(result.value.reason.includes('{ 主题 }'));
    },

    /** 缺维补 0（只给一个维度） */
    testParseMissingDimsZero(): void {
        const result = parseDecision('{"dims":{"addressed":0.5}}');
        assert.ok(result.ok);
        if (!result.ok) return;
        near(result.value.dims.addressed, 0.5, 'addressed');
        for (const key of Object.keys(ZERO_DIMS) as (keyof JudgeDims)[]) {
            if (key === 'addressed') continue;
            near(result.value.dims[key], 0, key);
        }
        assert.equal(result.value.decision, undefined);
        assert.equal(result.value.confidence, undefined);
    },

    /** 范围钳制：0~1；friendships -1~1；数字字符串可接受 */
    testParseClampsRanges(): void {
        const raw = '{"dims":{"addressed":2,"help_signal":-0.5,"relevance":"0.7","friendships":-2,"silence_gap":9,"interruption_risk":"x"}}';
        const result = parseDecision(raw);
        assert.ok(result.ok);
        if (!result.ok) return;
        near(result.value.dims.addressed, 1, 'addressed 上钳');
        near(result.value.dims.help_signal, 0, 'help_signal 下钳');
        near(result.value.dims.relevance, 0.7, 'relevance 数字字符串');
        near(result.value.dims.friendships, -1, 'friendships 下钳');
        near(result.value.dims.silence_gap, 1, 'silence_gap 上钳');
        near(result.value.dims.interruption_risk, 0, '非法数值补 0');
    },

    /** 枚举非法 = 视为未提供；大小写不敏感 */
    testParseInvalidEnums(): void {
        const invalid = parseDecision('{"dims":{},"decision":"MAYBE","confidence":"sure"}');
        assert.ok(invalid.ok);
        if (!invalid.ok) return;
        assert.equal(invalid.value.decision, undefined);
        assert.equal(invalid.value.confidence, undefined);
        const lower = parseDecision('{"dims":{},"decision":"speak","confidence":"HIGH"}');
        assert.ok(lower.ok);
        if (!lower.ok) return;
        assert.equal(lower.value.decision, 'SPEAK');
        assert.equal(lower.value.confidence, 'high');
    },

    /** evidence：只保留非负有限数值、去重、最多 20 条 */
    testParseEvidenceFiltered(): void {
        const raw = '{"dims":{},"evidence":[1,"2",-3,"x",2.7,1]}';
        const result = parseDecision(raw);
        assert.ok(result.ok);
        if (!result.ok) return;
        assert.deepEqual(result.value.evidence, [1, 2]);
        const many = JSON.stringify({ dims: {}, evidence: Array.from({ length: 30 }, (_, i) => i) });
        const capped = parseDecision(many);
        assert.ok(capped.ok);
        if (!capped.ok) return;
        assert.equal(capped.value.evidence.length, 20);
    },

    /** reason：非字符串记空串；超长截断到 200 字符 */
    testParseReasonNormalized(): void {
        const nonString = parseDecision('{"dims":{},"reason":42}');
        assert.ok(nonString.ok);
        if (!nonString.ok) return;
        assert.equal(nonString.value.reason, '');
        const long = parseDecision(JSON.stringify({ dims: {}, reason: 'x'.repeat(500) }));
        assert.ok(long.ok);
        if (!long.ok) return;
        assert.equal(long.value.reason.length, 200);
    },

    /** 未知键忽略；兼容旧评分型模型把维度平铺在顶层 */
    testParseUnknownKeysAndFlatDims(): void {
        const raw = '{"addressed":0.4,"decision":"WAIT","unknown_key":{"a":1}}';
        const result = parseDecision(raw);
        assert.ok(result.ok);
        if (!result.ok) return;
        near(result.value.dims.addressed, 0.4, '平铺 addressed');
        assert.equal(result.value.decision, 'WAIT');
    },

    /** 解析失败返回 {ok:false,error}，绝不抛异常 */
    testParseFailureNeverThrows(): void {
        const inputs = ['', '   ', 'not json at all', '{"dims": ', '```json\n{"dims": ', 'null', '[]', '{bad}'];
        for (const raw of inputs) {
            let result: ReturnType<typeof parseDecision> | null = null;
            assert.doesNotThrow(() => {
                result = parseDecision(raw);
            }, `不应抛异常: ${raw}`);
            assert.ok(result && result.ok === false, `应解析失败: ${raw}`);
        }
    },

    // ------------------------------------------------------------------
    // features：窗口计算与边界（15s/60s/5min/10min）
    // ------------------------------------------------------------------

    /** 窗口统计：15s=3、60s=5、5min=7、10min=8，silence=1s，rate=1.4/min */
    testFeaturesWindowCounts(): void {
        const times = [
            NOW - 1000, NOW - 5000, NOW - 14000, NOW - 20000,
            NOW - 59000, NOW - 65000, NOW - 280000, NOW - 330000,
        ];
        const timesSnapshot = [...times];
        const features = extractFeatures(featureInput({
            msgTimes: times,
            senderIds: times.map(() => 'QQ:u1'),
        }));
        assert.equal(features.stats.count15s, 3);
        assert.equal(features.stats.count60s, 5);
        assert.equal(features.stats.count5m, 7);
        near(features.stats.silenceSec, 1, 'silenceSec');
        near(features.stats.ratePerMin, 1.4, 'ratePerMin');
        assert.equal(features.stats.someoneRecent, true);
        // 纯函数：不修改入参顺序
        assert.deepEqual(times, timesSnapshot);
    },

    /** 无消息时间线：统计全 0、在场 false，不抛异常 */
    testFeaturesEmptyInput(): void {
        const features = extractFeatures(featureInput());
        assert.equal(features.stats.count15s, 0);
        assert.equal(features.stats.silenceSec, 0);
        assert.equal(features.stats.someoneRecent, false);
        for (const key of Object.keys(ZERO_DIMS) as (keyof JudgeDims)[]) {
            near(features[key], 0, key);
        }
    },

    /** Addressed：@/引用 1.0 > 词面称呼 0.7 > 追问 0.4 > 0；私聊天然 1.0 */
    testFeaturesAddressed(): void {
        const mention = extractFeatures(featureInput({ candidate: msg('user', '过来一下', { mentionsBot: true }) }));
        near(mention.addressed, 1, 'mention');

        const name = extractFeatures(featureInput({
            candidate: msg('user', '骰娘在吗'),
            botNames: ['骰娘'],
        }));
        near(name.addressed, 0.7, 'name');

        const followUp = extractFeatures(featureInput({
            messages: [msg('user', '刚才那个'), msg('assistant', '我查了规则')],
            candidate: msg('user', '那现在怎么办？'),
        }));
        near(followUp.addressed, 0.4, 'follow-up');

        const none = extractFeatures(featureInput({ candidate: msg('user', '今天天气不错') }));
        near(none.addressed, 0, 'none');

        const privateChat = extractFeatures(featureInput({ isGroup: false, candidate: msg('user', '在吗') }));
        near(privateChat.addressed, 1, 'private');
    },

    /** HelpSignal：问号/疑问词/求助词叠加；明确求助 > 普通陈述 */
    testFeaturesHelpSignal(): void {
        const help = extractFeatures(featureInput({ candidate: msg('user', '这周末有人打本吗？求助') }));
        const plain = extractFeatures(featureInput({ candidate: msg('user', '今天天气不错') }));
        assert.ok(help.help_signal > plain.help_signal, `求助应高于陈述: ${help.help_signal} vs ${plain.help_signal}`);
        assert.ok(help.help_signal >= 0.7);
        assert.ok(plain.help_signal < 0.3);
        assert.ok(help.help_signal <= 1);
    },

    /** Relevance：与角色/话题词面相关 > 无关 */
    testFeaturesRelevance(): void {
        const related = extractFeatures(featureInput({
            candidate: msg('user', '原神深渊怎么打'),
            roleSetting: '原神 深渊 攻略',
        }));
        const unrelated = extractFeatures(featureInput({
            candidate: msg('user', '今天天气不错'),
            roleSetting: '原神 深渊 攻略',
        }));
        assert.ok(related.relevance > unrelated.relevance, `相关应高于无关: ${related.relevance} vs ${unrelated.relevance}`);
        assert.ok(related.relevance > 0);
        assert.ok(unrelated.relevance < 0.1);
    },

    /** Friendships（-1~1）：窗口内熟客 > 陌生人；无 sender 记 0 */
    testFeaturesFriendships(): void {
        const regular = extractFeatures(featureInput({
            messages: [
                msg('user', '在吗', { userId: 'QQ:u1' }),
                msg('user', '问个事', { userId: 'QQ:u1' }),
                msg('assistant', '在的'),
            ],
            candidate: msg('user', '那个规则怎么判', { userId: 'QQ:u1' }),
        }));
        assert.ok(regular.friendships > 0, `熟客应为正: ${regular.friendships}`);
        const stranger = extractFeatures(featureInput({
            candidate: msg('user', '第一次来', { userId: 'QQ:new' }),
        }));
        assert.ok(stranger.friendships < 0, `陌生人应为负: ${stranger.friendships}`);
        const noSender = extractFeatures(featureInput({ candidate: msg('user', '匿名') }));
        near(noSender.friendships, 0, '无 sender');
        for (const value of [regular.friendships, stranger.friendships]) {
            assert.ok(value >= -1 && value <= 1, `friendships 越界: ${value}`);
        }
    },

    /** SilenceGap：热群沉默 2 分钟 ≈ 封顶；刚说完话/空群/窗口外一律 0 */
    testFeaturesSilenceGap(): void {
        const hotTimes: number[] = [];
        for (let i = 0; i < 10; i++) hotTimes.push(NOW - 120000 - i * 30000);
        const hot = extractFeatures(featureInput({
            msgTimes: hotTimes,
            senderIds: hotTimes.map((_, i) => `QQ:u${i}`),
            activeWindow: { startMin: 600, endMin: 840 },
        }));
        assert.ok(hot.silence_gap > 0.5, `热群沉默 2 分钟应偏高: ${hot.silence_gap}`);
        assert.ok(hot.silence_gap <= 1);

        const justSpoke = extractFeatures(featureInput({
            msgTimes: [NOW - 1000],
            activeWindow: { startMin: 600, endMin: 840 },
        }));
        assert.ok(justSpoke.silence_gap < 0.05, `刚说完话应接近 0: ${justSpoke.silence_gap}`);

        const noPresence = extractFeatures(featureInput({
            msgTimes: [NOW - 3600000],
            activeWindow: { startMin: 600, endMin: 840 },
        }));
        near(noPresence.silence_gap, 0, '10 分钟无人');

        const outsideWindow = extractFeatures(featureInput({
            msgTimes: hotTimes,
            activeWindow: { startMin: 0, endMin: 60 },
        }));
        near(outsideWindow.silence_gap, 0, '窗口外');
    },

    /** 活跃时间窗口：支持跨午夜；start==end 视为全天 */
    testFeaturesActiveWindowCrossMidnight(): void {
        const night = new Date(2026, 0, 1, 23, 30, 0).getTime();
        const crossing = extractFeatures(featureInput({
            now: night,
            msgTimes: [night - 1000],
            activeWindow: { startMin: 22 * 60, endMin: 6 * 60 },
        }));
        assert.equal(crossing.stats.inActiveWindow, true);
        const daytime = extractFeatures(featureInput({
            now: night,
            msgTimes: [night - 1000],
            activeWindow: { startMin: 9 * 60, endMin: 18 * 60 },
        }));
        assert.equal(daytime.stats.inActiveWindow, false);
        const allDay = extractFeatures(featureInput({
            now: night,
            activeWindow: { startMin: 0, endMin: 0 },
        }));
        assert.equal(allDay.stats.inActiveWindow, true);
    },

    /** InterruptionRisk：15s 满 5 条（刷屏阈值）即达到默认 veto 0.8；平静群接近 0 */
    testFeaturesInterruptionRisk(): void {
        const burstTimes = [NOW - 1000, NOW - 2000, NOW - 3000, NOW - 4000, NOW - 5000];
        const burst = extractFeatures(featureInput({
            msgTimes: burstTimes,
            senderIds: burstTimes.map(() => 'QQ:spam'),
        }));
        assert.ok(burst.interruption_risk >= DEFAULT_POLICY.interruption_veto,
            `5 条/15s 应达到 veto: ${burst.interruption_risk}`);
        const calm = extractFeatures(featureInput({ msgTimes: [NOW - 600000] }));
        assert.ok(calm.interruption_risk < 0.1, `平静群应接近 0: ${calm.interruption_risk}`);
        const four = extractFeatures(featureInput({
            msgTimes: burstTimes.slice(0, 4),
            senderIds: burstTimes.slice(0, 4).map(() => 'QQ:spam'),
        }));
        assert.ok(four.interruption_risk < DEFAULT_POLICY.interruption_veto, '4 条/15s 不应否决');
    },

    // ------------------------------------------------------------------
    // context_select：token 预算从最新往前
    // ------------------------------------------------------------------

    /** budget<=0 返回空（0 = 不注入历史，不是无限） */
    testContextSelectBudgetZero(): void {
        assert.deepEqual(selectHistoryByTokens(['a', 'b'], 0), []);
        assert.deepEqual(selectHistoryByTokens(['a', 'b'], -5), []);
        assert.deepEqual(selectHistoryByTokens([], 100), []);
    },

    /** 从最新往前累加、超预算截断，返回仍按旧→新 */
    testContextSelectNewestFirst(): void {
        const items = ['a', 'b', 'c', 'd'];
        const picked = selectHistoryByTokens(items, 25, () => 10);
        assert.deepEqual(picked, ['c', 'd']);
        const exact = selectHistoryByTokens(items, 20, () => 10);
        assert.deepEqual(exact, ['c', 'd']);
        const tiny = selectHistoryByTokens(items, 10, () => 10);
        assert.deepEqual(tiny, ['d']);
    },

    /** 缺省估算器：字符串按 estimateTextTokens（'abcd'≈1 token） */
    testContextSelectDefaultEstimator(): void {
        const picked = selectHistoryByTokens(['aaaa', 'bbbb', 'cccc'], 2);
        assert.deepEqual(picked, ['bbbb', 'cccc']);
    },

    /** alwaysKeepLatest：默认保留超预算的最新一条；false 时严格按预算返回空 */
    testContextSelectAlwaysKeepLatest(): void {
        const oversized = [{ text: 'x'.repeat(2000) }];
        const kept = selectHistoryByTokens(oversized, 5, () => 100);
        assert.deepEqual(kept, oversized);
        const strict = selectHistoryByTokens(oversized, 5, () => 100, { alwaysKeepLatest: false });
        assert.deepEqual(strict, []);
        // 非最新条目超预算时始终截断
        const mixed = selectHistoryByTokens([{ text: 'big' }, { text: 'small' }], 5, (item) => (item.text === 'big' ? 100 : 3));
        assert.deepEqual(mixed, [{ text: 'small' }]);
    },

    /** 返回新数组、不修改入参 */
    testContextSelectNoMutation(): void {
        const items = ['a', 'b', 'c'];
        const snapshot = [...items];
        const picked = selectHistoryByTokens(items, 2);
        assert.notEqual(picked, items);
        assert.deepEqual(items, snapshot);
    },

    // ------------------------------------------------------------------
    // prompt：数据装配 + L0 文案端口 + buildDecisionRequest
    // ------------------------------------------------------------------

    /** 默认装配：system 含回退文案，user 含边界/bot/历史/硬特征/当前候选 */
    testPromptBuildDefaults(): void {
        const features = extractFeatures(featureInput({ candidate: msg('user', '骰娘帮我看下') }));
        const built = buildJudgeMessages({
            botName: '骰娘',
            botId: 'QQ:3893625976',
            roleSetting: '一个乐于助人的骰娘',
            globalPrompt: '回答简短一点',
            history: [
                { role: 'user', text: '前一条消息', time: NOW - 60000, userId: 'QQ:u1' },
                { role: 'assistant', text: 'bot 之前说过的话', time: NOW - 50000 },
            ],
            candidate: { role: 'user', text: '骰娘帮我看下', time: NOW, userId: 'QQ:u2' },
            features,
            now: NOW,
        });
        assert.equal(built.messages.length, 2);
        assert.equal(built.messages[0].role, 'system');
        assert.ok(built.system.includes('decision kernel'), 'system 应含回退 judgeSystem');
        assert.ok(built.system.includes('Return exactly one JSON object'), 'system 应含输出规范');
        assert.ok(built.user.startsWith(FALLBACK_PROMPT_TEXTS.judgeDataBoundary().slice(0, 20)), 'user 应先声明数据边界');
        assert.ok(built.user.includes('Bot name: 骰娘'));
        assert.ok(built.user.includes('Bot account: QQ:3893625976'));
        assert.ok(built.user.includes('Bot role setting: 一个乐于助人的骰娘'));
        assert.ok(built.user.includes('Global instructions: 回答简短一点'));
        assert.ok(built.user.includes('前一条消息'));
        assert.ok(built.user.includes('bot 之前说过的话'));
        assert.ok(built.user.includes('"addressed"'), '应注入硬特征 JSON');
        assert.ok(built.user.includes('Current message to evaluate:'));
        assert.ok(built.user.includes('骰娘帮我看下'));
        assert.equal(built.historyCount, 2);
        assert.ok(built.historyTokens > 0);
    },

    /** contextTokens=0：不注入历史，但当前候选仍然注入（独立字段） */
    testPromptContextTokensZero(): void {
        const built = buildJudgeMessages({
            botName: '骰娘',
            history: [{ role: 'user', text: '很老的历史消息', time: NOW - 600000 }],
            candidate: { role: 'user', text: '当前这条', time: NOW },
            contextTokens: 0,
            now: NOW,
        });
        assert.ok(!built.user.includes('很老的历史消息'), 'context_tokens=0 不应注入历史');
        assert.ok(built.user.includes('history injection disabled'));
        assert.ok(built.user.includes('当前这条'), '当前候选必须注入');
        assert.equal(built.historyCount, 0);
    },

    /** 历史按 token 预算裁剪，但当前候选不受影响 */
    testPromptHistoryBudgetTruncation(): void {
        const history = Array.from({ length: 10 }, (_, i) => ({
            role: 'user',
            text: `历史消息第 ${i} 条：${'内容'.repeat(50)}`,
            time: NOW - (10 - i) * 1000,
        }));
        const built = buildJudgeMessages({
            botName: '骰娘',
            history,
            candidate: { role: 'user', text: '当前这条', time: NOW },
            contextTokens: 350,
            now: NOW,
        });
        assert.ok(built.historyCount > 0 && built.historyCount < history.length,
            `预算应裁剪部分历史: ${built.historyCount}/${history.length}`);
        assert.ok(built.user.includes('当前这条'));
        assert.ok(!built.user.includes('历史消息第 0 条'), '最早的历史应被裁掉');
    },

    /** promptExtra 追加到 system 末尾（#145），不覆盖原 system */
    testPromptExtraAppended(): void {
        const built = buildJudgeMessages({
            botName: '骰娘',
            candidate: { role: 'user', text: '在吗', time: NOW },
            promptExtra: 'EXTRA_STYLE_RULE',
            now: NOW,
        });
        assert.ok(built.system.includes('EXTRA_STYLE_RULE'));
        assert.ok(built.system.indexOf('EXTRA_STYLE_RULE') > built.system.indexOf('Return exactly one JSON object'));
    },

    /** L3 注册文案后覆盖回退；清空后回到回退（M2 装配方向） */
    testPromptTextsRegistration(): void {
        assert.equal(getPromptTexts(), FALLBACK_PROMPT_TEXTS);
        try {
            setPromptTexts({
                judgeSystem: () => 'CUSTOM_SYSTEM',
                judgeOutputSpec: () => 'CUSTOM_SPEC',
                judgeDataBoundary: () => 'CUSTOM_BOUNDARY',
            });
            const built = buildJudgeMessages({
                botName: '骰娘',
                candidate: { role: 'user', text: '在吗', time: NOW },
                now: NOW,
            });
            assert.ok(built.system.includes('CUSTOM_SYSTEM'));
            assert.ok(built.system.includes('CUSTOM_SPEC'));
            assert.ok(built.user.startsWith('CUSTOM_BOUNDARY'));
        } finally {
            setPromptTexts(null);
        }
        assert.equal(getPromptTexts(), FALLBACK_PROMPT_TEXTS);
    },

    /** buildDecisionRequest：返回 messages + schema/instruction，不发请求 */
    testPromptDecisionRequest(): void {
        const request = buildDecisionRequest({
            botName: '骰娘',
            candidate: { role: 'user', text: '在吗', time: NOW },
            now: NOW,
        });
        assert.equal(request.messages.length, 2);
        assert.equal(request.expected.schema.type, 'object');
        const properties = request.expected.schema.properties as Record<string, unknown>;
        assert.ok(properties.dims);
        assert.ok(properties.decision);
        assert.ok(properties.confidence);
        assert.ok(request.expected.instruction.length > 0);
        assert.equal(request.historyCount, 0);
    },

    /** 角色设定超长按 token 预算截断（默认 600） */
    testPromptRoleTruncated(): void {
        const role = '角色设定'.repeat(2000);
        const built = buildJudgeMessages({
            botName: '骰娘',
            roleSetting: role,
            candidate: { role: 'user', text: '在吗', time: NOW },
            now: NOW,
        });
        const line = built.user.split('\n').find((item) => item.startsWith('Bot role setting:'));
        assert.ok(line);
        assert.ok((line as string).length < role.length, '角色全文应被截断');
    },

    // ------------------------------------------------------------------
    // 窗口常量：防止后续接线时把口径改飘
    // ------------------------------------------------------------------

    /** 窗口常量与方案一致：15s 密度 / 60s 消息数 / 5min 消息率 / 10min 在场 */
    testFeatureWindowConstants(): void {
        assert.equal(FEATURE_WINDOWS.densityMs, 15 * 1000);
        assert.equal(FEATURE_WINDOWS.recentMs, 60 * 1000);
        assert.equal(FEATURE_WINDOWS.rateMs, 5 * 60 * 1000);
        assert.equal(FEATURE_WINDOWS.presenceMs, 10 * 60 * 1000);
    },
};
