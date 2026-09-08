// 网络请求封装（fetch）
import { ApiError, parseRetryAfterSeconds } from "../model/api_error";

/** request 覆盖（由「模型规则」[request] 模板解析而来；未命中时为空） */
export interface FetchDataOverrides {
    headers?: Record<string, string>;
    authHeaderName?: string;
    contentType?: string;
}

export async function fetchData(url: string, apiKey: string, body: any, provider = '', overrides?: FetchDataOverrides): Promise<any> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(overrides?.headers ?? {})
    };
    if (overrides?.authHeaderName) {
        // 自定义鉴权头（如 x-goog-api-key）：原样放 key，不拼 Bearer
        headers[overrides.authHeaderName] = apiKey;
    } else {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (overrides?.contentType) headers["Content-Type"] = overrides.contentType;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    // logger.info("响应体", JSON.stringify(response, null, 2));

    const text = await response.text();
    if (!response.ok) {
        throw ApiError.fromResponse(response.status, provider, text, parseRetryAfterSeconds(response.headers.get('Retry-After')));
    }
    if (!text) {
        throw new Error("响应体为空");
    }

    try {
        const data = JSON.parse(text);
        if (data.error) {
            // 成功状态码但携带业务错误对象（部分网关行为）：同样走分类，便于上层按语义处理
            throw ApiError.fromResponse(response.status, provider, text);
        }
        return data;
    } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new Error(`解析响应体时出错:${e instanceof Error ? e.message : String(e)}\n响应体:${text}`);
    }
}
