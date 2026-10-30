// 判定配置（L2）：`评分触发参数` String TOML v2 的解析/默认值/有效性判定（唯一事实源）。
//
// 方案 §4.8：9 段全参数化；空/非法/旧 v1 → 判定不可用（Q9「没配报错」，不静默用默认值）。
// 读取路径由 configs/trigger.ts 注入原始文本（L2 不摸 seal.ext），保持本文件可单测。
import { load } from "js-toml";

export interface JudgeDecisionConfigV2 {
    DECISION: { shadow: boolean; aggressiveness: number };
    SCORING: { speak_threshold: number; ignore_threshold: number; wait_cooldown: number; ignore_cooldown: number };
    ENERGY: { initial: number; reply_cost: number; recover_min: number };
    WEIGHTS: { addressed: number; help_signal: number; relevance: number; friendships: number; silence_gap: number; interruption_risk: number };
    FEATURES: { interruption_veto: number; density_limit: number };
    GATE: {
        max_calls_per_hour: number;
        call_burst: number;
        min_interval_sec: number;
        debounce_sec: number;
        debounce_max_sec: number;
        prefilter_threshold: number;
    };
    PROBE: { enabled: boolean; first_gap_sec: number; backoff: number; max_gap_sec: number };
    MODEL: { context_tokens: number; timeout_sec: number; retries: number };
    PROMPT: { extra: string };
}

export interface JudgeConfigState {
    /** v2 配置是否可用（false ⇒ 判定入口直接不发起，其它触发照常） */
    valid: boolean;
    errors: string[];
    config: JudgeDecisionConfigV2;
}

/** 触发页「评分触发参数」默认模板（用户配置为空/非法时的修复提示，不自动写回） */
export const JUDGE_TOML_DEFAULT = `# 评分触发参数（TOML v2）。空/非法时判定不可用（其它触发照常）
version = 2

[decision]
shadow = false                 # R2 已切流：新判定内核驱动动作；改 true 可回滚到旧五维判定（仅观测新内核）
aggressiveness = 2             # 1..3

[scoring]
speak_threshold = 0.55
ignore_threshold = 0.35
wait_cooldown = 60             # WAIT 轮秒数（0=不冷却）
ignore_cooldown = 20

[energy]                       # 精力（仅 SPEAK 且真正起轮才扣）
initial = 100
reply_cost = 5
recover_min = 4                # 每 5 分钟懒恢复

[weights]                      # 带符号权重
addressed = 4
help_signal = 2
relevance = 1.5
friendships = 1
silence_gap = 1
interruption_risk = -3

[features]
interruption_veto = 0.8
density_limit = 5

[gate]
max_calls_per_hour = 30
call_burst = 5
min_interval_sec = 5
debounce_sec = 4
debounce_max_sec = 12
prefilter_threshold = 0.5

[probe]
enabled = false
first_gap_sec = 90
backoff = 2
max_gap_sec = 600

[model]
context_tokens = 1500          # 0 = 不注入历史
timeout_sec = 8
retries = 2

[prompt]
extra = ""`;

/** 默认值（v2 模板等价；也是解析时逐字段兜底） */
export const DEFAULT_JUDGE_CONFIG: JudgeDecisionConfigV2 = {
    DECISION: { shadow: false, aggressiveness: 2 },
    SCORING: { speak_threshold: 0.55, ignore_threshold: 0.35, wait_cooldown: 60, ignore_cooldown: 20 },
    ENERGY: { initial: 100, reply_cost: 5, recover_min: 4 },
    WEIGHTS: { addressed: 4, help_signal: 2, relevance: 1.5, friendships: 1, silence_gap: 1, interruption_risk: -3 },
    FEATURES: { interruption_veto: 0.8, density_limit: 5 },
    GATE: { max_calls_per_hour: 30, call_burst: 5, min_interval_sec: 5, debounce_sec: 4, debounce_max_sec: 12, prefilter_threshold: 0.5 },
    PROBE: { enabled: false, first_gap_sec: 90, backoff: 2, max_gap_sec: 600 },
    MODEL: { context_tokens: 1500, timeout_sec: 8, retries: 2 },
    PROMPT: { extra: '' },
};

