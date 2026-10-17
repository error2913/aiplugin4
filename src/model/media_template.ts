// 媒体模板引擎：把**内置预设 + 「模型规则」**合成的 {占位符} 模板渲染成可发送的请求体，
// 并把 AI/命令传入的参数按 [params] 元信息归一与校验。
//
// 结构来源（优先级从高到低）：
//   1. 「模型规则」[body]：写了就**整体替换**内置预设结构（骰主自行描述该供应商的真实字段路径）；
//   2. 「内置预设」（media_presets.ts）：按 provider + 模型名给出该供应商的原生结构。
//   → 仓库自带常见供应商结构，骰主只配 api_key/base_url 即可用；接口与众不同的才需要写 [body]。
//
// 核心语义（见 .dev/issue-127-media-plan.md 第 3 节）：
//   - 声明 + 定位：模板用 TOML 嵌套表写出真实字段结构，用 {参数名} 标出"此处接受覆写"；
//     供应商差异（input.parameters.rate vs audioConfig.speakingRate）全部由模板表达，代码零分支。
//   - 取值优先级：内置占位符 > AI/命令传参 > [params].default > 无值且无默认 → 整个键不发送。
//   - 类型保留：某个值整个就是 "{rate}" 时替换后保留原始类型（number 仍是 number）；
//     混合串（如 "语速{rate}"）按字符串拼接，未解析的占位符替换为空串。
//   - 空表剪枝：嵌套表内所有键都因"无值且无默认"被删除时，该空表一并删除，避免发送 "parameters": {}。
//
// 纯模块：不依赖 seal / Config（只读 request_rules 与 static_config），便于单元测试。
import { resolveMediaPreset } from "../config/static_config";

import { canonicalPrefixOf, normalizeBaseUrl, parseBaseUrl } from "./base_url";
import {
    deepMerge,
    defaultMediaParamsFor,
    MediaParamMeta,
    promptExtraFor,
    requestOverridesFor,
    responseRuleFor,
    ruleBodyFor,
    ruleBodyModeFor,
    ruleParamsFor,
} from "./request_rules";
import { MediaModelUse } from "./types";

/**
 * 内置占位符：由插件/连接自动填充，不可被 [params] 声明（骰主写了会拒绝并记日志）
 *
 * `origin` = 连接 baseURL 的**主机根**（协议 + 主机 + 端口，不含路径）。
 *
 * 为什么需要它：有些厂商的**原生端点挂在主机根**，而兼容/网关端点带路径前缀，
 * 两者同主机不同前缀 —— 百炼就是典型：
 *   兼容模式  https://host/compatible-mode/v1/images/generations
 *   原生      https://host/api/v1/services/aigc/multimodal-generation/generation
 * 预设原先只能写"相对 baseURL 的 suffix"，于是原生路径被拼到了 `/compatible-mode/v1`
 * 后面 → 404。有了 `{origin}`，原生预设可以直接写成 `{origin}/api/v1/services/…`，
 * **用户填一个 baseURL 就能同时用兼容类与原生类的模型**，不必拆成两条连接。
 */
export const MEDIA_RESERVED_PLACEHOLDERS: string[] = [
    'text', 'prompt', 'negative_prompt', 'image', 'image_url', 'image_base64', 'model', 'api_key',
    'origin',
];

/** 语义别名：AI 习惯用词 → 模板里的规范键（仅当目标键在模板中真的存在时才生效） */
const MEDIA_PARAM_ALIASES: { [key: string]: string } = {
    // 语音
    speed: 'rate',
    tempo: 'rate',
    tone: 'pitch',
    vol: 'volume',
    // 图片
    cfg: 'cfg_scale',
    cfgScale: 'cfg_scale',
    negative: 'negative_prompt',
};

const PLACEHOLDER_RE = /\{([A-Za-z0-9_.\-]+)\}/g;
const SINGLE_PLACEHOLDER_RE = /^\{([A-Za-z0-9_.\-]+)\}$/;

