// 联网搜索 HTTP 执行：超时、JSON/text 读取、错误分类。
// 复用模型层的 ApiError（状态码/错误类别/Retry-After），不掺业务语义。

import { ApiError, parseRetryAfterSeconds } from '../model/api_error';
import { withTimeout } from '../utils/utils';

import { BuiltRequest } from './types';

export interface ExecuteOptions {
    timeoutMs: number;
    provider: string;
    /** 为 true 时把响应体当纯文本返回（generic 抓取的 response_type=text） */
    asText?: boolean;
    /** 单元测试注入 */
    fetchImpl?: typeof fetch;
}

/**
 * 执行一个已构造好的请求并返回响应体：
 * - asText=false：解析 JSON（解析失败抛错）
 * - asText=true：返回原始文本
 * 非 2xx 一律抛 ApiError（含 Retry-After）。
 */
export async function executeRequest(req: BuiltRequest, opts: ExecuteOptions): Promise<any> {
    const fetchFn = opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { ...req.headers };
    let body: string | undefined;
    if (req.method !== 'GET' && req.body !== undefined) {
        body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const response = await withTimeout(
        () => fetchFn(req.url, { method: req.method, headers, body }),
        opts.timeoutMs,
    );

    const text = await response.text();
    if (!response.ok) {
        const retryAfter = parseRetryAfterSeconds(response.headers?.get?.('Retry-After'));
        throw ApiError.fromResponse(response.status, opts.provider, text, retryAfter);
    }
    if (opts.asText) return text;
    if (!text) throw new Error('响应体为空');
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`响应不是合法 JSON：${e instanceof Error ? e.message : String(e)}\n响应体:${text.slice(0, 300)}`);
    }
}

/** 是否值得重试（限速/过载/服务端/网络层无状态码）；参数错误不重试 */
export function isRetryable(err: any): boolean {
    if (err instanceof ApiError) {
        if (err.kind === 'rate_limit' || err.kind === 'overloaded' || err.kind === 'server') return true;
        if (err.status === 0) return true;
        return false;
    }
    // 超时/网络中断等普通 Error（无状态码）重试一次
    return true;
}

/** 是否应该换下一个 provider（参数/配置类错误不换，避免掩盖配置问题） */
export function shouldFallback(err: any): boolean {
    if (err instanceof ApiError) {
        // 400/422 等参数错误：配置问题，换家只会掩盖
        if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 402 && err.status !== 403 && err.status !== 429) {
            return false;
        }
        return true;
    }
    return true;
}
