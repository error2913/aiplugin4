import { ConfigManager } from "./config";

export class RequestConfig {
    static ext: seal.ExtInfo;

    static register() {
        RequestConfig.ext = ConfigManager.getExt('aiplugin4');

        seal.ext.registerStringConfig(RequestConfig.ext, "url地址", "https://api.deepseek.com/v1/chat/completions", '');
        seal.ext.registerStringConfig(RequestConfig.ext, "API Key", "你的API Key", '');
        seal.ext.registerTemplateConfig(RequestConfig.ext, "body", [
            `"model":"deepseek-chat"`,
            `"max_tokens":1024`,
            `"stop":null`,
            `"stream":false`,
            `"frequency_penalty":0`,
            `"presence_penalty":0`,
            `"temperature":1`,
            `"top_p":1`
        ], "messages,tools,tool_choice不存在时，将会自动替换。具体参数请参考你所使用模型的接口文档");
        seal.ext.registerIntConfig(RequestConfig.ext, "请求超时时限/ms", 180000, '');
    }

    static get() {
        return {
            url: seal.ext.getStringConfig(RequestConfig.ext, "url地址"),
            apiKey: seal.ext.getStringConfig(RequestConfig.ext, "API Key"),
            bodyTemplate: seal.ext.getTemplateConfig(RequestConfig.ext, "body"),
            timeout: seal.ext.getIntConfig(RequestConfig.ext, "请求超时时限/ms")
        }
    }
}