// 模型列表拉取：连接级「获取可用模型列表」适配（结果只存内存、不持久化）。
// 默认 OpenAI 兼容：GET {base}/models（Bearer），解析 data[].id；
// Anthropic 特判：GET {base}/models，x-api-key + anthropic-version，limit=1000 循环翻页到 has_more=false。
// 对象项额外提取供应商自报的能力位（vision/embed，仅正向证据），无相关字段时由上层退回命名猜测；
// 连接配置里可选 [request]（list_url/list_headers/auth_header_name/timeout）可覆盖默认行为；
// 智谱/部分兼容网关无 /models 端点时自然报错，由上层按连接降级处理（可走 models 钉住清单）。
import { logger } from "../logger";

import { ApiError } from "./api_error";

/** 一次列表拉取需要的最小信息（来自「api连接」配置解析结果） */
export interface ListRequestContext {
    provider: string;
    baseUrl: string;
    apiKey: string;
    /** 连接配置 [request] 中与列表相关的覆盖项（默认不写时为空对象） */
    listOverride?: Record<string, any>;
}

/** 供应商自报的能力位（只记"是"，不记"不是"：避免用保守元数据把模型降级） */
export interface ModelCapabilityHints {
    vision?: boolean;
    embed?: boolean;
}

/** 列表项：裸字符串（纯 id 网关/老写法）或带能力位的对象 */
export interface ModelListEntry {
    id: string;
    hints?: ModelCapabilityHints;
}

/** 拉取结果：`string[]` 是等价子集（单测注入的桩可继续返回字符串数组） */
export type ModelListResult = Array<string | ModelListEntry>;

/** 拉取函数签名：便于单元测试注入桩（失败抛 Error） */
export type ListFetchFn = (ctx: ListRequestContext) => Promise<ModelListResult>;

export const LIST_FETCH_TIMEOUT_MS = 10000;

function joinUrl(baseUrl: string, path: string): string {
    return `${String(baseUrl ?? '').replace(/\/+$/, '')}${path}`;
}

async function readJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<any> {
    const doFetch = (async () => {
        const response = await fetch(url, { method: 'GET', headers });
        const text = await response.text();
        if (!response.ok) {
            throw ApiError.fromResponse(response.status, '', text);
        }
        if (!text) {
            throw new Error('响应体为空');
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`解析响应体时出错:${e instanceof Error ? e.message : String(e)}\n响应体:${text}`);
        }
    })();
    // 超时用 race 实现（不依赖 AbortController，兼容海豹 goja 运行时）
    return await Promise.race([
        doFetch,
        new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`列表拉取超时 (${timeoutMs}ms)`)), timeoutMs);
        }),
    ]);
}

function pickHeaders(listOverride: Record<string, any> | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    if (listOverride?.headers && typeof listOverride.headers === 'object') {
        for (const k of Object.keys(listOverride.headers)) headers[k] = String(listOverride.headers[k]);
    }
    return headers;
}

/** 供应商元数据里的类型取值 → 能力位：只认明确表示多模态/嵌入的取值，未知值（含 anthropic 的 "model"）一律忽略 */
const MODALITY_BY_META_VALUE: { [value: string]: 'vision' | 'embed' } = {
    vlm: 'vision',
    vision: 'vision',
    multimodal: 'vision',
    embeddings: 'embed',
    embedding: 'embed',
    embed: 'embed',
    pooling: 'embed',
};

/**
 * 从单个列表项提取供应商自报的能力位（字段缺失/取值未知时返回 undefined）：
 * type/model_type/kind/task（LM Studio、vLLM 等）、architecture.input_modalities（OpenRouter 等）、
 * capabilities（数组或对象，Ollama 等）、supports_vision/vision。
 * 只产出 vision/embed 正向证据：不产出 text，避免网关的保守元数据把多模态模型降级为纯文本。
 */
function extractHints(item: any): ModelCapabilityHints | undefined {
    if (!item || typeof item !== 'object') return undefined;
    const hints: ModelCapabilityHints = {};
    for (const field of [item.type, item.model_type, item.kind, item.task]) {
        if (typeof field !== 'string') continue;
        const kind = MODALITY_BY_META_VALUE[field.trim().toLowerCase()];
        if (kind === 'vision') hints.vision = true;
        else if (kind === 'embed') hints.embed = true;
    }
    const modalities = item.architecture?.input_modalities ?? item.input_modalities;
    if (Array.isArray(modalities)) {
        if (modalities.some((m: any) => typeof m === 'string' && (m.toLowerCase() === 'image' || m.toLowerCase() === 'video'))) {
            hints.vision = true;
        }
    }
    const capabilities = item.capabilities;
    if (Array.isArray(capabilities)) {
        if (capabilities.some((c: any) => typeof c === 'string' && c.toLowerCase() === 'vision')) hints.vision = true;
        if (capabilities.some((c: any) => typeof c === 'string' && c.toLowerCase() === 'embedding')) hints.embed = true;
    } else if (capabilities && typeof capabilities === 'object') {
        if (capabilities.vision === true) hints.vision = true;
        if (capabilities.embedding === true) hints.embed = true;
    }
    if (item.supports_vision === true || item.vision === true) hints.vision = true;
    return (hints.vision || hints.embed) ? hints : undefined;
}

