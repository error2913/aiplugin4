// 模型管理器：按 use/名称选择对话/多模态/嵌入模型
import { DEFAULT_EMBEDDING_MODEL_BODY } from "../config/static_config";

import ChatModel from "./chat";
import EmbeddingModel from "./embedding";
import MultimodalModel from "./multimodal";
import { ChatModelUse, EmbeddingModelUse, ModelBody, MultimodalModelUse } from "./types";

export class BaseModel {
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    body: ModelBody;

    constructor(name: string, provider: string, base_url: string, api_key: string, body: ModelBody) {
        this.name = name;
        this.provider = provider;
        this.baseUrl = base_url;
        this.apiKey = api_key;
        this.body = body;
    }

    /** 是否为多模态模型：默认 false（纯文本模型），多模态模型覆写为 true */
    get isMultimodal(): boolean {
        return false;
    }

    buildBody(args: { [key: string]: any }, defaults: { [key: string]: any } = {}) {
        // 优先级：默认值 < 用户 TOML [body] 配置 < 调用方显式参数
        return { ...defaults, ...this.body, ...args };
    }
}

export default class Model {
    static chatModels: ChatModel[] = [];
    static multimodalModels: MultimodalModel[] = [];
    static embeddingModels: EmbeddingModel[] = [];

    /** 重置注册表（用于测试/热重载） */
    static reset() {
        Model.chatModels = [];
        Model.multimodalModels = [];
        Model.embeddingModels = [];
    }

    static getChatModel(use: ChatModelUse, name: string = ''): ChatModel | MultimodalModel | null {
        if (name) {
            const namedList = Model.chatModels.filter(model => model.name === name && model.use.includes(use));
            if (namedList.length > 0) {
                return namedList[0];
            }
            const namedAnyList = Model.chatModels.filter(model => model.name === name && model.use.length === 0);
            if (namedAnyList.length > 0) {
                return namedAnyList[0];
            }
            // 多模态模型里配置的模型也可按名称用于 chat（use 含 chat 或未指定用途）
            const namedMultimodalList = Model.multimodalModels.filter(model => model.name === name && model.use.includes(use));
            if (namedMultimodalList.length > 0) {
                return namedMultimodalList[0];
            }
            const namedMultimodalAnyList = Model.multimodalModels.filter(model => model.name === name && model.use.length === 0);
            if (namedMultimodalAnyList.length > 0) {
                return namedMultimodalAnyList[0];
            }
            // 指定名称不存在时回退到全局选择
            return Model.getChatModel(use);
        }
        const chatModelList = Model.chatModels.filter(model => model.use.includes(use));
        if (chatModelList.length > 0) {
            // 确定性选择：同一用途下取第一个匹配模型（避免随机导致行为不稳定）
            return chatModelList[0];
        }
        const multimodalModelList = Model.multimodalModels.filter(model => model.use.includes(use));
        if (multimodalModelList.length > 0) {
            return multimodalModelList[0];
        }
        const chatModelAnyList = Model.chatModels.filter(model => model.use.length === 0);
        if (chatModelAnyList.length > 0) {
            return chatModelAnyList[0];
        }
        const multimodalModelAnyList = Model.multimodalModels.filter(model => model.use.length === 0);
        if (multimodalModelAnyList.length > 0) {
            return multimodalModelAnyList[0];
        }
        // 用途匹配失败时回退到 chat 用途的模型（与文档约定一致），避免压缩/总结等静默失败
        const chatFallbackList = Model.chatModels.filter(model => model.use.includes('chat'));
        if (chatFallbackList.length > 0) {
            return chatFallbackList[0];
        }
        return null;
    }

    static getMultimodalModel(use: MultimodalModelUse): MultimodalModel | null {
        const multimodalModelList = Model.multimodalModels.filter(model => model.use.includes(use));
        if (multimodalModelList.length > 0) {
            return multimodalModelList[0];
        }
        const multimodalModelAnyList = Model.multimodalModels.filter(model => model.use.length === 0);
        if (multimodalModelAnyList.length > 0) {
            return multimodalModelAnyList[0];
        }
        return null;
    }

    static getEmbeddingModel(use: EmbeddingModelUse): EmbeddingModel | null {
        const EmbeddingModelList = Model.embeddingModels.filter(model => model.use.includes(use));
        if (EmbeddingModelList.length > 0) {
            return EmbeddingModelList[0];
        }
        const EmbeddingModelAnyList = Model.embeddingModels.filter(model => model.use.length === 0);
        if (EmbeddingModelAnyList.length > 0) {
            return EmbeddingModelAnyList[0];
        }
        return null;
    }

    /** 获取嵌入模型输出维度；未配置或非法时返回 0（调用方降级为非向量检索） */
    static getEmbeddingDimension(): number {
        const model = Model.getEmbeddingModel('text-embedding');
        if (!model) return 0;
        // 与请求体一致：默认 body（dimensions=1024）与用户 TOML [body] 合并后取维度
        const dim = { ...DEFAULT_EMBEDDING_MODEL_BODY, ...model.body }.dimensions;
        return typeof dim === 'number' && dim > 0 ? dim : 0;
    }
}
