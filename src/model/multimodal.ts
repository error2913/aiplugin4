// 多模态模型：图片理解（callITT）与多模态对话
import Logger from "../logger";

import { BaseModel } from "./model";
import { requestModel } from "./provider";
import { ModelBody, ModelUse, MultimodalModelUse } from "./types";

const log = Logger.withTag('multimodal');

export default class MultimodalModel extends BaseModel {
    use: MultimodalModelUse[];
    constructor(use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, provider, base_url, api_key, body);
        this.use = use as MultimodalModelUse[];
    }

    get isMultimodal(): boolean {
        return true;
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
            log.printRequestMessages(body.messages);

            const time = Date.now();
            const data = await requestModel(this.url, this.apiKey, body);
            if (data.choices && data.choices.length > 0) {
                const message = data.choices[0].message;
                const content = message.content || '';

                log.info(`响应内容(${Date.now() - time}ms): ${content.length > 500 ? content.slice(0, 500) + `…(+${content.length - 500})` : content}`);

                return content;
            } else {
                throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
            }
        } catch (e) {
            log.exception('在调用模型' + this.name + '中出错', e);
            return '';
        }
    }

}