export interface RenderedBody {
    body: Record<string, unknown>;
    /** 因"无值且无默认"而被删除的键路径（供日志/排查） */
    dropped: string[];
}

export interface RenderContext {
    /** 内置占位符取值：text / prompt / model / api_key / image… */
    builtin: Record<string, unknown>;
    /** 已归一的自定义参数（含别名与 emotion 归一后的结果） */
    params: Record<string, unknown>;
    /** [params] 元信息（取 default 用） */
    meta: Record<string, MediaParamMeta>;
}

/** 模板里出现的全部自定义占位符（排除内置），按出现顺序去重 */
export function collectPlaceholders(template: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>(MEDIA_RESERVED_PLACEHOLDERS);
    const visit = (node: unknown): void => {
        if (typeof node === 'string') {
            PLACEHOLDER_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = PLACEHOLDER_RE.exec(node)) !== null) {
                const name = m[1];
                if (seen.has(name)) continue;
                seen.add(name);
                out.push(name);
            }
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }
        if (node && typeof node === 'object') {
            for (const key of Object.keys(node as Record<string, unknown>)) visit((node as Record<string, unknown>)[key]);
        }
    };
    visit(template);
    return out;
}

/** 解析单个占位符的取值：内置 > 传参 > 默认值；返回 undefined 表示"无值" */
function resolvePlaceholder(name: string, ctx: RenderContext): unknown {
    if (Object.prototype.hasOwnProperty.call(ctx.builtin, name)) {
        const v = ctx.builtin[name];
        if (v !== undefined && v !== null) return v;
    }
    if (Object.prototype.hasOwnProperty.call(ctx.params, name)) {
        const v = ctx.params[name];
        if (v !== undefined && v !== null) return v;
    }
    const meta = ctx.meta[name];
    if (meta && meta.default !== undefined && meta.default !== null) return meta.default;
    return undefined;
}

interface RenderNodeResult {
    /** undefined 表示该键应被删除 */
    value: unknown;
    /** 是否有后代键被删除（用于空表剪枝） */
    deletedAny: boolean;
    dropped: string[];
}

function renderNode(node: unknown, ctx: RenderContext, path: string): RenderNodeResult {
    // 字符串：整值占位符保留类型；混合串按字符串拼接
    if (typeof node === 'string') {
        const single = SINGLE_PLACEHOLDER_RE.exec(node);
        if (single) {
            const value = resolvePlaceholder(single[1], ctx);
            if (value === undefined) return { value: undefined, deletedAny: false, dropped: [path] };
            return { value, deletedAny: false, dropped: [] };
        }
        if (node.indexOf('{') === -1) return { value: node, deletedAny: false, dropped: [] };
        const replaced = node.replace(PLACEHOLDER_RE, (_all, name: string) => {
            const value = resolvePlaceholder(name, ctx);
            return value === undefined ? '' : String(value);
        });
        return { value: replaced, deletedAny: false, dropped: [] };
    }

    if (Array.isArray(node)) {
        const out: unknown[] = [];
        let deletedAny = false;
        const dropped: string[] = [];
        node.forEach((item, i) => {
            const r = renderNode(item, ctx, `${path}[${i}]`);
            if (r.value === undefined) {
                deletedAny = true;
                dropped.push(...r.dropped);
                return;
            }
            out.push(r.value);
            if (r.deletedAny) deletedAny = true;
            dropped.push(...r.dropped);
        });
        return { value: out, deletedAny, dropped };
    }

    if (node && typeof node === 'object') {
        const src = node as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        let deletedAny = false;
        const dropped: string[] = [];
        for (const key of Object.keys(src)) {
            const childPath = path ? `${path}.${key}` : key;
            const r = renderNode(src[key], ctx, childPath);
            if (r.value === undefined) {
                deletedAny = true;
                dropped.push(...r.dropped);
                continue;
            }
            out[key] = r.value;
            if (r.deletedAny) deletedAny = true;
            dropped.push(...r.dropped);
        }
        // 空表剪枝：本表所有键都被删除时不发送空对象
        if (Object.keys(out).length === 0 && deletedAny) {
            return { value: undefined, deletedAny: true, dropped };
        }
        return { value: out, deletedAny, dropped };
    }

    // number / boolean / null 原样
    return { value: node, deletedAny: false, dropped: [] };
}

