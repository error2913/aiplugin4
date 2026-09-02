// 模型管理器：按 use/全局覆盖选择纯文本/多模态/嵌入模型
import { DEFAULT_EMBEDDING_MODEL_BODY } from "../config/static_config";

import ChatModel from "./chat";
import EmbeddingModel from "./embedding";
import MultimodalModel from "./multimodal";
import { ChatModelUse, EmbeddingModelUse, ModelBody, ModelUse, MultimodalModelUse } from "./types";

export type ModelSource = 'text' | 'multimodal' | 'embedding';

export class BaseModel {
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    body: ModelBody;
    /** 模型配置来源：text=纯文本模型 / multimodal=多模态模型 / embedding=嵌入模型 */
    source: ModelSource = 'text';
    /** 在对应模板配置数组中的原始序号，从 0 开始 */
    configIndex = -1;

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

    /** 全局模型标识，例如 text[0]:deepseek-v4-flash */
    get ref(): string {
        return `${this.source}[${this.configIndex}]:${this.name}`;
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
    /** 全局分用途覆盖：use -> 模型唯一标识（来源[模板数组序号]:模型名） */
    static purposeModelOverrides: Partial<Record<ModelUse, string>> = {};

    /** 重置注册表（用于测试/热重载） */
    static reset() {
        Model.chatModels = [];
        Model.multimodalModels = [];
        Model.embeddingModels = [];
        Model.purposeModelOverrides = {};
    }

    /** 按完整模型标识查找模型；可选 use 时要求 use 精确匹配 */
    static findModelByRef(ref: string, use?: ModelUse): BaseModel | null {
        const matched = ref?.match(/^(text|multimodal|embedding)\[(\d+)\]:\s*(.+)$/);
        if (!matched) return null;
        const source = matched[1] as ModelSource;
        const configIndex = parseInt(matched[2], 10);
        const name = matched[3].trim();
        let list: BaseModel[] = [];
        if (source === 'text') list = Model.chatModels;
        else if (source === 'multimodal') list = Model.multimodalModels;
        else list = Model.embeddingModels;
        return list.find(model => {
            if (model.configIndex !== configIndex || model.name !== name) return false;
            if (use && !(model as any).use.includes(use)) return false;
            return true;
        }) || null;
    }

    /** 获取 chat 类用途默认模型：纯文本优先，其次多模态，均要求 use 精确匹配 */
    static getDefaultChatModel(use: ChatModelUse): ChatModel | MultimodalModel | null {
        const chatModel = Model.chatModels.find(model => model.use.includes(use));
        if (chatModel) return chatModel;
        const multimodalModel = Model.multimodalModels.find(model => model.use.includes(use));
        if (multimodalModel) return multimodalModel;
        return null;
    }

    /** 获取多模态类用途默认模型：use 精确匹配 */
    static getDefaultMultimodalModel(use: MultimodalModelUse): MultimodalModel | null {
        return Model.multimodalModels.find(model => model.use.includes(use)) || null;
    }

    /** 获取嵌入类用途默认模型：use 精确匹配 */
    static getDefaultEmbeddingModel(use: EmbeddingModelUse): EmbeddingModel | null {
        return Model.embeddingModels.find(model => model.use.includes(use)) || null;
    }

    static getChatModel(use: ChatModelUse): ChatModel | MultimodalModel | null {
        const ref = Model.purposeModelOverrides[use];
        if (ref) {
            const overrideModel = Model.findModelByRef(ref, use);
            if (overrideModel) return overrideModel as ChatModel | MultimodalModel;
            // 覆盖模型失效：自动回退默认精确匹配模型
        }
        return Model.getDefaultChatModel(use);
    }

    static getMultimodalModel(use: MultimodalModelUse): MultimodalModel | null {
        const ref = Model.purposeModelOverrides[use];
        if (ref) {
            const overrideModel = Model.findModelByRef(ref, use);
            if (overrideModel) return overrideModel as MultimodalModel;
        }
        return Model.getDefaultMultimodalModel(use);
    }

    static getEmbeddingModel(use: EmbeddingModelUse): EmbeddingModel | null {
        const ref = Model.purposeModelOverrides[use];
        if (ref) {
            const overrideModel = Model.findModelByRef(ref, use);
            if (overrideModel) return overrideModel as EmbeddingModel;
        }
        return Model.getDefaultEmbeddingModel(use);
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
