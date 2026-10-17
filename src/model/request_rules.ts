// 模型规则：use 组模板 + models 定向模板（body/params/prompt/request/response）。
// 纯模块：不依赖 seal / Config（仅引用静态 body 默认常量），便于单元测试。
//
// 语义：
//   - bodyDefaultsFor(use[, modelRef])  = 代码兜底默认 < 命中规则的 [body]（深合并）；
//     媒体用途（tts / image-generation）不叠代码兜底：结构由「内置预设」提供（见 media_presets），
//     规则写了 [body] 就是**整体替换**预设结构（规则里没写的键不会再从预设漏进请求体）
//   - ruleBodyFor(use[, modelRef])      = 只取命中规则的 [body]（媒体用途判断"是否自行描述结构"用）
//   - requestOverridesFor(use[, ref])   = 命中规则的 [request] 合并
//   - ruleParamsFor(use[, ref])         = 只取命中规则的 [params] 合并（与预设默认合成见 media_template）
//   - promptExtraFor(use[, ref])        = 命中规则的 [prompt].extra 顺序追加
//   - responseRuleFor(use[, ref])       = 命中规则的 [response] 合并（取数路径/类型/轮询）
//
// 命中规则（两趟，后者覆盖前者）：
//   A. use 组：规则未声明 models，且 [use] 含当前用途
//   B. models 定向：规则声明了 models 且命中当前模型（可选的 use 也须命中当前用途）
//   → 即：声明了 models 的行"只对该模型生效"，且优先级高于 use 组
import {
    DEFAULT_CHAT_MODEL_BODY,
    DEFAULT_EMBEDDING_MODEL_BODY,
    DEFAULT_IMAGE_PARAMS,
    DEFAULT_MULTIMODAL_MODEL_BODY,
    DEFAULT_TTS_PARAMS,
} from "../config/static_config";

import { ModelBody, ModelUse } from "./types";

/** 一个媒体参数的元信息（来自「模型规则」[params]） */
export interface MediaParamMeta {
    /** 请求体字段路径提示（仅作文档用途；实际落位由 [body] 里的 {占位符} 决定） */
    field?: string;
    /** 期望类型：string / number / boolean（运行时校验，非法值报错） */
    type?: string;
    default?: unknown;
    min?: number;
    max?: number;
    enum?: unknown[];
    desc?: string;
}

/** 一条模型规则：命中这些 use（或这些 models）的请求使用同一组模板 */
export interface ModelRuleTemplate {
    use: ModelUse[];
    /** models 定向：填写后该行只对这些模型生效（ref 或裸名），优先级高于 use 组 */
    models?: string[];
    body: ModelBody;
    /**
     * v5：媒体用途的 body 与内置预设如何合成。
     *   - 不设（默认）：有规则 body 即**整体替换**预设 —— v4 既有语义
     *   - 'replace'    ：显式声明整体替换
     *   - 'merge'      ：与预设**逐键合并**（保留预设里未覆盖的字段）
     * v4 靠"是不是媒体用途"隐式决定替换；v5 允许显式声明（见 docs/13-模型配置v5方案.md 2.4）。
     */
    bodyMode?: 'merge' | 'replace';
    /** AI 可覆写参数的元信息 */
    params: Record<string, MediaParamMeta>;
    /** 给 AI 的额外自由提示词（[prompt].extra） */
    prompt: Record<string, any>;
    request: Record<string, any>;
    /** 返回取数规则 */
    response: Record<string, any>;
}

let ruleRows: ModelRuleTemplate[] = [];

export function setRuleRows(rows: ModelRuleTemplate[]): void {
    ruleRows = rows;
}

export function getRuleRows(): ModelRuleTemplate[] {
    return ruleRows;
}

/** 用途 → 代码兜底默认请求体（模板未覆盖/用户删光规则行时仍然生效，与旧行为一致） */
function classDefaultBody(use: ModelUse): Record<string, any> {
    if (use === 'text-embedding') return { ...DEFAULT_EMBEDDING_MODEL_BODY };
    if (use === 'image-understanding') return { ...DEFAULT_MULTIMODAL_MODEL_BODY };
    // 媒体用途不叠代码兜底（结构由内置预设提供），见 bodyDefaultsFor
    if (use === 'tts' || use === 'image-generation') return {};
    // chat / compression / summarization / judge 共用对话默认
    return { ...DEFAULT_CHAT_MODEL_BODY };
}

