// 策略层（L2，纯函数）：唯一优先级链 + 归一化总分 S。
//
// 量纲唯一约定（方案 §6.3 修正）：LLM 不给总分；`U`（默认约 -3~9.5）只进日志，
// **所有阈值只比较归一化分 S（0~1）**。若拿 U 直接比 0.55，任何微小正证据都会 SPEAK，
// 阈值/主动度/否决全部失效——这是本文件存在的核心原因。
//
// 唯一优先级链（顺序不可调）：
//   1. 硬否决（零 LLM）：interruption_risk ≥ veto / 精力 / 冷却 / 忙 / 计时器挂起 / WAIT 轮 → 不 SPEAK（WAIT）
//   2. 模型 decision 有效：SPEAK 需 S ≥ floor（低置信度地板 +0.05）；WAIT/IGNORE 直通
//   3. 无 decision（纯评分模型）：S ≥ τ → SPEAK；S < ignore_threshold → IGNORE；否则 WAIT
//   4. 失败/无数据 → WAIT（失败即不发言）
// 副作用（起轮/扣精力/写状态）不在这里发生：本层只输出 action 供调用方执行（感知与执行解耦）。
import type { JudgeDims, JudgeFeatures } from "./features";

/** 判定动作（与模型输出枚举一致） */
export type DecisionAction = 'SPEAK' | 'WAIT' | 'IGNORE';

/** 模型置信度（唯一消费点：SPEAK 的收益地板抬高） */
export type DecisionConfidence = 'low' | 'medium' | 'high';

/** 带符号权重：正 = 支持发言，负 = 压制（默认值见 DEFAULT_POLICY.weights） */
export interface PolicyWeights {
    addressed: number;
    help_signal: number;
    relevance: number;
    friendships: number;
    silence_gap: number;
    interruption_risk: number;
}

/** 策略层全部常量/默认值（集中于此，便于审计与离线拟合；TOML 可覆盖但不自动更新） */
export interface PolicyConfig {
    /** 主动度 1~3：只影响 τ_eff / floor_eff（不改进未归一化权重） */
    aggressiveness: number;
    /** 无 decision 时 SPEAK 的阈值（默认 0.55） */
    speak_threshold: number;
    /** 无 decision 时 IGNORE 的阈值（默认 0.35） */
    ignore_threshold: number;
    /** 硬否决阈值：合并后的 interruption_risk ≥ 该值直接 WAIT（默认 0.8） */
    interruption_veto: number;
    /** 收益地板与 τ 的差（默认 0.10） */
    floor_gap: number;
    /** 主动度每差 1 档的阈值步长（默认 0.05） */
    aggressiveness_step: number;
    /** 低置信度时 SPEAK 地板抬高（默认 0.05） */
    low_confidence_bonus: number;
    weights: PolicyWeights;
}

/** 所有默认值/常量的唯一出口 */
export const DEFAULT_POLICY: PolicyConfig = {
    aggressiveness: 2,
    speak_threshold: 0.55,
    ignore_threshold: 0.35,
    interruption_veto: 0.8,
    floor_gap: 0.1,
    aggressiveness_step: 0.05,
    low_confidence_bonus: 0.05,
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
    /** 未归一化加权和（-W- ~ W+），只进日志/离线拟合 */
    U: number;
    /** 正权重和（默认 9.5） */
    Wplus: number;
    /** 负权重绝对值之和（默认 3） */
    Wminus: number;
    /** 归一化总分 S = clamp((U + W-)/(W+ + W-), 0, 1)（默认 (U+3)/12.5） */
    S: number;
}

/** 生效阈值 */
export interface EffectiveThresholds {
    /** 无 decision 时的 SPEAK 阈值 τ_eff */
    tau: number;
    /** 有 decision=SPEAK 时的收益地板 floor_eff = τ_eff - 0.10 */
    floor: number;
}

/** 硬否决输入：全部来自零 LLM 状态（令牌桶不在这里判，由 wake 统一判，见方案 C6/A4） */
export interface DecideHardInput {
    /** 合并后的 interruption_risk（features 与 LLM 取 max）；缺省用 dims.interruption_risk */
    interruptionRisk?: number;
    /** 剩余精力（≤0 = 否决） */
    energy?: number;
    /** 是否处于 IGNORE 短冷却（Addressed 由调用方先绕过再传入） */
    inCooldown?: boolean;
    /** 会话是否忙（在跑/启动中 → 起轮会静默失败，故提前否决） */
    busy?: boolean;
    /** 计时器/延迟是否已挂起（防双触发） */
    pendingTimer?: boolean;
    /** 是否在 WAIT 轮内（只入 pending、不评估；本层仍给 WAIT 作为保守结果） */
    waitRound?: boolean;
}