/** OpenAI 兼容列表响应 → 列表项（对象项额外提取能力位；字符串项保持原样） */
function parseOpenAiModelEntries(data: any): ModelListResult {
    const arr = Array.isArray(data?.data) ? data.data : null;
    if (!arr) {
        throw new Error('列表响应缺少 data 数组');
    }
    const items: ModelListResult = [];
    for (const item of arr) {
        const id = typeof item === 'string' ? item : item?.id;
        if (typeof id !== 'string' || !id.trim()) continue;
        items.push(typeof item === 'string' ? id.trim() : { id: id.trim(), hints: extractHints(item) });
    }
    return items;
}

/** 归一化拉取结果：模型名（保序去重，与历史行为一致）+ 能力位映射（同名多次出现时逐键合并） */
export function normalizeModelListResult(raw: any): { names: string[]; hints: Record<string, ModelCapabilityHints> } {
    const names: string[] = [];
    const hints: Record<string, ModelCapabilityHints> = {};
    const seen = new Set<string>();
    for (const item of Array.isArray(raw) ? raw : []) {
        const id = typeof item === 'string' ? item : (item && typeof item.id === 'string' ? item.id : null);
        const name = typeof id === 'string' ? id.trim() : '';
        if (!name) continue;
        if (!seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
        const itemHints = item && typeof item === 'object' ? item.hints : undefined;
        if (itemHints && typeof itemHints === 'object') {
            hints[name] = { ...(hints[name] ?? {}), ...itemHints };
        }
    }
    return { names, hints };
}

/** Anthropic：x-api-key + anthropic-version，翻页直到 has_more=false */
async function fetchAnthropicModels(ctx: ListRequestContext, listUrl: string, timeoutMs: number): Promise<string[]> {
    const headers: Record<string, string> = {
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
        'Accept': 'application/json',
        ...pickHeaders(ctx.listOverride),
    };
    const names: string[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 10; page++) { // 理论页数极少，10 页即上限（每页 1000）
        const query = afterId ? `?limit=1000&after_id=${encodeURIComponent(afterId)}` : '?limit=1000';
        const data = await readJson(listUrl + query, headers, timeoutMs);
        const arr = Array.isArray(data?.data) ? data.data : [];
        for (const item of arr) {
            const id = typeof item === 'string' ? item : item?.id;
            if (typeof id === 'string' && id.trim()) names.push(id.trim());
        }
        if (!data?.has_more) break;
        const lastId = data?.last_id;
        if (typeof lastId !== 'string' || !lastId) break;
        afterId = lastId;
    }
    return names;
}

/** 默认拉取实现：Anthropic 特判，其余按 OpenAI 兼容处理 */
export async function fetchModelList(ctx: ListRequestContext): Promise<ModelListResult> {
    const listOverride = ctx.listOverride ?? {};
    const timeoutMs = Number(listOverride.timeout) > 0 ? Number(listOverride.timeout) * 1000 : LIST_FETCH_TIMEOUT_MS;
    let listUrl = joinUrl(ctx.baseUrl, '/models');
    if (typeof listOverride.list_url === 'string' && listOverride.list_url.trim()) {
        listUrl = listOverride.list_url.trim();
    }

    if (ctx.provider === 'anthropic') {
        return fetchAnthropicModels(ctx, listUrl, timeoutMs);
    }

    const headers: Record<string, string> = {
        'Accept': 'application/json',
        ...pickHeaders(listOverride),
    };
    const authHeader = typeof listOverride.auth_header_name === 'string' && listOverride.auth_header_name
        ? listOverride.auth_header_name
        : 'Authorization';
    headers[authHeader] = authHeader === 'Authorization' ? `Bearer ${ctx.apiKey}` : ctx.apiKey;

    const data = await readJson(listUrl, headers, timeoutMs);
    return parseOpenAiModelEntries(data);
}

/** 将拉取抛出的错误转成可展示的短文案（按连接降级展示用） */
export function describeListError(e: any): { kind: string, text: string } {
    if (e instanceof ApiError) {
        const kindLabel: { [k: string]: string } = {
            auth: '认证失败',
            permission: '权限不足',
            model_not_found: '模型不存在',
            rate_limit: '触发限流',
            overloaded: '服务繁忙',
            server: '服务端错误',
            invalid_request: '请求参数错误',
            context_too_long: '上下文超长',
            balance: '余额不足',
        };
        const label = kindLabel[e.kind] ?? (e.status >= 400 && e.status < 500 ? '无列表接口' : '服务端错误');
        if (e.kind === 'auth' || e.kind === 'permission') {
            return { kind: e.kind, text: `${label}（api_key 无效或未开通）` };
        }
        const snippet = String(e.message ?? '').replace(/\n+/g, ' ').slice(0, 120);
        return { kind: e.kind, text: `${label}${e.status ? `(${e.status})` : ''} ${snippet}`.trim() };
    }
    const msg = e instanceof Error ? e.message : String(e);
    logger.warning(`模型列表拉取失败: ${msg}`);
    return { kind: 'unknown', text: msg.slice(0, 120) };
}
