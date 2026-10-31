// 判定配置（L2）：评分触发参数 String TOML v2 的解析/默认值/有效性判定（唯一事实源）。
//
// 现行判定只需要：主动度/阈值/权重/模型请求/额外 prompt。
// 旧版的 shadow、精力、活跃时间/密度闸门、调用预算、预筛、探针配置全部移除；
// 旧 TOML 里的这些段/键按未知键忽略（不迁移、不报错）。
import { load } from "js-toml";

export interface JudgeDecisionConfigV2 {
    DECISION: { aggressiveness: number };
    SCORING: { speak_threshold: number; wait_cooldown: number };
    WEIGHTS: { addressed: number; help_signal: number; relevance: number; friendships: number; silence_gap: number; interruption_risk: number };
    MODEL: { context_tokens: number; timeout_sec: number; retries: number };
    PROMPT: { extra: string };
}

export interface JudgeConfigState {
    /** v2 配置是否可用（false ⇒ 判定入口直接不发起，其它触发照常） */
    valid: boolean;
    errors: string[];
    config: JudgeDecisionConfigV2;
}

/** 触发页「评分触发参数」默认模板 */
export const JUDGE_TOML_DEFAULT = `# 评分触发参数（TOML v2）。空/非法时判定不可用（其它触发照常）
version = 2

[decision]
aggressiveness = 2             # 1..3

[scoring]
speak_threshold = 0.4
wait_cooldown = 30             # WAIT 挂起窗口秒数（0 = 不进入 WAIT）

[weights]                      # 带符号权重
addressed = 4
help_signal = 3
relevance = 6
friendships = 3
silence_gap = 2
interruption_risk = -1

[model]
context_tokens = 1500          # 0 = 不注入历史
timeout_sec = 8
retries = 2

[prompt]
extra = ""`;

/** 默认值（v2 模板等价；也是解析时逐字段兜底） */
export const DEFAULT_JUDGE_CONFIG: JudgeDecisionConfigV2 = {
    DECISION: { aggressiveness: 2 },
    SCORING: { speak_threshold: 0.4, wait_cooldown: 30 },
    WEIGHTS: { addressed: 4, help_signal: 3, relevance: 6, friendships: 3, silence_gap: 2, interruption_risk: -1 },
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

/** 按默认值逐字段覆盖（类型不符 = 错误；未知键忽略） */
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
 * @param text 原始配置（来自 评分触发参数）；空/语法错误/version≠2 → valid=false
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
    config.WEIGHTS = mergeSection('WEIGHTS', doc.weights, errors);
    config.MODEL = mergeSection('MODEL', doc.model, errors);
    config.PROMPT = mergeSection('PROMPT', doc.prompt, errors);
    if (config.DECISION.aggressiveness < 1 || config.DECISION.aggressiveness > 3) {
        errors.push('[decision] aggressiveness 必须在 1..3');
    }
    if (config.SCORING.speak_threshold < 0 || config.SCORING.speak_threshold > 1) {
        errors.push('[scoring] speak_threshold 必须在 0..1');
    }
    if (!Number.isFinite(config.SCORING.wait_cooldown) || config.SCORING.wait_cooldown < 0) {
        errors.push('[scoring] wait_cooldown 必须 >= 0 秒');
    }
    if (!Number.isInteger(config.MODEL.context_tokens) || config.MODEL.context_tokens < 0) {
        errors.push('[model] context_tokens 必须 >= 0 的整数');
    }
    if (!Number.isFinite(config.MODEL.timeout_sec) || config.MODEL.timeout_sec <= 0) {
        errors.push('[model] timeout_sec 必须 > 0 秒');
    }
    if (!Number.isInteger(config.MODEL.retries) || config.MODEL.retries < 0) {
        errors.push('[model] retries 必须 >= 0 的整数');
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