/** decide 入参：dims 应是「已按 §4.7 权威表合并」的六维（见 mergeDims） */
export interface DecideInput {
    /** 合并后的六维；缺失/非法按 0 处理 */
    dims?: Partial<JudgeDims> | null;
    /** 模型返回的 decision；无/非法 = 纯评分模型路径 */
    decision?: DecisionAction | null;
    /** 模型返回的 confidence；只影响 SPEAK 地板 */
    confidence?: DecisionConfidence | null;
    /** 解析失败/超时/无模型：按「失败即 WAIT」直接返回 */
    failed?: boolean;
    /** 权重覆盖（TOML [weights]） */
    weights?: Partial<PolicyWeights>;
    /** 阈值/主动度覆盖（TOML [decision]/[scoring]/[features]） */
    policy?: Partial<Omit<PolicyConfig, 'weights'>>;
    /** 零 LLM 硬状态 */
    hard?: DecideHardInput;
}

/** decide 结果：S/U 只用于日志；veto 仅硬否决时给出原因码 */
export interface DecideResult {
    action: DecisionAction;
    /** 归一化总分（0~1），日志/观测用 */
    S: number;
    /** 未归一化加权和，日志/离线拟合用 */
    U: number;
    /** 稳定原因码（英文 snake_case，便于日志过滤；不是给用户看的文案） */
    reason: string;
    /** 硬否决原因码（仅硬否决时出现） */
    veto?: string;
}

const DIM_KEYS: (keyof JudgeDims)[] = [
    'addressed', 'help_signal', 'relevance', 'friendships', 'silence_gap', 'interruption_risk',
];

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

/** 六维清洗：非数值 → 0，范围钳制（friendships -1~1，其余 0~1） */
function sanitizeDims(dims: Partial<JudgeDims> | null | undefined): JudgeDims {
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
        out[key] = key === 'friendships' ? Math.min(1, Math.max(-1, raw)) : clamp01(raw);
    }
    return out;
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
        'ignore_threshold',
        'interruption_veto',
        'floor_gap',
        'aggressiveness_step',
        'low_confidence_bonus',
    ];
    for (const key of numericKeys) {
        const raw = overrides[key];
        if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    }
    return out;
}

/**
 * 计算 U / W+ / W- / S。
 * S = clamp((U + W-)/(W+ + W-), 0, 1)：W- 是「全维最差」时的抬升量，保证 S=0 对应全负证据、
 * S=1 对应全正证据；分母为 0（权重全 0）时保守取 0（视为没有证据 → 不发言）。
 */
export function computeScore(dims: Partial<JudgeDims> | null | undefined, weights?: Partial<PolicyWeights>): ScoreParts {
    const d = sanitizeDims(dims);
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
    const denom = Wplus + Wminus;
    const S = denom > 0 ? clamp01((U + Wminus) / denom) : 0;
    return { U: round(U, 4), Wplus: round(Wplus, 4), Wminus: round(Wminus, 4), S: round(S, 4) };
}

/**
 * 计算生效阈值：
 *   τ_eff     = speak_threshold + (2 - aggressiveness) × 0.05   （默认 0.55）
 *   floor_eff = τ_eff - 0.10                                     （默认 0.45）
 * 主动度钳制到 1~3（配置越界按边界处理，不放大/缩小阈值到荒谬区间）。
 */
export function effectiveThresholds(policy?: PolicyConfig): EffectiveThresholds {
    const cfg = policy ? resolvePolicy(policy) : DEFAULT_POLICY;
    const aggressiveness = clampNumber(cfg.aggressiveness, 1, 3, DEFAULT_POLICY.aggressiveness);
    const tau = round(clamp01(cfg.speak_threshold + (2 - aggressiveness) * cfg.aggressiveness_step), 4);
    const floor = round(clamp01(tau - cfg.floor_gap), 4);
    return { tau, floor };
}

/**
 * 按 §4.7「每维唯一权威」合并特征层与 LLM 维度（禁止双算）：
 * - Addressed：max(规则, LLM)
 * - HelpSignal / Relevance：只取 LLM（词面仅预筛）
 * - Friendships / SilenceGap：只取规则（无数据记 0）
 * - InterruptionRisk：max(规则, LLM)，否决用合并值
 */