/** 渲染 [body] 模板 → 可直接发送的请求体 */
export function renderMediaBody(template: Record<string, unknown>, ctx: RenderContext): RenderedBody {
    const r = renderNode(template, ctx, '');
    const body = r.value && typeof r.value === 'object' && !Array.isArray(r.value)
        ? r.value as Record<string, unknown>
        : {};
    return { body, dropped: r.dropped };
}

/** 渲染单值文本模板（url / urlSuffix 等纯文本字段） */
export function renderMediaText(template: string, ctx: RenderContext): string {
    const r = renderNode(String(template ?? ''), ctx, '');
    return r.value === undefined ? '' : String(r.value);
}

// -------------------- 内置预设 + 「模型规则」 合成 --------------------

/** 内置预设与「模型规则」合成后的媒体模板 */
export interface ComposedMediaTemplate {
    /**
     * 该 vendor 的**规范版本前缀**（如 `/v1`、`/compatible-mode/v1`）。
     * 由 composeMediaTemplate 带出来，供 resolveMediaUrl 归一化 baseURL 用。
     */
    canonicalPrefix: string;
    /** 请求体结构：规则 [body] 非空则整体替换预设结构 */
    body: Record<string, unknown>;
    /** 是否来自规则 [body]（否则来自内置预设） */
    bodyFromRule: boolean;
    /** 最终 request 段：预设 ← 规则（规则优先），供取 headers/auth_header_name/content_type/timeout/method */
    request: Record<string, any>;
    /** 「模型规则」单独声明的 request 段（url / urlSuffix 的优先级最高） */
    ruleRequest: Record<string, any>;
    /** 内置预设的 request 段 */
    presetRequest: Record<string, any>;
    /** 最终 response 段：预设 ← 规则（取数路径/类型/轮询） */
    response: Record<string, any>;
    /** 参数元信息：代码默认 < 预设默认 < 规则 [params] */
    params: Record<string, MediaParamMeta>;
}

/** 轮询相关键：本插件文档写在 [response]，但旧依赖的 TOML 写在 [request]，两处都接受 */
const POLL_KEYS = ['poll_url', 'poll_interval', 'poll_max'];

/**
 * 合成某模型某用途的媒体模板：
 *   body     = 规则 [body]（非空则整体替换） || 内置预设结构
 *   request  = 内置预设 request ← 规则 [request]
 *   response = 内置预设 response ← 规则 [response]（poll_* 也接受写在 [request] 里的旧写法）
 *   params   = 代码默认 < 内置预设 params < 规则 [params]
 * [request]/[response]/[params] 逐键覆盖（headers 逐键合并），便于只改一项而沿用预设其余部分。
 */
