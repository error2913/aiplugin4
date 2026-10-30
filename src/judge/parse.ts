// 模型输出解析（L2，纯函数，永不抛异常）。
//
// 三档容错（对应方案 §4.7 的 json_schema → json_object → 纯提示词降级后的实际响应形态）：
//   1. 纯 JSON：整段就是一个 JSON 对象；
//   2. ```json 围栏：模型习惯性包 Markdown 代码块；
//   3. 文本中截取首个**平衡**的 `{...}`：容忍前后解释文字与 JSON 字符串内的花括号。
// 校验口径：dims 六键数值（0~1，friendships -1~1）越界钳制、缺维补 0、未知键忽略；
// decision/confidence 枚举非法 = 视为未提供（交回策略层走阈值链）；evidence 只保留、不参与决策。
// 失败返回 {ok:false,error}，由调用方按「失败即 WAIT」处理（方案 §6.1 设计原则 3）。
import type { JudgeDims } from "./features";
import type { DecisionAction, DecisionConfidence } from "./policy";

/** dims 的六个键（顺序与输出契约一致） */
export const JUDGE_DIM_KEYS: (keyof JudgeDims)[] = [
    'addressed', 'help_signal', 'relevance', 'friendships', 'silence_gap', 'interruption_risk',
];

/** reason 最大保留字符数（一句话理由，防模型输出超长日志） */
export const REASON_MAX_CHARS = 200;

/** evidence 最多保留条数 */
export const EVIDENCE_MAX_ITEMS = 20;

/** 解析成功后的判决（decision/confidence 缺失 = 该模型是纯评分型） */
export interface ParsedDecision {
    /** 六维（缺维补 0，越界钳制） */
    dims: JudgeDims;
    /** 模型 decision；非法/缺失为 undefined */
    decision?: DecisionAction;
    /** 模型 confidence；非法/缺失为 undefined */
    confidence?: DecisionConfidence;
    /** 一句话理由（截断到 REASON_MAX_CHARS） */
    reason: string;
    /** 证据消息序号（只进日志，不参与决策） */
    evidence: number[];
}

/** 解析来源（日志用：json_schema 档稳定时 source=json，纯提示词档多为 embedded） */
export type ParseSource = 'json' | 'fenced' | 'embedded';

export type ParseDecisionResult =
    | { ok: true; value: ParsedDecision; source: ParseSource }
    | { ok: false; error: string };

/** 全 0 六维（缺维补齐/失败兜底的同一形状） */
export function emptyJudgeDims(): JudgeDims {
    return {
        addressed: 0,
        help_signal: 0,
        relevance: 0,
        friendships: 0,
        silence_gap: 0,
        interruption_risk: 0,
    };
}

/** 数值兜底：number 直接取；数字字符串（模型常见 "0.6"）转换；其余 NaN */
function toFiniteNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
}

/** 从文本中截取首个平衡的 {...}（跳过字符串内的花括号与转义） */
function extractFirstBalancedObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/** 归一化 dims：支持契约的 {dims:{...}}，也兼容旧评分型模型把维度平铺在顶层 */
function normalizeDims(obj: Record<string, unknown>): JudgeDims {
    const dims: JudgeDims = emptyJudgeDims();
    const wrapped = obj.dims;
    const source = wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
        ? wrapped as Record<string, unknown>
        : obj;
    for (const key of JUDGE_DIM_KEYS) {
        const num = toFiniteNumber(source[key]);
        if (!Number.isFinite(num)) continue; // 缺维/非法 → 保持 0
        dims[key] = key === 'friendships'
            ? Math.min(1, Math.max(-1, num))
            : Math.min(1, Math.max(0, num));
    }
    return dims;
}

/** decision 枚举：大小写不敏感；非法 = undefined（交回策略层） */
function normalizeDecision(value: unknown): DecisionAction | undefined {
    if (typeof value !== 'string') return undefined;
    const upper = value.trim().toUpperCase();
    if (upper === 'SPEAK' || upper === 'WAIT' || upper === 'IGNORE') return upper;
    return undefined;
}

/** confidence 枚举：大小写不敏感；非法 = undefined（低置信度地板不抬高） */
function normalizeConfidence(value: unknown): DecisionConfidence | undefined {
    if (typeof value !== 'string') return undefined;
    const lower = value.trim().toLowerCase();
    if (lower === 'low' || lower === 'medium' || lower === 'high') return lower;
    return undefined;
}

/** reason：仅字符串保留；截断到 REASON_MAX_CHARS */
function normalizeReason(value: unknown): string {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return text.length > REASON_MAX_CHARS ? text.slice(0, REASON_MAX_CHARS) : text;
}

/** evidence：仅有限数值保留（截断取整、非负、去重），最多 EVIDENCE_MAX_ITEMS 条 */
function normalizeEvidence(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    const out: number[] = [];
    for (const item of value) {
        const num = toFiniteNumber(item);
        if (!Number.isFinite(num) || num < 0) continue;
        const index = Math.trunc(num);
        if (!out.includes(index)) out.push(index);
        if (out.length >= EVIDENCE_MAX_ITEMS) break;
    }
    return out;
}

/** 把已 JSON.parse 的对象归一化成 ParsedDecision（不校验外层形状，由调用方保证） */
function normalizeDecisionObject(value: unknown): ParsedDecision {
    const obj = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    return {
        dims: normalizeDims(obj),
        decision: normalizeDecision(obj.decision),
        confidence: normalizeConfidence(obj.confidence),
        reason: normalizeReason(obj.reason),
        evidence: normalizeEvidence(obj.evidence),
    };
}

/**
 * 解析模型原始响应。永不抛异常：任何错误都收敛成 {ok:false,error}。
 * 空的 dims 包裹对象（如 `{}`）仍算解析成功——缺维补 0 后由策略层保守 WAIT/IGNORE。
 */
export function parseDecision(raw: string): ParseDecisionResult {
    try {
        const text = String(raw ?? '').trim();
        if (!text) return { ok: false, error: 'empty response' };

        // 依次尝试三档：纯 JSON → 围栏 → 文本内首个平衡对象
        const attempts: { source: ParseSource; body: string }[] = [];
        if (text.startsWith('{')) attempts.push({ source: 'json', body: text });
        const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
        if (fence) attempts.push({ source: 'fenced', body: fence[1].trim() });
        const balanced = extractFirstBalancedObject(text);
        if (balanced) attempts.push({ source: 'embedded', body: balanced });

        if (attempts.length === 0) return { ok: false, error: 'no JSON object found' };

        let lastError = '';
        for (const attempt of attempts) {
            try {
                const parsed = JSON.parse(attempt.body);
                return { ok: true, value: normalizeDecisionObject(parsed), source: attempt.source };
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
            }
        }
        return { ok: false, error: lastError || 'no valid JSON object' };
    } catch (e) {
        // 理论上到不了这里；保留兜底以满足「禁止抛异常」的契约
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
