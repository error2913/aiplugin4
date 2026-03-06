import { ConfigManager } from "../config/configManager";
import { parseBody } from "../utils/utils_message";
import { logger } from "../logger";
import { withTimeout } from "../utils/utils";

export async function startStream(messages: {
    role: string,
    content: string
}[]): Promise<string> {
    const { url, apiKey, bodyTemplate, timeout } = ConfigManager.request;
    const { streamUrl } = ConfigManager.backend;

    try {
        const bodyObject = parseBody(bodyTemplate, messages, null, null);

        // 打印请求发送前的上下文
        const s = JSON.stringify(bodyObject.messages, (key, value) => {
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
                url: url,
                api_key: apiKey,
                body_obj: bodyObject
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

export async function pollStream(id: string, after: number): Promise<{ status: string, reply: string, nextAfter: number }> {
    const { streamUrl } = ConfigManager.backend;

    try {
        const response = await fetch(`${streamUrl}/poll?id=${id}&after=${after}`, {
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

export async function endStream(id: string): Promise<string> {
    const { streamUrl } = ConfigManager.backend;

    try {
        const response = await fetch(`${streamUrl}/end?id=${id}`, {
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
                AIManager.updateUsage(data.model, data.usage);
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

export async function get_chart_url(chart_type: string, usage_data: {
    [key: string]: {
        prompt_tokens: number;
        completion_tokens: number;
    }
}) {
    const { usageChartUrl } = ConfigManager.backend;
    try {
        const response = await fetch(`${usageChartUrl}/chart`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                chart_type: chart_type,
                data: usage_data
            })
        })

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
        }
        if (!text) {
            throw new Error("响应体为空");
        }

        try {
            const data = JSON.parse(text);
            if (data.error) {
                throw new Error(`请求失败! 错误信息: ${data.error.message}`);
            }
            return data.image_url;
        } catch (e) {
            throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
        }
    } catch (e) {
        logger.error("在get_chart_url中请求出错:", e.message);
        return '';
    }
}