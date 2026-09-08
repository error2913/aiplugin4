// 模型 Provider：统一模型请求（超时 / 重试 / 用量上报 / use 级 request 覆盖）
import Config from "../config/config";
import { logger } from "../logger";
import { TokenCalibration } from "../token_calibration";
import { UsageManager } from "../usage";
import { StopError, StopEvent, withTimeout } from "../utils/utils";
import { fetchData } from "../utils/web";

import { extractUsage } from "./adapter";
import { ApiError, ApiErrorKind, classifyApiError } from "./api_error";
import { requestOverridesFor } from "./request_rules";
import { ModelUse } from "./types";

const MAX_RETRIES = 2;

export interface RequestModelOptions {
    /** API 提供商：anthropic 使用 x-api-key 请求头与 /messages 协议 */
    provider?: string;
    /** 会话停止信号：stop 后立即中止，不再重试 */
    stopEvent?: StopEvent;
    /** 发送前启发式估算的原始 token 数，用于校准 */
    rawEstimateTokens?: number;
    /** 配置中的模型名，优先用于校准 key */
    modelName?: string;
    /** 请求所属用途：命中「模型规则」[request] 模板时应用其 headers/content_type/auth_header_name/timeout 覆盖 */
    use?: ModelUse;
}

/** request 覆盖（由「模型规则」[request] 模板解析而来，默认无） */
export interface RequestOverrides {
    headers?: Record<string, string>;
    authHeaderName?: string;
    contentType?: string;
    timeoutMs?: number;
}

/** 是否值得按指数退避重试：限速/过载/服务端故障/网络层错误（无 HTTP 状态）重试，其余立即失败 */
function isRetryableApiError(err: ApiError): boolean {
    if (err.kind === 'rate_limit' || err.kind === 'overloaded' || err.kind === 'server') return true;
    // 无 HTTP 状态码（网络中断/超时/解析前失败等）也重试，与历史行为一致
    if (err.status === 0) return true;
    return false;
}

/** 读取规则模板覆盖 → RequestOverrides（timeout 单位秒转毫秒） */
function resolveOverrides(use?: ModelUse): RequestOverrides | null {
    if (!use) return null;
    const ov = requestOverridesFor(use);
    if (!ov) return null;
    const out: RequestOverrides = {};
    if (ov.headers && typeof ov.headers === 'object') {
        out.headers = {};
        for (const k of Object.keys(ov.headers)) out.headers[k] = String(ov.headers[k]);
    }
    if (typeof ov.auth_header_name === 'string' && ov.auth_header_name) out.authHeaderName = ov.auth_header_name;
    if (typeof ov.content_type === 'string' && ov.content_type) out.contentType = ov.content_type;
    const t = Number(ov.timeout);
    if (Number.isFinite(t) && t > 0) out.timeoutMs = t * 1000;
    return out;
}

/**
 * 发起模型请求：带超时、按错误类别重试（限速/过载/服务端/网络类退避重试，
 * 余额/超长/认证等 4xx 不重试）与用量上报。
 * @returns 解析后的响应体
 */
export async function requestModel(url: string, apiKey: string, body: any, options: RequestModelOptions = {}): Promise<any> {
    const { TIMEOUT } = Config.base;
    const { provider = '', stopEvent, use } = options;
    const overrides = resolveOverrides(use);
    const timeoutMs = overrides?.timeoutMs && overrides.timeoutMs > 0 ? overrides.timeoutMs : TIMEOUT;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const data = await withTimeout(() => fetchProvider(provider, url, apiKey, body, overrides ?? undefined), timeoutMs, { stopEvent });
            const usage = extractUsage(data);
            if (usage) {
                UsageManager.updateUsage(data.model || '', usage);
                TokenCalibration.record(options.modelName || data.model || '', options.rawEstimateTokens || 0, usage.prompt_tokens);
            }
            return data;
        } catch (e) {
            // 会话已停止：直接中止，不再重试，也不把 StopError 当成请求失败记录
            if (e instanceof StopError) throw e;
            const apiErr: ApiError = e instanceof ApiError
                ? e
                : new ApiError(0, provider, classifyApiError(provider, 0, e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : String(e), '');
            if (options.modelName) apiErr.modelName = options.modelName;
            lastError = apiErr;
            if (!isRetryableApiError(apiErr)) break;
            if (attempt < MAX_RETRIES) {
                if (stopEvent && stopEvent.fired) throw new StopError();
                const delay = apiErr.retryAfterMs ?? 500 * Math.pow(2, attempt);
                logger.warning(`模型请求失败(${apiErr.kind}, ${apiErr.status || '网络'}): ${apiErr.message}，${delay}ms 后进行第 ${attempt + 1} 次重试`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

/** 按提供商发起请求：anthropic 使用 x-api-key 与 anthropic-version 请求头，其余走 OpenAI 兼容 Authorization */
async function fetchProvider(provider: string, url: string, apiKey: string, body: any, overrides?: RequestOverrides): Promise<any> {
    if (provider !== 'anthropic') return fetchData(url, apiKey, body, provider, overrides);

    const headers: Record<string, string> = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(overrides?.headers ?? {})
    };
    if (overrides?.authHeaderName) headers[overrides.authHeaderName] = apiKey;
    if (overrides?.contentType) headers["Content-Type"] = overrides.contentType;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
        throw ApiError.fromResponse(response.status, provider, text, parseAnthropicRetryAfter(response), '');
    }
    if (!text) {
        throw new Error("响应体为空");
    }
    try {
        const data = JSON.parse(text);
        if (data && data.type === 'error' && data.error) {
            throw ApiError.fromResponse(response.status, provider, text);
        }
        return data;
    } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new Error(`解析响应体时出错:${e instanceof Error ? e.message : String(e)}\n响应体:${text}`);
    }
}

/** anthropic fetch 分支的 Retry-After 头读取（web.ts 封装不可达，单独解析） */
function parseAnthropicRetryAfter(response: Response): number | undefined {
    const v = response.headers.get('Retry-After');
    if (!v) return undefined;
    const secs = parseFloat(v.trim());
    if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs * 1000);
    return undefined;
}

export type { ApiErrorKind };
