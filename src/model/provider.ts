// 模型 Provider：统一模型请求（超时 / 重试 / 用量上报 / use 级 request 覆盖）
import Config from "../config/config";
import { logger } from "../logger";
import { TokenCalibration } from "../token_calibration";
import { UsageManager } from "../usage";
import { StopError, StopEvent, withTimeout } from "../utils/timeout";
import { fetchData, FetchDataType } from "../utils/web";

import { extractUsage } from "./adapter";
import { isAnthropicMessages, isOpenAiResponses, resolveApiDialect } from "./api_dialect";
import { ApiError, ApiErrorKind, classifyApiError } from "./api_error";
import { resolveBaiduToken } from "./baidu_token";
import { requestOverridesFor } from "./request_rules";
import { isMediaUse, ModelUse } from "./types";

const MAX_RETRIES = 2;

export interface RequestModelOptions {
    /** 服务商标识（vendor）：用于错误分类与厂商特例 */
    provider?: string;
    /**
     * 协议方言（v5）：openai-completions / anthropic-messages / openai-responses。
     * 取代"按 provider 名猜协议"；缺省时按 provider 推断（见 api_dialect.ts）。
     */
    api?: string;
    /** 会话停止信号：stop 后立即中止，不再重试 */
    stopEvent?: StopEvent;
    /** 发送前启发式估算的原始 token 数，用于校准 */
    rawEstimateTokens?: number;
    /** 配置中的模型名，优先用于校准 key */
    modelName?: string;
    /** 请求所属用途：命中「模型规则」[request] 模板时应用其 headers/content_type/auth_header_name/timeout 覆盖 */
    use?: ModelUse;
    /** 响应读取方式（媒体二进制响应用 binary）；媒体用途即使不传也按 base64 规则处理 */
    dataType?: FetchDataType;
    /** 直接给定的 request 覆盖（媒体路径：内置预设 ← 「模型规则」[request] 已合成），给定后不再自行查规则 */
    overrides?: RequestOverrides;
    /**
     * 鉴权令牌的获取方式（媒体路径：内置预设 ← 「模型规则」[request] 已合成）。
     * 'baidu-token'：apiKey 按「APIKey:SecretKey」换取 access_token 后使用（见 model/baidu_token.ts）。
     */
    authToken?: string;
    /** 令牌缓存作用域（默认用连接标识；媒体路径传连接序号，避免不同连接互相覆盖） */
    authTokenScope?: string;
}

/** request 覆盖（由「模型规则」[request] 模板解析而来，默认无） */
export interface RequestOverrides {
    headers?: Record<string, string>;
    authHeaderName?: string;
    contentType?: string;
    timeoutMs?: number;
    method?: string;
    /** 鉴权令牌获取方式（如 'baidu-token'：双密钥换 access_token） */
    authToken?: string;
    /** 令牌缓存作用域 */
    authTokenScope?: string;
}

/** 是否值得按指数退避重试：限速/过载/服务端故障/网络层错误（无 HTTP 状态）重试，其余立即失败 */
function isRetryableApiError(err: ApiError): boolean {
    // 运行时不具备的能力（如 goja 无 arrayBuffer）：重试结果不变，直接失败，避免白等退避
    if ((err as any).noRetry === true) return false;
    if (err.kind === 'rate_limit' || err.kind === 'overloaded' || err.kind === 'server') return true;
    // 无 HTTP 状态码（网络中断/超时/解析前失败等）也重试，与历史行为一致
    if (err.status === 0) return true;
    return false;
}

/** 「模型规则」[request]（或内置预设 request 段）→ RequestOverrides（timeout 单位秒转毫秒）；无有效项返回 null */
export function overridesFromRule(ov: Record<string, any> | null | undefined): RequestOverrides | null {
    if (!ov || typeof ov !== 'object') return null;
    const out: RequestOverrides = {};
    if (ov.headers && typeof ov.headers === 'object') {
        out.headers = {};
        for (const k of Object.keys(ov.headers)) out.headers[k] = String(ov.headers[k]);
    }
    if (typeof ov.auth_header_name === 'string' && ov.auth_header_name) out.authHeaderName = ov.auth_header_name;
    if (typeof ov.auth_token === 'string' && ov.auth_token) out.authToken = ov.auth_token;
    if (typeof ov.auth_token_scope === 'string' && ov.auth_token_scope) out.authTokenScope = ov.auth_token_scope;
    if (typeof ov.auth_token === 'string' && ov.auth_token) out.authToken = ov.auth_token;
    if (typeof ov.auth_token_scope === 'string' && ov.auth_token_scope) out.authTokenScope = ov.auth_token_scope;
    if (typeof ov.content_type === 'string' && ov.content_type) out.contentType = ov.content_type;
    if (typeof ov.method === 'string' && ov.method) out.method = ov.method;
    const t = Number(ov.timeout);
    if (Number.isFinite(t) && t > 0) out.timeoutMs = t * 1000;
    return Object.keys(out).length > 0 ? out : null;
}

