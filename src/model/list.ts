// 模型列表拉取：连接级「获取可用模型列表」适配。
// 默认 OpenAI 兼容：GET {base}/models（Bearer），解析 data[].id；
// Anthropic 特判：GET {base}/models，x-api-key + anthropic-version，limit=1000 循环翻页到 has_more=false。
// 连接配置里可选 [request]（list_url/list_headers/auth_header_name/timeout）可覆盖默认行为；
// 智谱/部分兼容网关无 /models 端点时自然报错，由上层按连接降级处理（可走 models 钉住清单或缓存）。
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

/** 拉取函数签名：便于单元测试注入桩（返回模型名数组，失败抛 Error） */
export type ListFetchFn = (ctx: ListRequestContext) => Promise<string[]>;

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

/** OpenAI 兼容列表响应 → 模型 id 数组 */
function parseOpenAiModelIds(data: any): string[] {
    const arr = Array.isArray(data?.data) ? data.data : null;
    if (!arr) {
        throw new Error('列表响应缺少 data 数组');
    }
    const ids: string[] = [];
    for (const item of arr) {
        const id = typeof item === 'string' ? item : item?.id;
        if (typeof id === 'string' && id.trim()) ids.push(id.trim());
    }
    return ids;
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
export async function fetchModelList(ctx: ListRequestContext): Promise<string[]> {
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
    return parseOpenAiModelIds(data);
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
