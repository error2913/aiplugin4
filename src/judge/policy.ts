// 策略层（L2，纯函数）：六维 0~10 原始分直接乘权重，归一化后与阈值比较。
//
// 公式：
//   U    = Σ w_i × dim_i        （dim 取 0~10）
//   maxU = 10 × Σ max(0, w_i)   （所有正权重维度取满分）
//   S    = clamp(U / maxU, 0, 1)
// 阈值只比较 S（0~1）；默认 speak_threshold = 0.6，可由用户配置。
// 模型只给六维分数，不做动作决策；decision/confidence/reason 不属于模型契约。
import type { JudgeDims } from "./features";

/** 判定动作（策略层输出，只有 SPEAK / WAIT） */
export type DecisionAction = 'SPEAK' | 'WAIT';

/** 带符号权重：正 = 支持发言，负 = 压制（默认值见 DEFAULT_POLICY.weights） */
export interface PolicyWeights {
    addressed: number;
    help_signal: number;
    relevance: number;
    friendships: number;
    silence_gap: number;
    interruption_risk: number;
}

/** 策略层全部常量/默认值（TOML 可覆盖但不自动更新） */
export interface PolicyConfig {
    /** 主动度 1~3：只影响 τ_eff */
    aggressiveness: number;
    /** SPEAK 的阈值（默认 0.6，范围 0~1） */
    speak_threshold: number;
    /** 主动度每差 1 档的阈值步长（默认 0.05） */
    aggressiveness_step: number;
    weights: PolicyWeights;
}

/** 所有默认值/常量的唯一出口 */
export const DEFAULT_POLICY: PolicyConfig = {
    aggressiveness: 2,
    speak_threshold: 0.6,
    aggressiveness_step: 0.05,
    weights: {
        addressed: 4,
        help_signal: 2,
        relevance: 1.5,
        friendships: 1,
        silence_gap: 1,
        interruption_risk: -3,
    },
};

/** 打分细节（U/W+/W-/S 全部返回，S 是唯一可比较量） */
export interface ScoreParts {
    /** 未归一化加权和（正权重加分、负权重扣分） */
    U: number;
    /** 正权重和（默认 9.5） */
    Wplus: number;
    /** 负权重绝对值之和（默认 3） */
    Wminus: number;
    /** 归一化总分 S = clamp(U / (10 × Wplus), 0, 1) */
    S: number;
}

/** 生效阈值 */
export interface EffectiveThresholds {
    /** SPEAK 阈值 τ_eff */
    tau: number;
}

/** decide 入参：dims 是 0~10 的六维（已合并规则/模型） */
export interface DecideInput {
    /** 合并后的六维；缺失/非法按 0 处理 */
    dims?: Partial<JudgeDims> | null;
    /** 解析失败/超时/无模型：按失败即 WAIT 直接返回 */
    failed?: boolean;
    /** 权重覆盖（TOML [weights]） */
    weights?: Partial<PolicyWeights>;
    /** 阈值/主动度覆盖（TOML [decision]/[scoring]） */
    policy?: Partial<Omit<PolicyConfig, 'weights'>>;
}

/** decide 结果：S/U 只用于日志 */
export interface DecideResult {
    action: DecisionAction;
    /** 归一化总分（0~1），日志/观测用 */
    S: number;
    /** 未归一化加权和，日志/离线拟合用 */
    U: number;
    /** 稳定原因码（英文 snake_case，便于日志过滤） */
    reason: string;
}

const DIM_KEYS: (keyof JudgeDims)[] = [
    'addressed', 'help_signal', 'relevance', 'friendships', 'silence_gap', 'interruption_risk',
];

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
    return clamp(value, 0, 1);
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