/** 读取规则模板覆盖（按 use + 模型名查「模型规则」[request]） */
function resolveOverrides(use?: ModelUse, modelRef?: string): RequestOverrides | null {
    if (!use) return null;
    return overridesFromRule(requestOverridesFor(use, modelRef));
}

/**
 * 发起模型请求：带超时、按错误类别重试（限速/过载/服务端/网络类退避重试，
 * 余额/超长/认证等 4xx 不重试）与用量上报。
 * 媒体用途（tts / image-generation）不计入用量与 token 校准：媒体响应里的 usage
 * 字段与对话 token 语义无关，计入会污染统计。
 * @returns 解析后的响应体
 */
export async function requestModel(url: string, apiKey: string, body: any, options: RequestModelOptions = {}): Promise<any> {
    const { TIMEOUT } = Config.base;
    const { provider = '', stopEvent, use } = options;
    const api = resolveApiDialect(options.api, provider);
    const overrides = options.overrides ?? resolveOverrides(use, options.modelName);
    const timeoutMs = overrides?.timeoutMs && overrides.timeoutMs > 0 ? overrides.timeoutMs : TIMEOUT;
    const countUsage = !(use && isMediaUse(use));
    let lastError: Error | null = null;

    // openai-responses 本期未实现：明确报错，避免静默按 chat/completions 发出去（那会得到难懂的 400）
    if (isOpenAiResponses(api, provider)) {
        throw new ApiError(0, provider, 'invalid_request',
            `暂不支持协议 "openai-responses"（连接 ${provider || '(未知)'}）；请改用 openai-completions 或 anthropic-messages`, '');
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const data = await withTimeout(
                () => fetchProvider(provider, api, url, apiKey, body, overrides ?? undefined, options.dataType),
                timeoutMs,
                { stopEvent },
            );
            if (countUsage) {
                const usage = extractUsage(data);
                if (usage) {
                    // 同时按「模型」与「用途」记账（用途用于区分 chat/压缩/归档/评分各花了多少）
                    UsageManager.updateUsage(data.model || '', usage, options.use);
                    TokenCalibration.record(options.modelName || data.model || '', options.rawEstimateTokens || 0, usage.prompt_tokens);
                }
            }
            return data;
        } catch (e) {
            // 会话已停止：直接中止，不再重试，也不把 StopError 当成请求失败记录
            if (e instanceof StopError) throw e;
            const apiErr: ApiError = e instanceof ApiError
                ? e
                : new ApiError(0, provider, classifyApiError(provider, 0, e instanceof Error ? e.message : String(e)), e instanceof Error ? e.message : String(e), '');
            // 普通 Error 上标注的「不可重试」要带到 ApiError 上，否则下面的退避重试仍会白跑
            if ((e as any)?.noRetry === true) (apiErr as any).noRetry = true;
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

/**
 * 按 overrides 声明的 authToken 解析出真正要用的鉴权值：
 * 目前只有 'baidu-token'（apiKey 按「APIKey:SecretKey」换取 access_token）；其余原样返回。
 * 换 token 失败会抛可读错误，由 requestModel 统一分类成请求失败。
 */
async function resolveAuthKey(apiKey: string, overrides?: RequestOverrides): Promise<string> {
    if (overrides?.authToken !== 'baidu-token') return apiKey;
    return resolveBaiduToken(overrides.authTokenScope ?? 'default', apiKey);
}

/** 按协议方言发起请求：anthropic-messages 用 x-api-key 与 anthropic-version，其余走 OpenAI 兼容 Authorization */
async function fetchProvider(provider: string, api: string, url: string, apiKey: string, body: any, overrides?: RequestOverrides, dataType?: FetchDataType): Promise<any> {
    const key = await resolveAuthKey(apiKey, overrides);
    if (!isAnthropicMessages(api, provider)) {
        return fetchData(url, key, body, provider, { ...(overrides ?? {}), dataType });
    }

    const headers: Record<string, string> = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(overrides?.headers ?? {})
    };
    if (overrides?.authHeaderName) headers[overrides.authHeaderName] = key;
    if (overrides?.contentType) headers["Content-Type"] = overrides.contentType;

    const response = await fetch(url, {
        method: overrides?.method || 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body)
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