function isPlainObject(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function mergeInto(target: any, src: any): any {
    if (src && typeof src === 'object') {
        for (const k of Object.keys(src)) {
            const v = (src as any)[k];
            if (v === undefined) continue;
            // 只在"两边都是普通对象"时深合并；否则整体替换。
            // 必须判两侧：媒体模板里同一个键可能在一行里是字符串占位符（input = "{text}"）、
            // 在另一行里是嵌套表（[body.input]），若只判 v 会把字符串展开成 {0:'{',1:'t'…} 垃圾。
            target[k] = isPlainObject(v) && isPlainObject(target[k]) ? { ...target[k], ...v } : v;
        }
    }
    return target;
}

/** 深合并两个配置对象（后者覆盖前者）；返回新对象，不修改入参 */
export function deepMerge<T extends Record<string, any>>(base: T | undefined | null, over: any): T {
    const out: Record<string, any> = isPlainObject(base) ? { ...(base as Record<string, any>) } : {};
    return mergeInto(out, over) as T;
}

/** [连接序号]:模型名 → 也允许规则里只写裸模型名；反之亦然 */
function normalizeModelRef(modelRef: string): { ref: string; bare: string } {
    const ref = String(modelRef || '').trim();
    const m = /^\[\d+\]:\s*(.+)$/.exec(ref);
    return { ref, bare: m ? m[1].trim() : ref };
}

/** 规则的 models 是否命中给定模型（ref 或裸名任一相等即可） */
export function matchesModelRef(list: string[] | undefined, modelRef?: string): boolean {
    if (!list || list.length === 0) return false;
    const raw = String(modelRef || '').trim();
    if (!raw) return false;
    const { ref, bare } = normalizeModelRef(raw);
    const candidates = ref === bare ? [ref] : [ref, bare];
    return list.some(m => candidates.includes(String(m).trim()));
}

/** 规则是否命中：mode='use' 收集 use 组行，mode='models' 收集 models 定向行 */
function isHit(row: ModelRuleTemplate, use: ModelUse, modelRef: string | undefined, mode: 'use' | 'models'): boolean {
    const hasModels = Array.isArray(row.models) && row.models.length > 0;
    if (mode === 'use') {
        if (hasModels) return false;
        return row.use.includes(use);
    }
    if (!hasModels) return false;
    // 声明了 models 的行：可选地再限制 use
    if (row.use.length > 0 && !row.use.includes(use)) return false;
    return matchesModelRef(row.models, modelRef);
}

/** 两趟收集命中的规则行（先 use 组，后 models 定向，后者覆盖前者） */
function hitRows(use: ModelUse, modelRef?: string): ModelRuleTemplate[] {
    const out: ModelRuleTemplate[] = [];
    for (const row of ruleRows) {
        if (isHit(row, use, modelRef, 'use')) out.push(row);
    }
    for (const row of ruleRows) {
        if (isHit(row, use, modelRef, 'models')) out.push(row);
    }
    return out;
}

/**
 * 命中规则行里 [body] 的合并结果（**不含**代码兜底默认）。
 * 媒体用途用它判断骰主是否自行描述了请求结构。
 */
export function ruleBodyFor(use: ModelUse, modelRef?: string): Record<string, any> {
    let out: Record<string, any> = {};
    for (const row of hitRows(use, modelRef)) out = mergeInto(out, row.body);
    return out;
}

/**
 * 某用途合并后的 body 模板（含 {占位符}）。
 * 优先级：代码兜底默认 < use 组规则 [body] < models 定向规则 [body]
 *
 * 媒体用途（tts / image-generation）**不叠代码兜底**：请求结构由「内置预设」（media_presets）提供，
 * 规则写了 [body] 即整体替换预设结构——否则预设里 OpenAI 形状的键（voice/speed/response_format…）
 * 会混进阿里/Google 等原生结构里污染请求体。
 */
export function bodyDefaultsFor(use: ModelUse, modelRef?: string): any {
    let out: any = classDefaultBody(use);
    for (const row of hitRows(use, modelRef)) out = mergeInto(out, row.body);
    return out;
}

/** 媒体用途 → 代码默认参数元信息（仅在模板（预设或规则 [body]）真的含对应 {占位符} 时才被采纳） */
export function defaultMediaParamsFor(use: ModelUse): Record<string, MediaParamMeta> {
    if (use === 'tts') return { ...DEFAULT_TTS_PARAMS } as Record<string, MediaParamMeta>;
    if (use === 'image-generation') return { ...DEFAULT_IMAGE_PARAMS } as Record<string, MediaParamMeta>;
    return {};
}

/** 只取命中规则行的 [params] 合并（不含代码默认与内置预设默认） */
export function ruleParamsFor(use: ModelUse, modelRef?: string): Record<string, MediaParamMeta> {
    let out: Record<string, MediaParamMeta> = {};
    for (const row of hitRows(use, modelRef)) out = mergeInto(out, row.params);
    return out;
}

/** 某用途合并后的自由提示词（[prompt].extra 顺序追加，非覆盖） */
export function promptExtraFor(use: ModelUse, modelRef?: string): string {
    const parts: string[] = [];
    for (const row of hitRows(use, modelRef)) {
        const extra = row.prompt && typeof row.prompt.extra === 'string' ? row.prompt.extra.trim() : '';
        if (extra) parts.push(extra);
    }
    return parts.join('\n');
}

/** 某用途合并后的返回取数规则（[response]） */
export function responseRuleFor(use: ModelUse, modelRef?: string): Record<string, any> {
    const out: Record<string, any> = {};
    for (const row of hitRows(use, modelRef)) mergeInto(out, row.response);
    return out;
}

/**
 * 命中规则里**最后设置**的 bodyMode（后覆盖先）。
 * 未命中或都未声明时返回 undefined —— 由调用方按"媒体用途默认整体替换"处理。
 */
export function ruleBodyModeFor(use: ModelUse, modelRef?: string): 'merge' | 'replace' | undefined {
    let mode: 'merge' | 'replace' | undefined;
    for (const row of hitRows(use, modelRef)) {
        if (row.bodyMode === 'merge' || row.bodyMode === 'replace') mode = row.bodyMode;
    }
    return mode;
}

/**
 * 某用途合并后的 request 覆盖（headers/auth_header_name/content_type/timeout/url/method 等）。
 * 未命中任何规则行时返回 null（完全按 provider 默认行为请求）。
 */
export function requestOverridesFor(use: ModelUse, modelRef?: string): Record<string, any> | null {
    let merged: Record<string, any> | null = null;
    for (const row of hitRows(use, modelRef)) {
        if (!row.request || typeof row.request !== 'object') continue;
        merged = merged ?? {};
        for (const k of Object.keys(row.request)) {
            if (k === 'headers' && row.request.headers && typeof row.request.headers === 'object') {
                merged.headers = { ...(merged.headers ?? {}), ...row.request.headers };
            } else {
                merged[k] = row.request[k];
            }
        }
    }
    return merged;
}

export function resetRuleRowsForTest(): void {
    ruleRows = [];
}
