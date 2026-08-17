// 嵌入模型：文本向量化（带缓存）
import { DEFAULT_EMBEDDING_MODEL_BODY } from "../config/static_config";
import { logger } from "../logger";

import { BaseModel } from "./model";
import { requestModel } from "./provider";
import { EmbeddingModelUse, ModelBody, ModelUse } from "./types";

export default class EmbeddingModel extends BaseModel {
    /** 按模型名隔离的最近一次嵌入缓存，避免不同嵌入模型（同维度）互相串向量 */
    static vectorCache: { [model: string]: { text: string, vector: number[] } } = {};

    use: EmbeddingModelUse[];
    constructor(use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        super(name, provider, base_url, api_key, body);
        this.use = use as EmbeddingModelUse[];
    }

    get url() {
        return `${this.baseUrl}/embeddings`;
    }

    async callEmbedding(text: string): Promise<number[]> {
        if (!text) {
            logger.warning(`getEmbedding: 文本为空`);
            return [];
        }

        const dimension = { ...DEFAULT_EMBEDDING_MODEL_BODY, ...this.body }.dimensions;
        const cache = EmbeddingModel.vectorCache[this.name];
        if (cache && cache.text === text && cache.vector.length === dimension) {
            const v = cache.vector;
            return v;
        }

        try {
            const body = this.buildBody({
                model: this.name,
                input: text
            }, DEFAULT_EMBEDDING_MODEL_BODY);

            const time = Date.now();
            const data = await requestModel(this.url, this.apiKey, body);
            if (data.data && data.data.length > 0) {
                const embedding = data.data[0].embedding;

                logger.info(`文本:`, text.length > 200 ? text.slice(0, 200) + `…(+${text.length - 200})` : text, `\n响应embedding长度:`, embedding.length, '\nlatency:', Date.now() - time, 'ms');
                EmbeddingModel.vectorCache[this.name] = { text, vector: embedding };

                return embedding;
            } else {
                throw new Error(`服务器响应中没有data或data为空\n响应体:${JSON.stringify(data, null, 2)}`);
            }
        } catch (e) {
            logger.error(`在调用模型${this.name}中出错:`, e instanceof Error ? e.message : String(e));
            return [];
        }

    }
}