export function composeMediaTemplate(use: MediaModelUse, provider: string, modelName: string, modelRef: string): ComposedMediaTemplate {
    const preset = resolveMediaPreset(provider, use, modelName);
    const presetRequest: Record<string, any> = { ...(preset.request ?? {}) };
    const ruleRequest: Record<string, any> = requestOverridesFor(use, modelRef) ?? {};
    const request = deepMerge(presetRequest, ruleRequest);
    const response = deepMerge(preset.response ?? {}, responseRuleFor(use, modelRef));
    for (const key of POLL_KEYS) {
        if (response[key] === undefined && request[key] !== undefined) response[key] = request[key];
    }
    const ruleBody = ruleBodyFor(use, modelRef);
    const bodyFromRule = Object.keys(ruleBody).length > 0;
    // bodyMode='merge' 时与预设逐键合并（保留预设里未被覆盖的字段）；
    // 否则维持既有语义：有规则 body 即整体替换预设结构。
    const bodyMode = ruleBodyModeFor(use, modelRef) ?? 'replace';
    const body = (bodyFromRule && bodyMode === 'merge')
        ? deepMerge({ ...(preset.body ?? {}) }, ruleBody)
        : (bodyFromRule ? ruleBody : { ...(preset.body ?? {}) });
    return {
        // 该 vendor 的规范版本前缀，供 resolveMediaUrl 归一化 baseURL 用
        // （用户只填主机根时靠它补回前缀）。放在这里而不是给 resolveMediaUrl 加参数：
        // 调用方（含测试）不必改签名，也不会漏传。
        canonicalPrefix: canonicalPrefixOf(provider),
        body,
        bodyFromRule,
        request,
        ruleRequest,
        presetRequest,
        response,
        params: deepMerge(defaultMediaParamsFor(use), deepMerge(preset.params ?? {}, ruleParamsFor(use, modelRef))),
    };
}

/**
 * 合成后的模板里可被 AI/命令覆写的参数：请求体 + 地址（url/urlSuffix）里的 {占位符}（排除内置）。
 * 地址也要算上：ElevenLabs 的音色就写在 url 的 {voice} 里。
 */
export function templateParamKeys(composed: ComposedMediaTemplate): string[] {
    return collectPlaceholders([
        composed.body,
        composed.request.url ?? '',
        composed.request.urlSuffix ?? '',
    ]);
}

/** 拼 base_url 与路径：去掉重复斜杠；base_url 已以该路径结尾时原样使用（兼容直接粘旧版完整地址） */
export function joinMediaUrl(baseUrl: string, path: string): string {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const tail = String(path ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!tail) return base;
    if (base === tail || base.endsWith(`/${tail}`)) return base;
    return `${base}/${tail}`;
}

/**
 * 最终请求地址，优先级：
 *   规则 [request].url > 规则 [request].urlSuffix > 预设 url > 预设 urlSuffix > 用途默认路径
 * url 与 urlSuffix 均支持 {占位符}（如 ElevenLabs 的 /text-to-speech/{voice}）；
 * urlSuffix 显式写成 "" 表示"base_url 原样就是接口地址"（本地自建服务常用）。
 *
 * **`{origin}` 由本函数自己替换**（取自 baseUrl 的主机根）——
 * 不让调用方在 render 上下文里塞，是因为那是**容易漏**的一步：
 * 漏了就会渲染成空串，得到 `/v1/...` 这种没有主机的地址。
 * 原生端点挂在主机根的厂商（百炼原生 / stability / elevenlabs / fishaudio /
 * google-cloud / gemini）都靠它表达，与 baseURL 的路径前缀无关。
 *
 * **baseURL 归一化也在这里做，而且是"按预设"决定**：
 *   · 预设是**非空 urlSuffix**（相对版本前缀，如 `/images/generations`）→
 *     用户给的应当是**基址**；若他粘成了完整端点（`.../v1/chat/completions`），
 *     退回版本前缀再拼，否则会拼出 `.../chat/completions/images/generations`。
 *   · 预设是 **url（`{origin}/…`）** → 只用主机根，基址路径无关，不必动。
 *   · 预设是 **urlSuffix: ""** → "base_url 原样就是接口地址"（本地自建 / 百度），
 *     **绝不能削** —— 削了端点就没了（实测踩过：`/sdapi/v1/txt2img` 被削成 `/sdapi/v1`）。
 */
