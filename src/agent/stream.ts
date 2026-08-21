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
import { estimateTextTokens, RequestMessage } from "../utils/message";
import { withTimeout } from "../utils/utils";

const log = logger.withTag('model');

/**
 * 请求体消息净化（防御层）：一次遍历同时完成——
 * 1) 删除空 tool_calls 数组；
 * 2) 删除没有匹配 assistant tool_calls 的 tool 消息（缺 tool_call_id 或引用不存在的调用）；
 * 3) 删除 assistant tool_calls 中引用不存在 tool 结果的调用项。
 * handleMessages 已保证正常路径不产生这些脏数据，此处兜底外部调用（如其他插件经
 * globalThis.aiplugin4.chatMessages 传入的 messages）与历史持久化数据。
 */
function sanitizeRequestMessages(messages: any[]): any[] {
    const list = (messages || []).filter(m => m && typeof m === 'object');
    if (list.length === 0) return [];

    // 先收集两侧引用：tool 结果携带的 tool_call_id 与 assistant 声明的 tool_call id
    const toolResultIds = new Set<string>();
    const assistantCallIds = new Set<string>();
    for (const m of list) {
        if (m.role === 'tool' && m.tool_call_id) toolResultIds.add(m.tool_call_id);
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) if (tc && tc.id) assistantCallIds.add(tc.id);
        }
    }

    const result: any[] = [];
    for (const m of list) {
        const out = { ...m };
        if (Array.isArray(out.tool_calls) && out.tool_calls.length === 0) delete out.tool_calls;

        if (out.role === 'tool') {
            const id = out.tool_call_id;
            if (!id || !assistantCallIds.has(id)) {
                log.warning('剔除没有匹配 assistant tool_calls 的 tool 消息');
                continue;
            }
            result.push(out);
            continue;
        }

        if (out.role === 'assistant' && Array.isArray(out.tool_calls) && out.tool_calls.length > 0) {
            const kept = out.tool_calls.filter((tc: any) => tc && tc.id && toolResultIds.has(tc.id));
            if (kept.length === 0) {
                log.warning('剔除引用不存在 tool 结果的 assistant tool_calls');
                delete out.tool_calls;
            } else if (kept.length < out.tool_calls.length) {
                log.warning('剔除部分引用不存在 tool 结果的 assistant tool_call');
                out.tool_calls = kept;
            }
        }
        result.push(out);
    }
    return result;
}

/** 发送前校验整包预算：估算 messages + tools 的 token 总量，超出「上下文最大token」时告警 */
function checkRequestBudget(messages: any[], tools: any[]): void {
    const { MAX_CONTEXT_TOKENS: maxTokens } = Config.message;
    if (maxTokens <= 0) return;
    const toolsEstimate = tools && tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0;
    const estimate = estimateTextTokens(JSON.stringify(messages || [])) + toolsEstimate;
    if (estimate > maxTokens) {
        log.warning(`请求体估算 token（含 tools JSON）超出「上下文最大token」预算: ${estimate} / ${maxTokens}`);
    }
}

export class streamService {
    static async startStream(messages: any[], modelName: string = '', runId: string = ''): Promise<string> {
        const { TIMEOUT: timeout } = Config.base;
        const { STREAM: streamUrl } = Config.backend;
        const model = Model.getChatModel('chat', modelName);
        if (!model) {
            log.error('未找到可用的对话模型');
            return '';
        }
        try {
            const body = model.buildBody({
                model: model.name,
                messages
            }, DEFAULT_CHAT_MODEL_BODY);
            body.messages = sanitizeRequestMessages(body.messages);

            // 打印请求发送前的上下文
            log.printRequestMessages(body.messages, runId);

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

            // log.info("响应体", JSON.stringify(response, null, 2));

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
            log.exception('startStream', e);
            return '';
        }
    }


    /**
     * 非流式对话请求（从旧 src/service.ts 的 sendChatRequest 移植，改用新 Model 配置）
     */
    static async sendChatRequest(messages: RequestMessage[], tools: any[], tool_choice: string, modelName: string = '', runId: string = ''): Promise<{ content: string, tool_calls: ToolCall[] }> {
        const model = Model.getChatModel('chat', modelName) as ChatModel;
        if (!model) {
            log.error('未找到可用的对话模型');
            return { content: '', tool_calls: [] };
        }
        try {
            const { STATUS, PROMPT_ENGINEERING } = Config.tool;
            const body = model.buildBody({
                model: model.name,
                messages
            }, DEFAULT_CHAT_MODEL_BODY);
            body.messages = sanitizeRequestMessages(body.messages);
            if (STATUS && !PROMPT_ENGINEERING) {
                if (tools && tools.length > 0) body.tools = tools;
                body.tool_choice = tool_choice;
            }
            checkRequestBudget(body.messages, tools || []);
            log.printRequestMessages(body.messages, runId);

            const time = Date.now();
            const data = await requestModel(model.url, model.apiKey, buildProviderBody(model.provider, body), { provider: model.provider });
            const response = parseProviderResponse(model.provider, data);
            if (response.choices && response.choices.length > 0) {
                const message = response.choices[0].message;
                const finish_reason = response.choices[0].finish_reason;

                if (Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) {
                    const reasoning = message.reasoning_content || '';
                    const shownR = reasoning.length > 500 ? reasoning.slice(0, 500) + `…(+${reasoning.length - 500})` : reasoning;
                    log.info(`思维链内容(${reasoning.length}字符): ${shownR}`);
                }

                const content = message.content || '';
                const shown = content.length > 300 ? content.slice(0, 300) + `…(+${content.length - 300})` : content;
                log.info(`响应内容(${Date.now() - time}ms, finish=${finish_reason}): ${shown}`);

                return { content, tool_calls: message.tool_calls || [] };
            } else {
                throw new Error('服务器响应中没有choices或choices为空\n响应体:' + JSON.stringify(data, null, 2));
            }
        } catch (e) {
            log.exception('sendChatRequest', e);
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

            // log.info("响应体", JSON.stringify(response, null, 2));

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
            log.exception('pollStream', e);
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

            // log.info("响应体", JSON.stringify(response, null, 2));

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
                log.info('对话结束', data.status === 'success' ? '成功' : '失败');
                if (data.status === 'success') {
                    UsageManager.updateUsage(data.model, data.usage);
                }
                return data.status;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (e) {
            log.exception('endStream', e);
            return '';
        }
    }
}