/** 0~10 分数清洗（模型输出/合并结果） */
function sanitizeScores(dims: Partial<JudgeDims> | null | undefined): JudgeDims {
    const out: JudgeDims = {
        addressed: 0,
        help_signal: 0,
        relevance: 0,
        friendships: 0,
        silence_gap: 0,
        interruption_risk: 0,
    };
    if (!dims || typeof dims !== 'object') return out;
    for (const key of DIM_KEYS) {
        const raw = dims[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        out[key] = clamp(raw, 0, 10);
    }
    return out;
}

/** 规则特征清洗：除 friendships 外 0~1，friendships -1~1 */
function sanitizeFeatures(dims: Partial<JudgeDims> | null | undefined): JudgeDims {
    const out: JudgeDims = {
        addressed: 0,
        help_signal: 0,
        relevance: 0,
        friendships: 0,
        silence_gap: 0,
        interruption_risk: 0,
    };
    if (!dims || typeof dims !== 'object') return out;
    for (const key of DIM_KEYS) {
        const raw = dims[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        out[key] = key === 'friendships' ? clamp(raw, -1, 1) : clamp01(raw);
    }
    return out;
}

/** 规则特征 → 0~10（friendships -1~1 → 0~10） */
function featuresToScores(features: Partial<JudgeDims>): JudgeDims {
    const f = sanitizeFeatures(features);
    return {
        addressed: f.addressed * 10,
        help_signal: f.help_signal * 10,
        relevance: f.relevance * 10,
        friendships: (f.friendships + 1) * 5,
        silence_gap: f.silence_gap * 10,
        interruption_risk: f.interruption_risk * 10,
    };
}

/** 合并权重：TOML 部分覆盖 + 默认值；非数值回退默认 */
function resolveWeights(overrides?: Partial<PolicyWeights>): PolicyWeights {
    const out: PolicyWeights = { ...DEFAULT_POLICY.weights };
    if (overrides && typeof overrides === 'object') {
        for (const key of Object.keys(out) as (keyof PolicyWeights)[]) {
            const raw = overrides[key];
            if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
        }
    }
    return out;
}

/** 合并策略配置：阈值/主动度覆盖默认值（weights 单独合并） */
export function resolvePolicy(overrides?: Partial<PolicyConfig>): PolicyConfig {
    const out: PolicyConfig = { ...DEFAULT_POLICY, weights: resolveWeights(overrides?.weights) };
    if (!overrides || typeof overrides !== 'object') return out;
    const numericKeys: (keyof Omit<PolicyConfig, 'weights'>)[] = [
        'aggressiveness',
        'speak_threshold',
        'aggressiveness_step',
    ];
    for (const key of numericKeys) {
        const raw = overrides[key];
        if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    }
    return out;
}

/**
 * 计算 U / W+ / W- / S。
 * S = clamp(U / (10 × W+), 0, 1)：全 0 分 → 0，正权重维度全满分 → 1；负权重直接扣分。
 * W+ 为 0 时保守 S=0（没有正证据 → 不发言）。
 */
export function computeScore(dims: Partial<JudgeDims> | null | undefined, weights?: Partial<PolicyWeights>): ScoreParts {
    const d = sanitizeScores(dims);
    const w = resolveWeights(weights);
    let U = 0;
    let Wplus = 0;
    let Wminus = 0;
    for (const key of DIM_KEYS) {
        const weight = w[key];
        U += weight * d[key];
        if (weight > 0) Wplus += weight;
        else if (weight < 0) Wminus += -weight;
    }
    const maxU = 10 * Wplus;
    const S = maxU > 0 ? clamp01(U / maxU) : 0;
    return { U: round(U, 4), Wplus: round(Wplus, 4), Wminus: round(Wminus, 4), S: round(S, 4) };
}

/**
 * 计算生效阈值：
 *   τ_eff = speak_threshold + (2 - aggressiveness) × 0.05   （默认 0.6）
 * 主动度钳制到 1~3。
 */
export function effectiveThresholds(policy?: PolicyConfig): EffectiveThresholds {
    const cfg = policy ? resolvePolicy(policy) : DEFAULT_POLICY;
    const aggressiveness = clampNumber(cfg.aggressiveness, 1, 3, DEFAULT_POLICY.aggressiveness);
    const tau = round(clamp01(cfg.speak_threshold + (2 - aggressiveness) * cfg.aggressiveness_step), 4);
    return { tau };
}

/**
 * 合并规则特征与模型六维（两者都转为 0~10）：
 * - Addressed：max(规则, 模型)
 * - HelpSignal / Relevance / Friendships / SilenceGap：模型；模型缺维时回退规则值
 * - InterruptionRisk：max(规则, 模型)
 */
export function mergeDims(features: Partial<JudgeDims> | null | undefined, llm?: Partial<JudgeDims> | null): JudgeDims {
    const f = featuresToScores(features || {});
    const raw = llm && typeof llm === 'object' ? llm : null;
    const has = (key: keyof JudgeDims): boolean => {
        const v = raw?.[key];
        return typeof v === 'number' && Number.isFinite(v);
    };
    const pick = (key: keyof JudgeDims, fallback: number): number => {
        if (!has(key)) return fallback;
        return clamp(raw![key] as number, 0, 10);
    };
    return {
        addressed: round(Math.max(f.addressed, has('addressed') ? clamp(raw!.addressed as number, 0, 10) : 0), 4),
        help_signal: round(pick('help_signal', f.help_signal), 4),
        relevance: round(pick('relevance', f.relevance), 4),
        friendships: round(pick('friendships', f.friendships), 4),
        silence_gap: round(pick('silence_gap', f.silence_gap), 4),
        interruption_risk: round(Math.max(f.interruption_risk, has('interruption_risk') ? clamp(raw!.interruption_risk as number, 0, 10) : 0), 4),
    };
}

/**
 * 唯一判定入口：失败/无数据 → WAIT；S >= τ → SPEAK；否则 WAIT。
 * 纯函数：不读配置、不写状态、不起轮。
 */
export function decide(input: DecideInput): DecideResult {
    const policy = resolvePolicy({ ...(input.policy || {}), weights: resolveWeights(input.weights) });
    const dims = sanitizeScores(input.dims);
    const score = computeScore(dims, policy.weights);
    const { tau } = effectiveThresholds(policy);
    const failed = input.failed === true || !input.dims || typeof input.dims !== 'object';
    if (failed) {
        return { action: 'WAIT', S: score.S, U: score.U, reason: 'failure' };
    }
    if (score.S >= tau) {
        return { action: 'SPEAK', S: score.S, U: score.U, reason: 'threshold:speak' };
    }
    return { action: 'WAIT', S: score.S, U: score.U, reason: 'threshold:wait' };
}
