// 嵌入模型：文本向量化（带缓存）
import Config from "../config/config";
import { DEFAULT_EMBEDDING_MODEL_BODY } from "../config/static_config";
import { logger } from "../logger";
import { UsageManager } from "../usage";
import { withTimeout } from "../utils/utils";
import { fetchData } from "../utils/web";

import { BaseModel } from "./model";
import { EmbeddingModelUse, ModelBody } from "./types";

export default class EmbeddingModel extends BaseModel {
    static vectorCache: { text: string, vector: number[] } = { text: '', vector: [] };

    use: EmbeddingModelUse[];
    constructor(use: EmbeddingModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, provider, base_url, api_key, body);
        this.use = use;
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
            const body = this.buildBody({
                ...DEFAULT_EMBEDDING_MODEL_BODY,
                input: text
            });

            const time = Date.now();
            const data = await withTimeout(() => fetchData(this.url, this.apiKey, body), TIMEOUT);
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