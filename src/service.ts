import { AIManager } from "./AI/AI";
import { ToolCall, ToolInfo } from "./tool/tool";
import { ConfigManager } from "./config/configManager";
import { parseBody, parseEmbeddingBody } from "./utils/utils_message";
import { logger } from "./logger";
import { withTimeout } from "./utils/utils";

export async function sendChatRequest(messages: {
    role: string,
    content: string,
    tool_calls?: ToolCall[],
    tool_call_id?: string
}[], tools: ToolInfo[], tool_choice: string): Promise<{ content: string, tool_calls: ToolCall[] }> {
    const { url, apiKey, bodyTemplate, timeout } = ConfigManager.request;

    try {
        const bodyObject = parseBody(bodyTemplate, messages, tools, tool_choice);
        const time = Date.now();

        const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);

        if (data.choices && data.choices.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const message = data.choices[0].message;
            const finish_reason = data.choices[0].finish_reason;

            if (message.hasOwnProperty('reasoning_content')) {
                logger.info(`思维链内容:`, message.reasoning_content);
            }

            const content = message.content || '';

            logger.info(`响应内容:`, content, '\nlatency:', Date.now() - time, 'ms', '\nfinish_reason:', finish_reason);

            return { content, tool_calls: message.tool_calls || [] };
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendChatRequest中出错:", e.message);
        return { content: '', tool_calls: [] };
    }
}

export async function sendITTRequest(messages: {
    role: string,
    content: {
        type: string,
        image_url?: { url: string }
        text?: string
    }[]
}[]): Promise<string> {
    const { timeout } = ConfigManager.request;
    const { url, apiKey, bodyTemplate } = ConfigManager.image;

    try {
        const bodyObject = parseBody(bodyTemplate, messages, null, null);
        const time = Date.now();

        const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);

        if (data.choices && data.choices.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const message = data.choices[0].message;
            const content = message.content || '';

            logger.info(`响应内容:`, content, '\nlatency', Date.now() - time, 'ms');

            return content;
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendITTRequest中请求出错:", e.message);
        return '';
    }
}

export async function sendContextCompressRequest(messages: {
    role: string,
    content: string
}[]): Promise<string> {
    const { timeout, url: chatUrl, apiKey: chatApiKey } = ConfigManager.request;
    const { contextCompressUrl, contextCompressApiKey, contextCompressBodyTemplate } = ConfigManager.message;

    let url = chatUrl;
    let apiKey = chatApiKey;
    if (contextCompressUrl.trim()) {
        url = contextCompressUrl;
        apiKey = contextCompressApiKey;
    }

    try {
        const bodyObject = parseBody(contextCompressBodyTemplate, messages, [], "none");
        const time = Date.now();

        const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);

        if (data.choices && data.choices.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const message = data.choices[0].message;
            const content = message.content || '';

            logger.info(`上下文压缩响应内容:`, content, '\nlatency:', Date.now() - time, 'ms');

            return content;
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendContextCompressRequest中请求出错:", e.message);
        return '';
    }
}

const vectorCache: { text: string, vector: number[] } = { text: '', vector: [] };

export async function getEmbedding(text: string): Promise<number[]> {
    if (!text) {
        logger.warning(`getEmbedding: 文本为空`);
        return [];
    }

    const { timeout } = ConfigManager.request;
    const { embeddingDimension, embeddingUrl, embeddingApiKey, embeddingBodyTemplate } = ConfigManager.memory;

    if (vectorCache.text === text && vectorCache.vector.length === embeddingDimension) {
        const v = vectorCache.vector;
        return v;
    }

    try {
        const bodyObject = parseEmbeddingBody(embeddingBodyTemplate, text, embeddingDimension);
        const time = Date.now();

        const data = await withTimeout(() => fetchData(embeddingUrl, embeddingApiKey, bodyObject), timeout);

        if (data.data && data.data.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const embedding = data.data[0].embedding;

            logger.info(`文本:`, text, `\n响应embedding长度:`, embedding.length, '\nlatency:', Date.now() - time, 'ms');
            vectorCache.text = text;
            vectorCache.vector = embedding;

            return embedding;
        } else {
            throw new Error(`服务器响应中没有data或data为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在getEmbedding中出错:", e.message);
        return [];
    }
}

export async function fetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
    // 打印请求发送前的上下文
    if (bodyObject.hasOwnProperty('messages')) {
        const s = JSON.stringify(bodyObject.messages, (key, value) => {
            if (key === "" && Array.isArray(value)) {
                return value.filter(item => item.role !== "system");
            }
            return value;
        });
        logger.info(`请求发送前的上下文:\n`, s);
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(bodyObject)
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
        return data;
    } catch (e) {
        throw new Error(`解析响应体时出错:${e.message}\n响应体:${text}`);
    }
}

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