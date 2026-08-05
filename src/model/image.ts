// 图片模型：图片理解（callITT）与图片对话
import Agent from "../agent/agent";
import { DEFAULT_IMAGE_MODEL_BODY } from "../config/static_config";
import Logger from "../logger";
import { ToolCall } from "../tool/types";

import { BaseModel } from "./model";
import { requestModel } from "./provider";
import { ImageModelUse, ModelBody, ModelUse } from "./types";

export default class ImageModel extends BaseModel {
    use: ImageModelUse[];
    constructor(use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, provider, base_url, api_key, body);
        this.use = use as ImageModelUse[];
    }

    get url() {
        return `${this.baseUrl}/chat/completions`;
    }

    async callITT(src: string, prompt = ''): Promise<string> {
        try {
            const body = this.buildBody({
                model: this.name,
                messages: [{
                    role: "user",
                    content: [{
                        "type": "image_url",
                        "image_url": { "url": src }
                    }, {
                        "type": "text",
                        "text": prompt
                    }]
                }]
            });
            Logger.printRequestMessages(body.messages);

            const time = Date.now();
            const data = await requestModel(this.url, this.apiKey, body);
            if (data.choices && data.choices.length > 0) {
                const message = data.choices[0].message;
                const content = message.content || '';

                Logger.info(`响应内容:`, content.length > 500 ? content.slice(0, 500) + `…(+${content.length - 500})` : content, '\nlatency', Date.now() - time, 'ms');

                return content;
            } else {
                throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
            }
        } catch (e) {
            Logger.error(`在调用模型${this.name}中出错:`, e instanceof Error ? e.message : String(e));
            return '';
        }
    }

    async callChat(agent: Agent, sessionId: string): Promise<{ content: string, tool_calls: ToolCall[] }> {
        try {
            const body = this.buildBody({
                model: this.name,
                messages: await agent.sessionService.getSession(sessionId).getImageMessages(),
                tools: agent.getRequestTools(agent.sessionService.getSession(sessionId))
            }, DEFAULT_IMAGE_MODEL_BODY);
            Logger.printRequestMessages(body.messages);

            const time = Date.now();
            const data = await requestModel(this.url, this.apiKey, body);
            if (data.choices && data.choices.length > 0) {
                const message = data.choices[0].message;
                const finish_reason = data.choices[0].finish_reason;

                if (Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) {
                    Logger.info(`思维链内容:`, message.reasoning_content);
                }

                const content = message.content || '';

                Logger.info(`响应内容:`, content.length > 500 ? content.slice(0, 500) + `…(+${content.length - 500})` : content, '\nlatency:', Date.now() - time, 'ms', '\nfinish_reason:', finish_reason);

                return { content, tool_calls: message.tool_calls || [] };
            } else {
                throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
            }
        } catch (e) {
            Logger.error(`在调用模型${this.name}中出错:`, e instanceof Error ? e.message : String(e));
            return { content: '', tool_calls: [] };
        }
    }
}
