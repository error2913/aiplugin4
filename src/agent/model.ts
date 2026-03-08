import { Config } from "../config/config";
import { logger } from "../logger";
import { ToolCall } from "../tool/types";
import { withTimeout } from "../utils/utils";
import { Agent } from "./agent";
import { UsageManager } from "./usage";

export type ModelUse = 'any' | 'chat' | 'image-understanding' | 'text-embedding'

export interface ModelBody {
    max_tokens?: number,
    stop?: string[] | null,
    stream?: boolean,
    temperature?: number,
    top_p?: number,
    [key: string]: any
}

export class BaseModel {
    name: string;
    use: ModelUse[];
    provider: string;
    baseUrl: string;
    apiKey: string;
    body: ModelBody;

    constructor(name: string, use: ModelUse[], provider: string, base_url: string, api_key: string, body: ModelBody) {
        this.name = name;
        this.use = use;
        this.provider = provider;
        this.baseUrl = base_url;
        this.apiKey = api_key;
        this.body = body;
    }

    buildBody(args: { [key: string]: any }) {
        const body = JSON.parse(JSON.stringify(this.body));
        for (const key in args) {
            if (!args.hasOwnProperty(key)) body[key] = args[key];
        }
        return body;
    }
}

export class ChatModel extends BaseModel {
    constructor(name: string, use: ModelUse[], provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, use, provider, base_url, api_key, body);
    }

    get url() {
        return `${this.baseUrl}/chat/completions`;
    }

    buildChatBody(agent: Agent, sessionId: string) {
        return this.buildBody({
            messages: agent.sessionService.getSession(sessionId).getMessages(),
            tools: agent.getRequestTools()
        });
    }

    async callChat(agent: Agent, sessionId: string): Promise<{ content: string, tool_calls: ToolCall[] }> {
        const { TIMEOUT } = Config.base;
        try {
            const time = Date.now();

            const data = await withTimeout(() => fetchData(this.url, this.apiKey, this.buildChatBody(agent, sessionId)), TIMEOUT);

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

export class ImageModel extends BaseModel {
    constructor(name: string, use: ModelUse[], provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, use, provider, base_url, api_key, body);
    }

    get url() {
        return `${this.baseUrl}/chat/completions`;
    }

    buildChatBody(agent: Agent, sessionId: string) {
        return this.buildBody({
            messages: agent.sessionService.getSession(sessionId).getImageMessages(),
            tools: agent.getRequestTools()
        });
    }

    async callITT(src: string, prompt = ''): Promise<string> {
        const { TIMEOUT } = Config.base;
        try {
            const time = Date.now();

            const data = await withTimeout(() => fetchData(this.url, this.apiKey, this.buildBody({
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
            })), TIMEOUT);

            if (data.choices && data.choices.length > 0) {
                UsageManager.updateUsage(data.model, data.usage);

                const message = data.choices[0].message;
                const content = message.content || '';

                logger.info(`响应内容:`, content, '\nlatency', Date.now() - time, 'ms');

                return content;
            } else {
                throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
            }
        } catch (e) {
            logger.error(`在调用模型${this.name}中出错:`, e.message);
            return '';
        }
    }

    async callChat(agent: Agent, sessionId: string): Promise<{ content: string, tool_calls: ToolCall[] }> {
        const { TIMEOUT } = Config.base;
        try {
            const time = Date.now();

            const data = await withTimeout(() => fetchData(this.url, this.apiKey, this.buildChatBody(agent, sessionId)), TIMEOUT);

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

export class EmbeddingModel extends BaseModel {
    static vectorCache: { text: string, vector: number[] } = { text: '', vector: [] };

    constructor(name: string, use: ModelUse[], provider: string, base_url: string, api_key: string, body) {
        super(name, use, provider, base_url, api_key, body);
    }

    get url() {
        return `${this.baseUrl}/embeddings`;
    }

    async callEmbedding(text: string): Promise<number[]> {
        if (!text) {
            logger.warning(`getEmbedding: 文本为空`);
            return [];
        }

        const { TIMEOUT } = Config.base;

        if (EmbeddingModel.vectorCache.text === text && EmbeddingModel.vectorCache.vector.length === this.body.dimensions) {
            const v = EmbeddingModel.vectorCache.vector;
            return v;
        }

        try {
            const time = Date.now();

            const data = await withTimeout(() => fetchData(this.url, this.apiKey, this.buildBody({
                input: text
            })), TIMEOUT);

            if (data.data && data.data.length > 0) {
                UsageManager.updateUsage(data.model, data.usage);

                const embedding = data.data[0].embedding;

                logger.info(`文本:`, text, `\n响应embedding长度:`, embedding.length, '\nlatency:', Date.now() - time, 'ms');
                EmbeddingModel.vectorCache.text = text;
                EmbeddingModel.vectorCache.vector = embedding;

                return embedding;
            } else {
                throw new Error(`服务器响应中没有data或data为空\n响应体:${JSON.stringify(data, null, 2)}`);
            }
        } catch (e) {
            logger.error(`在调用模型${this.name}中出错:`, e.message);
            return [];
        }

    }
}

export type Model = ChatModel | ImageModel | EmbeddingModel;

export class ModelManager {
    static chatModels: ChatModel[] = [];
    static imageModels: ImageModel[] = [];
    static embeddingModels: EmbeddingModel[] = [];

    static getChatModel(use: ModelUse): ChatModel | ImageModel | null {
        const chatModelList = ModelManager.chatModels.filter(model => model.use.includes(use));
        if (chatModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * chatModelList.length);
            return chatModelList[randomIndex];
        }
        const ImageModelList = ModelManager.imageModels.filter(model => model.use.includes(use));
        if (ImageModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelList.length);
            return ImageModelList[randomIndex];
        }
        const chatModelAnyList = ModelManager.chatModels.filter(model => model.use.includes('any'));
        if (chatModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * chatModelAnyList.length);
            return chatModelAnyList[randomIndex];
        }
        const ImageModelAnyList = ModelManager.imageModels.filter(model => model.use.includes('any'));
        if (ImageModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelAnyList.length);
            return ImageModelAnyList[randomIndex];
        }
        return null;
    }

    static getImageModel(use: ModelUse): ImageModel | null {
        const ImageModelList = ModelManager.imageModels.filter(model => model.use.includes(use));
        if (ImageModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelList.length);
            return ImageModelList[randomIndex];
        }
        const ImageModelAnyList = ModelManager.imageModels.filter(model => model.use.includes('any'));
        if (ImageModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelAnyList.length);
            return ImageModelAnyList[randomIndex];
        }
        return null;
    }

    static getEmbeddingModel(use: ModelUse): EmbeddingModel | null {
        const EmbeddingModelList = ModelManager.embeddingModels.filter(model => model.use.includes(use));
        if (EmbeddingModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * EmbeddingModelList.length);
            return EmbeddingModelList[randomIndex];
        }
        const EmbeddingModelAnyList = ModelManager.embeddingModels.filter(model => model.use.includes('any'));
        if (EmbeddingModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * EmbeddingModelAnyList.length);
            return EmbeddingModelAnyList[randomIndex];
        }
        return null;
    }
}

export async function fetchData(url: string, apiKey: string, body: any): Promise<any> {
    // 打印请求发送前的上下文
    if (body.hasOwnProperty('messages')) {
        const s = JSON.stringify(body.messages, (key, value) => {
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
        body: JSON.stringify(body)
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