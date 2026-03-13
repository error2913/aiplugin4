import Agent from "../agent/agent";
import { UsageManager } from "../agent/usage";
import { Config } from "../config/config";
import { DEFAULT_CHAT_MODEL_BODY } from "../config/static_config";
import { logger } from "../logger";
import { ToolCall } from "../tool/types";
import { withTimeout } from "../utils/utils";
import { fetchData } from "../utils/web";
import { BaseModel } from "./model";
import { ChatModelUse, ModelBody } from "./types";

export default class ChatModel extends BaseModel {
    use: ChatModelUse[];
    constructor(use: ChatModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, provider, base_url, api_key, body);
        this.use = use;
    }

    get url() {
        return `${this.baseUrl}/chat/completions`;
    }

    async callChat(agent: Agent, sessionId: string): Promise<{ content: string, tool_calls: ToolCall[] }> {
        const { TIMEOUT } = Config.base;
        try {
            const body = this.buildBody({
                ...DEFAULT_CHAT_MODEL_BODY,
                messages: agent.sessionService.getSession(sessionId).getMessages(),
                tools: agent.getRequestTools()
            });
            logger.logMessages(body)

            const time = Date.now();
            const data = await withTimeout(() => fetchData(this.url, this.apiKey, body), TIMEOUT);
            if (data.choices && data.choices.length > 0) {
                UsageManager.updateUsage(data.model, data.usage);

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
            logger.error(`在调用模型${this.name}中出错:`, e.message);
            return { content: '', tool_calls: [] };
        }
    }
}