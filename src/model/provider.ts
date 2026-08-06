// 模型 Provider：统一模型请求（超时 / 重试 / 用量上报）
import Config from "../config/config";
import { logger } from "../logger";
import { UsageManager } from "../usage";
import { withTimeout } from "../utils/utils";
import { fetchData } from "../utils/web";

import { extractUsage } from "./adapter";

const MAX_RETRIES = 2;

export interface RequestModelOptions {
    /** API 提供商：anthropic 使用 x-api-key 请求头与 /messages 协议 */
    provider?: string;
}

/**
 * 发起模型请求：带超时、失败重试（4xx 不重试）与用量上报。
 * @returns 解析后的响应体
 */
export async function requestModel(url: string, apiKey: string, body: any, options: RequestModelOptions = {}): Promise<any> {
    const { TIMEOUT } = Config.base;
    const { provider = '' } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const data = await withTimeout(() => fetchProvider(provider, url, apiKey, body), TIMEOUT);
            const usage = extractUsage(data);
            if (usage) {
                UsageManager.updateUsage(data.model || '', usage);
            }
            return data;
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            const message = lastError ? lastError.message : '';
            // 客户端错误（4xx）不重试，属于请求本身问题
            if (/状态码: [45]\d\d/.test(message)) break;
            if (attempt < MAX_RETRIES) {
                const delay = 500 * Math.pow(2, attempt);
                logger.warning(`模型请求失败，${delay}ms 后进行第 ${attempt + 1} 次重试: ${message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

/** 按提供商发起请求：anthropic 使用 x-api-key 与 anthropic-version 请求头 */
async function fetchProvider(provider: string, url: string, apiKey: string, body: any): Promise<any> {
    if (provider !== 'anthropic') return fetchData(url, apiKey, body);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`请求失败! 状态码: ${response.status}\n响应体:${text}`);
    }
    if (!text) {
        throw new Error("响应体为空");
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`解析响应体时出错:${e instanceof Error ? e.message : String(e)}\n响应体:${text}`);
    }
}
