import { logger } from "../logger";
import { ToolCall } from "../tool/tool";
import { withTimeout } from "../utils/utils";
import { Agent } from "./agent";
import { UsageManager } from "./usage";

export type ModelUse = 'chat' | 'image-understanding' | 'text-embedding'

export interface ModelBody {
    max_tokens?: number,
    stop?: string[] | null,
    stream?: boolean,
    temperature?: number,
    top_p?: number,
    [key: string]: any
}

export class Model {
    name: string;
    use: ModelUse;
    provider: string;
    base_url: string;
    api_key: string;
    body: ModelBody;

    constructor(name: string, use: ModelUse, provider: string, base_url: string, api_key: string, body: ModelBody) {
        this.name = name;
        this.use = use;
        this.provider = provider;
        this.base_url = base_url;
        this.api_key = api_key;
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

export class ChatModel extends Model {
    constructor(name: string, use: ModelUse, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, use, provider, base_url, api_key, body);
    }

    get url() {
        return `${this.base_url}/chat/completions`;
    }

    // wip
    async call(agent: Agent, sessionId: string): Promise<{ content: string, tool_calls: ToolCall[] }> {
        try {
            const time = Date.now();

            const data = await withTimeout(() => fetchData(this.url, this.api_key, this.buildBody({
                messages: agent.sessionService.getSession(sessionId).getMessages(),
                tools: agent.getTools()
            })), 10000);

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

export class ImageModel extends Model {
    constructor(name: string, use: ModelUse, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, use, provider, base_url, api_key, body);
    }

    // wip
    async call() {

    }

    export async function sendITTRequest(messages: {
        role: string,
        content: {
            type: string,
            image_url?: { url: string }
            text?: string
        }[]
    }[]): Promise<string> {
    const { timeout } = ConfigManager.request;
    const { url, apiKey, bodyTemplate } = ConfigManager.image;

    try {
        const bodyObject = parseBody(bodyTemplate, messages, null, null);
        const time = Date.now();

        const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);

        if (data.choices && data.choices.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const message = data.choices[0].message;
            const content = message.content || '';

            logger.info(`响应内容:`, content, '\nlatency', Date.now() - time, 'ms');

            return content;
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendITTRequest中请求出错:", e.message);
        return '';
    }
}
}

export class EmbeddingModel extends Model {
    constructor(name: string, provider: string, base_url: string, api_key: string) {
        super(name, provider, base_url, api_key);
    }

    // wip
    async call() {

    }

    const vectorCache: { text: string, vector: number[] } = { text: '', vector: [] };
    
    export async function getEmbedding(text: string): Promise<number[]> {
    if (!text) {
        logger.warning(`getEmbedding: 文本为空`);
        return [];
    }

    const { timeout } = ConfigManager.request;
    const { embeddingDimension, embeddingUrl, embeddingApiKey, embeddingBodyTemplate } = ConfigManager.memory;

    if (vectorCache.text === text && vectorCache.vector.length === embeddingDimension) {
        const v = vectorCache.vector;
        return v;
    }

    try {
        const bodyObject = parseEmbeddingBody(embeddingBodyTemplate, text, embeddingDimension);
        const time = Date.now();

        const data = await withTimeout(() => fetchData(embeddingUrl, embeddingApiKey, bodyObject), timeout);

        if (data.data && data.data.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const embedding = data.data[0].embedding;

            logger.info(`文本:`, text, `\n响应embedding长度:`, embedding.length, '\nlatency:', Date.now() - time, 'ms');
            vectorCache.text = text;
            vectorCache.vector = embedding;

            return embedding;
        } else {
            throw new Error(`服务器响应中没有data或data为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在getEmbedding中出错:", e.message);
        return [];
    }
}
}

export class ModelManager {
    chatModels: ChatModel[] = [];
    imageModels: ImageModel[] = [];
    embeddingModels: EmbeddingModel[] = [];
}

export async function fetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
    // 打印请求发送前的上下文
    if (bodyObject.hasOwnProperty('messages')) {
        const s = JSON.stringify(bodyObject.messages, (key, value) => {
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