export function resolveMediaUrl(use: MediaModelUse, composed: ComposedMediaTemplate, baseUrl: string, render: (text: string) => string): string {
    const own = (src: Record<string, any>, key: string): string | undefined =>
        src && Object.prototype.hasOwnProperty.call(src, key) && typeof src[key] === 'string' ? src[key] : undefined;
    const trimmed = (v: string | undefined): string => (v ?? '').trim();

    // {origin} → 主机根。baseUrl 认不出主机时原样留下（渲染成字面量比静默丢主机好排查）
    const origin = parseBaseUrl(baseUrl).origin;
    const r = (text: string): string => render(origin ? text.replace(/\{origin\}/g, origin) : text);
    /** 按"基址"用法归一化后再拼后缀 */
    const joinNorm = (suffix: string): string =>
        joinMediaUrl(normalizeBaseUrl(baseUrl, composed.canonicalPrefix || undefined), r(suffix));

    const ruleUrl = trimmed(own(composed.ruleRequest, 'url'));
    if (ruleUrl) return r(ruleUrl);
    const ruleSuffix = own(composed.ruleRequest, 'urlSuffix');
    if (ruleSuffix !== undefined) {
        return trimmed(ruleSuffix)
            ? joinNorm(ruleSuffix)
            : String(baseUrl ?? '').replace(/\/+$/, '');
    }
    const presetUrl = trimmed(own(composed.presetRequest, 'url'));
    if (presetUrl) return r(presetUrl);
    const presetSuffix = own(composed.presetRequest, 'urlSuffix');
    if (presetSuffix !== undefined) {
        return trimmed(presetSuffix)
            ? joinNorm(presetSuffix)
            : String(baseUrl ?? '').replace(/\/+$/, '');
    }
    return joinNorm(use === 'tts' ? '/audio/speech' : '/images/generations');
}

export interface NormalizeResult {
    params: Record<string, unknown>;
    /** 校验失败信息（非空即应中止，不建任务） */
    errors: string[];
    /** 被忽略的键（保留字 / 模板里不存在 / 别名冲突） */
    ignored: string[];
}

function coerceByType(key: string, value: unknown, meta: MediaParamMeta): { ok: true; value: unknown } | { ok: false; error: string } {
    const type = typeof meta.type === 'string' ? meta.type.trim().toLowerCase() : '';
    if (!type) return { ok: true, value };
    if (type === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
            return { ok: true, value: Number(value) };
        }
        return { ok: false, error: `参数 ${key} 应为数字，收到 ${JSON.stringify(value)}` };
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return { ok: true, value };
        if (value === 1 || value === '1' || value === 'true') return { ok: true, value: true };
        if (value === 0 || value === '0' || value === 'false') return { ok: true, value: false };
        return { ok: false, error: `参数 ${key} 应为布尔值，收到 ${JSON.stringify(value)}` };
    }
    if (type === 'string') {
        if (typeof value === 'string') return { ok: true, value };
        if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
        return { ok: false, error: `参数 ${key} 应为字符串，收到 ${JSON.stringify(value)}` };
    }
    return { ok: true, value };
}

function checkRangeAndEnum(key: string, value: unknown, meta: MediaParamMeta): string[] {
    const errors: string[] = [];
    const desc = meta.desc ? `（${meta.desc}）` : '';
    if (Array.isArray(meta.enum) && meta.enum.length > 0) {
        if (!meta.enum.some(v => v === value)) {
            errors.push(`参数 ${key}${desc} 取值非法：${JSON.stringify(value)}，可选：${meta.enum.map(v => JSON.stringify(v)).join(' / ')}`);
            return errors;
        }
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (typeof meta.min === 'number' && value < meta.min) {
            errors.push(`参数 ${key}${desc} 越界：${value} 小于最小值 ${meta.min}（合法范围 ${meta.min}~${meta.max ?? '∞'}）`);
        }
        if (typeof meta.max === 'number' && value > meta.max) {
            errors.push(`参数 ${key}${desc} 越界：${value} 大于最大值 ${meta.max}（合法范围 ${meta.min ?? '-∞'}~${meta.max}）`);
        }
    }
    return errors;
}

export interface NormalizeOptions {
    /**
     * 命令来源：kwargs 的值一律是字符串，未声明 type 时也把"看起来是数字/布尔"的字符串转换过来，
     * 否则 `--rate=1.5` 会以字符串 "1.5" 落进请求体。AI 工具路径无需开启（本就是 JSON 类型）。
     */
    coerceStringTypes?: boolean;
}

