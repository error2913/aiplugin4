// 网络请求封装（fetch）
import { ApiError, parseRetryAfterSeconds } from "../model/api_error";

export async function fetchData(url: string, apiKey: string, body: any, provider = ''): Promise<any> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
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
