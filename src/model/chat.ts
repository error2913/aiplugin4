// 纯文本模型：模型元数据与请求地址
import { BaseModel } from "./model";
import { ChatModelUse, ModelBody, ModelUse } from "./types";

export default class ChatModel extends BaseModel {
    use: ChatModelUse[];
    constructor(use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, provider, base_url, api_key, body);
        this.use = use as ChatModelUse[];
    }

    get url() {
        return this.provider === 'anthropic' ? `${this.baseUrl}/messages` : `${this.baseUrl}/chat/completions`;
    }
}