function cloneDefaults(): JudgeDecisionConfigV2 {
    return JSON.parse(JSON.stringify(DEFAULT_JUDGE_CONFIG)) as JudgeDecisionConfigV2;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

type SectionKey = keyof JudgeDecisionConfigV2;

/** 按默认值逐字段覆盖（类型不符 = 错误；未知键忽略，等价 revive 的丢弃语义） */
function mergeSection<K extends SectionKey>(name: K, raw: unknown, errors: string[]): JudgeDecisionConfigV2[K] {
    const target = cloneDefaults()[name] as Record<string, unknown>;
    if (raw === undefined) return target as JudgeDecisionConfigV2[K];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push(`[${String(name).toLowerCase()}] 必须是表（section）`);
        return target as JudgeDecisionConfigV2[K];
    }
    for (const key of Object.keys(target)) {
        const value = (raw as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const expect = typeof target[key];
        if (expect === 'number') {
            if (!isFiniteNumber(value)) {
                errors.push(`[${String(name).toLowerCase()}] ${key} 必须是数字`);
                continue;
            }
            target[key] = value;
        } else if (expect === 'boolean') {
            if (typeof value !== 'boolean') {
                errors.push(`[${String(name).toLowerCase()}] ${key} 必须是布尔值`);
                continue;
            }
            target[key] = value;
        } else if (expect === 'string') {
            if (typeof value !== 'string') {
                errors.push(`[${String(name).toLowerCase()}] ${key} 必须是字符串`);
                continue;
            }
            target[key] = value;
        }
    }
    return target as JudgeDecisionConfigV2[K];
}

/**
 * 解析 v2 TOML 文本。
 * @param text 原始配置（来自 `评分触发参数`）；空/语法错误/version≠2 → valid=false
 */
export function parseJudgeConfig(text: string): JudgeConfigState {
    const errors: string[] = [];
    const config = cloneDefaults();
    const source = String(text ?? '').trim();
    if (!source) {
        return { valid: false, errors: ['未配置「评分触发参数」（请从触发页粘贴默认 v2 模板）'], config };
    }
    let doc: Record<string, unknown>;
    try {
        doc = load(source) as Record<string, unknown>;
    } catch (e) {
        return { valid: false, errors: [`TOML 解析失败：${e instanceof Error ? e.message : String(e)}`], config };
    }
    if (doc.version !== 2) {
        return { valid: false, errors: ['配置缺少 version = 2（旧版 v1 参数不迁移，请粘贴 v2 模板）'], config };
    }
    config.DECISION = mergeSection('DECISION', doc.decision, errors);
    config.SCORING = mergeSection('SCORING', doc.scoring, errors);
    config.ENERGY = mergeSection('ENERGY', doc.energy, errors);
    config.WEIGHTS = mergeSection('WEIGHTS', doc.weights, errors);
    config.FEATURES = mergeSection('FEATURES', doc.features, errors);
    config.GATE = mergeSection('GATE', doc.gate, errors);
    config.PROBE = mergeSection('PROBE', doc.probe, errors);
    config.MODEL = mergeSection('MODEL', doc.model, errors);
    config.PROMPT = mergeSection('PROMPT', doc.prompt, errors);
    // 关键范围校验：主动度仅 1..3，阈值 0..1
    if (config.DECISION.aggressiveness < 1 || config.DECISION.aggressiveness > 3) {
        errors.push('[decision] aggressiveness 必须在 1..3');
    }
    for (const key of ['speak_threshold', 'ignore_threshold'] as const) {
        const value = config.SCORING[key];
        if (value < 0 || value > 1) errors.push(`[scoring] ${key} 必须在 0..1`);
    }
    return { valid: errors.length === 0, errors, config };
}

let configCache: JudgeConfigState | null = null;

/**
 * 取判定配置（模块级缓存；重载 JS 生效）。调用方传原始文本：L2 不读 seal.ext。
 */
export function getJudgeConfigState(text: string | null | undefined): JudgeConfigState {
    if (configCache) return configCache;
    configCache = parseJudgeConfig(text ?? '');
    return configCache;
}

/** 仅供单元测试使用：清空缓存，模拟重载 JS 后重新解析 */
export function resetJudgeConfigCacheForTest(): void {
    configCache = null;
}