function coerceLooseString(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const t = value.trim();
    if (t === '') return value;
    if (/^-?\d+(\.\d+)?$/.test(t)) {
        const n = Number(t);
        if (Number.isFinite(n)) return n;
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    return value;
}

/**
 * 归一 + 校验调用方传入的参数。
 * @param raw             AI/命令原始参数
 * @param allowed         模板里真实存在的自定义占位符（决定"哪些键有用"）
 * @param meta            [params] 元信息
 * @param opts            归一选项（命令路径开启 coerceStringTypes）
 */
export function normalizeMediaParams(
    raw: Record<string, unknown> | undefined | null,
    allowed: string[],
    meta: Record<string, MediaParamMeta>,
    opts: NormalizeOptions = {}
): NormalizeResult {
    const allowedSet = new Set(allowed);
    const params: Record<string, unknown> = {};
    const errors: string[] = [];
    const ignored: string[] = [];
    if (!raw || typeof raw !== 'object') return { params, errors, ignored };

    for (const key of Object.keys(raw)) {
        const rawValue = (raw as Record<string, unknown>)[key];
        if (rawValue === undefined || rawValue === null) continue;
        // 1) 保留字：内置占位符不接受自定义传参（工具/连接参数优先）
        if (MEDIA_RESERVED_PLACEHOLDERS.indexOf(key) !== -1) {
            ignored.push(key);
            continue;
        }
        // 2) 键必须真的出现在模板里；否则尝试别名（如 speed→rate、emotion→instruction）
        let target = allowedSet.has(key) ? key : '';
        if (!target) {
            const alias = MEDIA_PARAM_ALIASES[key];
            if (alias && allowedSet.has(alias)) target = alias;
        }
        if (!target && key === 'emotion' && allowedSet.has('instruction')) target = 'instruction';
        if (!target) {
            ignored.push(key);
            continue;
        }
        // 3) 同键后写覆盖先写（别名折叠到同一目标时以最后出现的为准）
        const m = meta[target] ?? {};
        const value = opts.coerceStringTypes ? coerceLooseString(rawValue) : rawValue;
        const coerced = coerceByType(target, value, m);
        // 显式判 false：联合类型 { ok: true; value } | { ok: false; error } 下，
        // `if (!coerced.ok)` 在某些 tsc 选项组合中不收窄，会报 "Property 'error' does not exist"。
        // （注意：命令行 `tsc --noEmit --strict` 会覆盖 tsconfig 的严格选项而把这个错误吞掉，
        //  CI 已改为直跑 tsconfig，见 .github/workflows/build-check.yml。）
        if (coerced.ok === false) {
            errors.push(coerced.error);
            continue;
        }
        const rangeErrors = checkRangeAndEnum(target, coerced.value, m);
        if (rangeErrors.length > 0) {
            errors.push(...rangeErrors);
            continue;
        }
        params[target] = coerced.value;
    }

    return { params, errors, ignored };
}

// -------------------- 工具提示词（由「模型规则」生成，不是硬编码超集） --------------------

export interface MediaModelDesc {
    /** 模型唯一标识（名称或 [连接序号]:名称） */
    ref: string;
    /** 裸模型名 */
    name: string;
    /** 供应商（决定用哪份内置预设；未收录的供应商落通用预设） */
    provider: string;
}

export interface MediaParamSummary {
    /** 该用途全部模型可用参数的并集（按首次出现顺序） */
    keys: string[];
    /** 参数元信息（同名参数取先出现者） */
    meta: Record<string, MediaParamMeta>;
    /** 参数 → 支持它的模型 ref 列表 */
    supportedBy: Record<string, string[]>;
}

/** 某模型在其模板（含地址）里真实可被覆写的参数（占位符 ∩ 非内置） */
export function modelParamKeys(use: MediaModelUse, m: MediaModelDesc): string[] {
    return templateParamKeys(composeMediaTemplate(use, m.provider, m.name, m.ref));
}

/** 该用途全部模型的参数并集（供工具 schema 与描述生成） */
export function useParamSummary(use: MediaModelUse, models: MediaModelDesc[]): MediaParamSummary {
    const keys: string[] = [];
    const meta: Record<string, MediaParamMeta> = {};
    const supportedBy: Record<string, string[]> = {};
    for (const m of models) {
        const merged = composeMediaTemplate(use, m.provider, m.name, m.ref).params;
        for (const key of modelParamKeys(use, m)) {
            if (!Object.prototype.hasOwnProperty.call(supportedBy, key)) {
                keys.push(key);
                supportedBy[key] = [];
                if (merged[key]) meta[key] = merged[key];
            }
            supportedBy[key].push(m.ref);
        }
    }
    return { keys, meta, supportedBy };
}

/** 参数的一行说明（说明/枚举或范围/默认值；仅部分模型支持时标注是哪些模型） */
export function describeMediaParam(key: string, meta: MediaParamMeta, supports: string[], allModels: MediaModelDesc[]): string {
    const bits: string[] = [];
    if (meta.desc) bits.push(meta.desc);
    if (Array.isArray(meta.enum) && meta.enum.length > 0) {
        bits.push(`可选 ${meta.enum.map(v => JSON.stringify(v)).join('/')}`);
    } else if (typeof meta.min === 'number' || typeof meta.max === 'number') {
        bits.push(`范围 ${meta.min ?? '-∞'}~${meta.max ?? '∞'}`);
    }
    if (meta.default !== undefined && meta.default !== null && meta.default !== '') {
        bits.push(`默认 ${JSON.stringify(meta.default)}`);
    }
    // 仅部分模型支持时标注，避免 AI 用错模型
    if (allModels.length > 1 && supports.length < allModels.length) {
        const names = supports.map(ref => (allModels.find(m => m.ref === ref)?.name ?? ref));
        bits.push(`仅 ${names.join('、')} 支持`);
    }
    return bits.length > 0 ? `${key}（${bits.join('，')}）` : key;
}

/**
 * 生成给 AI 的参数说明文本：逐模型参数清单 + 默认模型提示 + [prompt].extra。
 * 空配置时返回空串（工具描述退化为静态部分）。
 */
export function buildMediaParamHint(use: MediaModelUse, models: MediaModelDesc[], defaultRef?: string): string {
    if (models.length === 0) return '';
    const summary = useParamSummary(use, models);
    const kindLabel = use === 'tts' ? '语音' : '生图';

    const lines: string[] = [`已配置${kindLabel}模型：`];
    for (const m of models) {
        const composed = composeMediaTemplate(use, m.provider, m.name, m.ref);
        const keys = templateParamKeys(composed);
        const paramText = keys.length > 0
            ? keys.map(k => describeMediaParam(k, composed.params[k] ?? {}, summary.supportedBy[k] ?? [m.ref], models)).join('、')
            : '（无可覆写参数）';
        lines.push(`· ${m.name} — ${paramText}`);
    }

    const defaultModel = defaultRef
        ? (models.find(m => m.ref === defaultRef) ?? models[0])
        : models[0];
    lines.push(`未指定 model 时使用 ${defaultModel.name}。未传的参数用该模型默认值；模型不支持的参数会被忽略。`);

    // [prompt].extra：内容相同的模型合并成一段；各模型各异的用 [模型名] 前缀区分
    const extraGroups = new Map<string, string[]>();
    for (const m of models) {
        const extra = promptExtraFor(use, m.ref);
        if (!extra) continue;
        const names = extraGroups.get(extra);
        if (names) names.push(m.name);
        else extraGroups.set(extra, [m.name]);
    }
    for (const [extra, names] of extraGroups) {
        lines.push(names.length > 1 ? extra : `[${names[0]}] ${extra}`);
    }
    return lines.join('\n');
}
