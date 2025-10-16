import { AI, AIManager } from "./AI/AI";
import { ToolCall, ToolManager } from "./tool/tool";
import { ConfigManager } from "./config/config";
import { handleMessages, parseBody } from "./utils/utils_message";
import { ImageManager } from "./AI/image";
import { logger } from "./logger";
import { withTimeout } from "./utils/utils";
import { transformTextToArray } from "./utils/utils_string";

export async function sendChatRequest(ctx: seal.MsgContext, msg: seal.Message, ai: AI, messages: {
    role: string,
    content: string,
    tool_calls?: ToolCall[],
    tool_call_id?: string
}[], tool_choice: string): Promise<string> {
    const { url, apiKey, bodyTemplate, timeout } = ConfigManager.request;
    const { isTool, usePromptEngineering } = ConfigManager.tool;
    const tools = ai.tool.getToolsInfo(msg.messageType);

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

            const reply = message.content || '';

            logger.info(`响应内容:`, reply, '\nlatency:', Date.now() - time, 'ms', '\nfinish_reason:', finish_reason);

            if (isTool) {
                if (usePromptEngineering) {
                    const match = reply.match(/<function(?:_call)?>([\s\S]*)<\/function(?:_call)?>/);
                    if (match) {
                        const messageArray = transformTextToArray(match[0]);
                        await ai.context.addMessage(ctx, msg, ai, messageArray, [], "assistant", '');

                        try {
                            await ToolManager.handlePromptToolCall(ctx, msg, ai, match[1]);
                        } catch (e) {
                            logger.error(`在handlePromptToolCall中出错:`, e.message);
                            return '';
                        }

                        const messages = handleMessages(ctx, ai);
                        return await sendChatRequest(ctx, msg, ai, messages, tool_choice);
                    }
                } else {
                    if (message.hasOwnProperty('tool_calls') && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                        logger.info(`触发工具调用`);

                        ai.context.addToolCallsMessage(message.tool_calls);

                        let tool_choice = 'auto';
                        try {
                            tool_choice = await ToolManager.handleToolCalls(ctx, msg, ai, message.tool_calls);
                        } catch (e) {
                            logger.error(`在handleToolCalls中出错:`, e.message);
                            return '';
                        }

                        const messages = handleMessages(ctx, ai);
                        return await sendChatRequest(ctx, msg, ai, messages, tool_choice);
                    }
                }
            }

            return reply;
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendChatRequest中出错:", e.message);
        return '';
    }
}

export async function sendITTRequest(messages: {
    role: string,
    content: {
        type: string,
        image_url?: { url: string }
        text?: string
    }[]
}[], useBase64: boolean): Promise<string> {
    const { timeout } = ConfigManager.request;
    const { url, apiKey, bodyTemplate, urlToBase64 } = ConfigManager.image;

    try {
        const bodyObject = parseBody(bodyTemplate, messages, null, null);
        const time = Date.now();

        const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);

        if (data.choices && data.choices.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const message = data.choices[0].message;
            const reply = message.content || '';

            logger.info(`响应内容:`, reply, '\nlatency', Date.now() - time, 'ms');

            return reply;
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendITTRequest中请求出错:", e.message);
        if (urlToBase64 === '自动' && !useBase64) {
            logger.info(`自动尝试使用转换为base64`);

            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                for (let j = 0; j < message.content.length; j++) {
                    const content = message.content[j];
                    if (content.type === 'image_url') {
                        const { base64, format } = await ImageManager.imageUrlToBase64(content.image_url.url);
                        if (!base64 || !format) {
                            logger.warning(`转换为base64失败`);
                            return '';
                        }

                        message.content[j].image_url.url = `data:image/${format};base64,${base64}`;
                    }
                }
            }

            return await sendITTRequest(messages, true);
        }
        return '';
    }
}

export async function fetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
    // 打印请求发送前的上下文
    const s = JSON.stringify(bodyObject.messages, (key, value) => {
        if (key === "" && Array.isArray(value)) {
            return value.filter(item => item.role !== "system");
        }
        return value;
    });
    logger.info(`请求发送前的上下文:\n`, s);

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

export class StreamWebSocket {
    private ws: WebSocket | null = null;
    private streamId: string = '';
    private messageCallback: ((data: any) => void) | null = null;
    private errorCallback: ((error: string) => void) | null = null;
    private closeCallback: (() => void) | null = null;
    private isConnected: boolean = false;

    constructor(private streamUrl: string) {}

    async connect(messages: any[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const { url, apiKey, bodyTemplate, timeout } = ConfigManager.request;
            const wsUrl = this.streamUrl.replace('http', 'ws') + '/ws';

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

                this.ws = new WebSocket(wsUrl);
                this.isConnected = false;

                // 设置超时
                const timeoutId = setTimeout(() => {
                    if (!this.isConnected) {
                        reject(new Error('WebSocket连接超时'));
                        this.close();
                    }
                }, timeout);

                this.ws.onopen = () => {
                    clearTimeout(timeoutId);
                    this.isConnected = true;
                    // 发送初始化数据
                    this.ws!.send(JSON.stringify({
                        url: url,
                        api_key: apiKey,
                        body_obj: bodyObject
                    }));
                };

                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        
                        if (data.type === 'connected') {
                            this.streamId = data.stream_id;
                            resolve(this.streamId);
                        } else if (data.type === 'error') {
                            if (this.errorCallback) {
                                this.errorCallback(data.error);
                            }
                        } else if (this.messageCallback) {
                            this.messageCallback(data);
                        }
                    } catch (e) {
                        logger.error('解析WebSocket消息失败:', e);
                    }
                };

                this.ws.onerror = (error) => {
                    clearTimeout(timeoutId);
                    if (!this.isConnected) {
                        reject(new Error(`WebSocket连接错误: ${error}`));
                    } else if (this.errorCallback) {
                        this.errorCallback('WebSocket连接错误');
                    }
                };

                this.ws.onclose = () => {
                    clearTimeout(timeoutId);
                    if (this.closeCallback) {
                        this.closeCallback();
                    }
                };

            } catch (e) {
                reject(new Error(`创建WebSocket连接失败: ${e.message}`));
            }
        });
    }

    onMessage(callback: (data: any) => void) {
        this.messageCallback = callback;
    }

    onError(callback: (error: string) => void) {
        this.errorCallback = callback;
    }

    onClose(callback: () => void) {
        this.closeCallback = callback;
    }

    sendCancel() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'cancel' }));
        }
    }

    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
        }
    }

    getStreamId(): string {
        return this.streamId;
    }

    isOpen(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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