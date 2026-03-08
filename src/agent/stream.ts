import { Config } from "../config/config";
import { logger } from "../logger";
import { withTimeout } from "../utils/utils";
import { Agent } from "./agent";
import { ModelManager } from "./model";
import { UsageManager } from "./usage";

export class streamService {
    static async startStream(agent: Agent, sessionId: string): Promise<string> {
        const { timeout } = Config.request;
        const { streamUrl } = Config.backend;
        const model = ModelManager.getChatModel('chat');
        try {
            const body = model.buildChatBody(agent, sessionId);

            // 打印请求发送前的上下文
            const s = JSON.stringify(body.messages, (key, value) => {
                if (key === "" && Array.isArray(value)) {
                    return value.filter(item => item.role !== "system");
                }
                return value;
            });
            logger.info(`请求发送前的上下文:\n`, s);

            const response = await withTimeout(() => fetch(`${streamUrl}/start`, {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    url: model.url,
                    api_key: model.apiKey,
                    body_obj: body
                })
            }), timeout);

            // logger.info("响应体", JSON.stringify(response, null, 2));

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`请求失败! 状态码: ${response.status}\n响应体:${text}`);
            }
            if (!text) {
                throw new Error("响应体为空");
            }

            try {
                const data = JSON.parse(text);
                if (data.error) {
                    throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                }
                if (!data.id) {
                    throw new Error("服务器响应中没有id字段");
                }
                return data.id;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (e) {
            logger.error("在startStream中出错:", e.message);
            return '';
        }
    }

    static async pollStream(streamId: string, after: number): Promise<{ status: string, reply: string, nextAfter: number }> {
        const { streamUrl } = Config.backend;

        try {
            const response = await fetch(`${streamUrl}/poll?id=${streamId}&after=${after}`, {
                method: 'GET',
                headers: {
                    "Accept": "application/json"
                }
            });

            // logger.info("响应体", JSON.stringify(response, null, 2));

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`请求失败! 状态码: ${response.status}\n响应体:${text}`);
            }
            if (!text) {
                throw new Error("响应体为空");
            }

            try {
                const data = JSON.parse(text);
                if (data.error) {
                    throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                }
                if (!data.status) {
                    throw new Error("服务器响应中没有status字段");
                }
                return {
                    status: data.status,
                    reply: data.results.join(''),
                    nextAfter: data.next_after
                };
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (e) {
            logger.error("在pollStream中出错:", e.message);
            return { status: 'failed', reply: '', nextAfter: 0 };
        }
    }

    static async endStream(streamId: string): Promise<string> {
        const { streamUrl } = Config.backend;

        try {
            const response = await fetch(`${streamUrl}/end?id=${streamId}`, {
                method: 'GET',
                headers: {
                    "Accept": "application/json"
                }
            });

            // logger.info("响应体", JSON.stringify(response, null, 2));

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`请求失败! 状态码: ${response.status}\n响应体:${text}`);
            }
            if (!text) {
                throw new Error("响应体为空");
            }

            try {
                const data = JSON.parse(text);
                if (data.error) {
                    throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                }
                if (!data.status) {
                    throw new Error("服务器响应中没有status字段");
                }
                logger.info('对话结束', data.status === 'success' ? '成功' : '失败');
                if (data.status === 'success') {
                    UsageManager.updateUsage(data.model, data.usage);
                }
                return data.status;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (e) {
            logger.error("在endStream中出错:", e.message);
            return '';
        }
    }
}