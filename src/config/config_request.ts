import { ConfigManager } from "./config";

export class RequestConfig {
    static register() {
        seal.ext.registerStringConfig(ConfigManager.ext, "url地址", "https://api.deepseek.com/v1/chat/completions", '');
        seal.ext.registerStringConfig(ConfigManager.ext, "API Key", "你的API Key", '');
        seal.ext.registerTemplateConfig(ConfigManager.ext, "body", [
            `"messages":null`,
            `"model":"deepseek-chat"`,
            `"max_tokens":70`,
            `"stop":null`,
            `"stream":false`,
            `"response_format":{"type":"text"}`,
            `"frequency_penalty":0`,
            `"presence_penalty":0`,
            `"temperature":1`,
            `"top_p":1`,
            `"tools":null`,
            `"tool_choice":null`
        ], "messages,tools,tool_choice为null时，将会自动替换。具体参数请参考你所使用模型的接口文档");
    }

    static get() {
        return {
            url: seal.ext.getStringConfig(ConfigManager.ext, "url地址"),
            apiKey: seal.ext.getStringConfig(ConfigManager.ext, "API Key"),
            bodyTemplate: seal.ext.getTemplateConfig(ConfigManager.ext, "body")
        }
    }
}