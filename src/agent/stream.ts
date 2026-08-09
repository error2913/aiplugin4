// 流式/非流式请求服务：基于 Model 配置构建请求体并调用后端
import Config from "../config/config";
import { DEFAULT_CHAT_MODEL_BODY } from "../config/static_config";
import { logger } from "../logger";
import { buildProviderBody, parseProviderResponse } from "../model/adapter";
import ChatModel from "../model/chat";
import Model from "../model/model";
import { requestModel } from "../model/provider";
import { ToolCall } from "../tool/types";
import { UsageManager } from "../usage";
import { RequestMessage } from "../utils/message";
import { withTimeout } from "../utils/utils";

export class streamService {
    static async startStream(messages: any[], modelName: string = ''): Promise<string> {
        const { TIMEOUT: timeout } = Config.base;
        const { STREAM: streamUrl } = Config.backend;
        const model = Model.getChatModel('chat', modelName);
        if (!model) {
            logger.error('未找到可用的对话模型');
            return '';
        }
        try {
            const body = model.buildBody({
                model: model.name,
                messages
            }, DEFAULT_CHAT_MODEL_BODY);

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
            logger.error("在startStream中出错:", e instanceof Error ? e.message : String(e));
            return '';
        }
    }


    /**
     * 非流式对话请求（从旧 src/service.ts 的 sendChatRequest 移植，改用新 Model 配置）
     */
    static async sendChatRequest(messages: RequestMessage[], tools: any[], tool_choice: string, modelName: string = ''): Promise<{ content: string, tool_calls: ToolCall[] }> {
        const model = Model.getChatModel('chat', modelName) as ChatModel;
        if (!model) {
            logger.error('未找到可用的对话模型');
            return { content: '', tool_calls: [] };
        }
        try {
            const { STATUS, PROMPT_ENGINEERING } = Config.tool;
            const body = model.buildBody({
                model: model.name,
                messages
            }, DEFAULT_CHAT_MODEL_BODY);
            if (STATUS && !PROMPT_ENGINEERING) {
                if (tools && tools.length > 0) body.tools = tools;
                body.tool_choice = tool_choice;
            }
            logger.printRequestMessages(body.messages);

            const time = Date.now();
            const data = await requestModel(model.url, model.apiKey, buildProviderBody(model.provider, body), { provider: model.provider });
            const response = parseProviderResponse(model.provider, data);
            if (response.choices && response.choices.length > 0) {
                const message = response.choices[0].message;
                const finish_reason = response.choices[0].finish_reason;

                if (Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) {
                    logger.info('思维链内容:', message.reasoning_content);
                }

                const content = message.content || '';

                logger.info('响应内容:', content, '\nlatency:', Date.now() - time, 'ms', '\nfinish_reason:', finish_reason);

                return { content, tool_calls: message.tool_calls || [] };
            } else {
                throw new Error('服务器响应中没有choices或choices为空\n响应体:' + JSON.stringify(data, null, 2));
            }
        } catch (e) {
            logger.error('在sendChatRequest中出错:', e instanceof Error ? e.message : String(e));
            return { content: '', tool_calls: [] };
        }
    }

    static async pollStream(streamId: string, after: number): Promise<{ status: string, reply: string, nextAfter: number }> {
        const { STREAM: streamUrl } = Config.backend;

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
            logger.error("在pollStream中出错:", e instanceof Error ? e.message : String(e));
            return { status: 'failed', reply: '', nextAfter: 0 };
        }
    }

    static async endStream(streamId: string): Promise<string> {
        const { STREAM: streamUrl } = Config.backend;

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
            logger.error("在endStream中出错:", e instanceof Error ? e.message : String(e));
            return '';
        }
    }
}