export function mergeDims(features: Partial<JudgeDims> | null | undefined, llm?: Partial<JudgeDims> | null): JudgeDims {
    const f = sanitizeDims(features);
    const l = sanitizeDims(llm);
    const hasLlm = !!llm && typeof llm === 'object';
    return {
        addressed: round(Math.max(f.addressed, hasLlm ? l.addressed : 0), 4),
        help_signal: round(hasLlm ? l.help_signal : 0, 4),
        relevance: round(hasLlm ? l.relevance : 0, 4),
        friendships: round(f.friendships, 4),
        silence_gap: round(f.silence_gap, 4),
        interruption_risk: round(Math.max(f.interruption_risk, hasLlm ? l.interruption_risk : 0), 4),
    };
}

/** 硬否决：返回原因码；null = 未被硬否决（顺序固定，先到先得） */
function firstHardVeto(input: DecideInput, dims: JudgeDims, policy: PolicyConfig): string | null {
    const hard = input.hard && typeof input.hard === 'object' ? input.hard : {};
    if (hard.waitRound === true) return 'wait_round';
    if (hard.pendingTimer === true) return 'timer_pending';
    if (hard.busy === true) return 'busy';
    if (hard.inCooldown === true) return 'cooldown';
    const energy = hard.energy;
    if (typeof energy === 'number' && Number.isFinite(energy) && energy <= 0) return 'no_energy';
    // 合并后的中断风险：显式传入优先（features 与 LLM 已取 max），否则用 dims
    const risk = hard.interruptionRisk !== undefined && Number.isFinite(hard.interruptionRisk)
        ? hard.interruptionRisk
        : dims.interruption_risk;
    if (Number.isFinite(risk) && risk >= policy.interruption_veto) return 'interruption_risk';
    return null;
}

/**
 * 唯一判定入口：硬否决 → 模型 decision → 阈值/floor → 失败 WAIT。
 * 纯函数：不读配置、不写状态、不起轮（副作用由调用方在拿到 action 后执行）。
 */
export function decide(input: DecideInput): DecideResult {
    // input.policy 只含阈值类覆盖，weights 单独走 input.weights（避免两处都改权重时语义含糊）
    const policy = resolvePolicy({ ...(input.policy || {}), weights: resolveWeights(input.weights) });
    const dims = sanitizeDims(input.dims);
    const score = computeScore(dims, policy.weights);
    const { tau, floor } = effectiveThresholds(policy);
    const failed = input.failed === true || !input.dims || typeof input.dims !== 'object';

    const veto = failed ? null : firstHardVeto(input, dims, policy);
    if (veto) {
        return { action: 'WAIT', S: score.S, U: score.U, reason: `hard:${veto}`, veto };
    }
    if (failed) {
        return { action: 'WAIT', S: score.S, U: score.U, reason: 'failure' };
    }

    const decision = input.decision === 'SPEAK' || input.decision === 'WAIT' || input.decision === 'IGNORE'
        ? input.decision
        : null;

    // 模型 decision 有效即优先：IGNORE/WAIT 直通；SPEAK 还要过「收益地板」防低分硬发言
    if (decision === 'IGNORE') {
        return { action: 'IGNORE', S: score.S, U: score.U, reason: 'model:ignore' };
    }
    if (decision === 'WAIT') {
        return { action: 'WAIT', S: score.S, U: score.U, reason: 'model:wait' };
    }
    if (decision === 'SPEAK') {
        const speakFloor = clamp01(floor + (input.confidence === 'low' ? policy.low_confidence_bonus : 0));
        if (score.S >= speakFloor) {
            return { action: 'SPEAK', S: score.S, U: score.U, reason: 'model:speak' };
        }
        return { action: 'WAIT', S: score.S, U: score.U, reason: 'floor_fail' };
    }

    // 无 decision（纯评分模型）：S 对 τ 与 ignore_threshold 两段比较
    if (score.S >= tau) {
        return { action: 'SPEAK', S: score.S, U: score.U, reason: 'threshold:speak' };
    }
    if (score.S < policy.ignore_threshold) {
        return { action: 'IGNORE', S: score.S, U: score.U, reason: 'threshold:ignore' };
    }
    return { action: 'WAIT', S: score.S, U: score.U, reason: 'threshold:wait' };
}

/** 供测试/日志使用：判断 features 是否具备完整六维（缺 stats 也可） */
export function asDims(features: JudgeFeatures | JudgeDims): JudgeDims {
    return sanitizeDims(features);
}
