// 模型 Provider：统一模型请求（超时 / 重试 / 用量上报）
import Config from "../config/config";
import { logger } from "../logger";
import { UsageManager } from "../usage";
import { withTimeout } from "../utils/utils";
import { fetchData } from "../utils/web";

const MAX_RETRIES = 2;

/**
 * 发起模型请求：带超时、失败重试（4xx 不重试）与用量上报。
 * @returns 解析后的响应体
 */
export async function requestModel(url: string, apiKey: string, body: any): Promise<any> {
    const { TIMEOUT } = Config.base;
    let lastError: Error = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const data = await withTimeout(() => fetchData(url, apiKey, body), TIMEOUT);
            if (data && data.usage) {
                UsageManager.updateUsage(data.model || '', data.usage);
            }
            return data;
        } catch (e) {
            lastError = e;
            const message = e && e.message ? String(e.message) : '';
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
