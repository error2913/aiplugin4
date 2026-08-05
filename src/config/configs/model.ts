// 模型配置：对话/图片/嵌入模型 TOML 解析，并同步 Model 静态列表
import { load } from 'js-toml'

import Logger from "../../logger";
import ChatModel from "../../model/chat";
import EmbeddingModel from "../../model/embedding";
import ImageModel from "../../model/image";
import Model from "../../model/model";
import { ModelBody, ModelUse } from "../../model/types";
import { revive, TypeDescriptor } from "../../utils/utils";
import { ext } from "../config";
import { CHAT_MODEL_TO_PROVIDER, EMBEDDING_MODEL_TO_PROVIDER, IMAGE_MODEL_TO_PROVIDER, PROVIDER_MAP } from "../static_config";


export default class ModelConfig {

    static register() {

        seal.ext.registerTemplateConfig(ext, "对话模型", [
            `# 使用toml格式
name = "deepseek-v4-flash"
api_key = "sk-xxxx"
use = ["chat"]`,
            `# 默认对话模型（若需调整默认值，把想要的模型放到第一行）
name = "deepseek-chat"
api_key = "sk-xxxx"
use = ["chat"]

[body]
temperature = 1
top_p = 1`,
            `# deepseek 推理模型
name = "deepseek-reasoner"
api_key = "sk-xxxx"
use = ["chat"]`,
            `name = "deepseek-v4-pro"
api_key = "sk-xxxx"
use = ["chat"]`,
            `# Google Gemini（OpenAI 兼容端点）
name = "gemini-3-pro-preview-low"
api_key = "sk-xxxx"
use = ["chat"]`,
            `# OpenAI
name = "gpt-4o"
api_key = "sk-xxxx"
use = ["chat"]`,
            `# 智谱
name = "glm-4"
api_key = "sk-xxxx"
use = ["chat"]`,
            `# 通义千问
name = "qwen-max"
api_key = "sk-xxxx"
use = ["chat"]`
        ], '每行一个模型（TOML），name/api_key/use 必填；provider/base_url 可省略（自动识别 deepseek/openai/google/zhipu/alibaba/anthropic/moonshot/xai/mistral/siliconflow）；默认对话模型取列表第一项；可选 [body] 覆盖请求参数（如 temperature、max_tokens）', "模型");
        seal.ext.registerTemplateConfig(ext, "图片模型", [
            `# 使用toml格式
name = "glm-4v"
api_key = "sk-xxxx"
use = ["image-understanding"]`,
            `name = "glm-4v-plus-0111"
api_key = "sk-xxxx"
use = ["image-understanding"]`,
            `name = "glm-4v-flash"
api_key = "sk-xxxx"
use = ["image-understanding"]`,
            `# 通义千问视觉
name = "qwen-vl-max"
api_key = "sk-xxxx"
use = ["image-understanding"]`,
            `# OpenAI 视觉
name = "gpt-4o"
api_key = "sk-xxxx"
use = ["image-understanding"]`
        ], '每行一个图片模型（TOML），name/api_key/use 必填；provider/base_url 可省略（自动识别 zhipu/alibaba/openai/google/siliconflow）；use 填 image-understanding', "模型");
        seal.ext.registerTemplateConfig(ext, "嵌入模型", [
            `# 使用toml格式
name = "text-embedding-v4"
api_key = "sk-xxxx"
use = ["text-embedding"]`,
            `name = "text-embedding-v3"
api_key = "sk-xxxx"
use = ["text-embedding"]`,
            `# OpenAI 嵌入
name = "text-embedding-3-large"
api_key = "sk-xxxx"
use = ["text-embedding"]`,
            `name = "text-embedding-3-small"
api_key = "sk-xxxx"
use = ["text-embedding"]`
        ], '每行一个嵌入模型（TOML），name/api_key/use 必填；provider/base_url 可省略（自动识别 alibaba/openai/zhipu/siliconflow）；输出维度需与“向量维度”配置一致', "模型");
    }

    static get() {
        const config = {
            CHAT_MODELS: getModelsConfig("对话模型", CHAT_MODEL_TO_PROVIDER, ChatModel),
            IMAGE_MODELS: getModelsConfig("图片模型", IMAGE_MODEL_TO_PROVIDER, ImageModel),
            EMBEDDING_MODELS: getModelsConfig("嵌入模型", EMBEDDING_MODEL_TO_PROVIDER, EmbeddingModel),
        };
        // 同步到 Model 静态列表，供 Model.getChatModel 等使用
        Model.chatModels = config.CHAT_MODELS;
        Model.imageModels = config.IMAGE_MODELS;
        Model.embeddingModels = config.EMBEDDING_MODELS;
        return config;
    }
}

class ModelConfigItem {
    static validKeysMap: { [key in keyof ModelConfigItem]?: TypeDescriptor<ModelConfigItem[key]> } = {
        name: 'string',
        provider: 'string',
        base_url: 'string',
        api_key: 'string',
        use: { array: 'string' },
        body: { objectValue: 'any' }
    }
    name: string;
    provider: string;
    base_url: string;
    api_key: string;
    use: ModelUse[];
    body: ModelBody;
    constructor() {
        this.name = "";
        this.provider = "";
        this.base_url = "";
        this.api_key = "";
        this.use = [];
        this.body = {};
    }
}

function getModelsConfig<T extends ChatModel | ImageModel | EmbeddingModel>(
    key: string,
    m2p: { [model: string]: string },
    modelConstructor: new (use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) => T
): T[] {
    // 构造器实参收窄为各自 use 类型，这里做兼容转换
    const Ctor = modelConstructor as new (use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) => T;
    return seal.ext.getTemplateConfig(ext, key).map(tomlString => {
        try {
            const mc = revive(ModelConfigItem, load(tomlString));
            if (mc.name === "") throw new Error('缺失模型名称');
            if (mc.api_key === "") throw new Error('缺失模型API密钥');
            if (mc.provider === "") mc.provider = m2p?.[mc.name] || "";
            if (mc.base_url === "") {
                if (mc.provider === "") throw new Error('缺失模型基础URL 且 缺失模型供应商');
                mc.base_url = PROVIDER_MAP?.[mc.provider as keyof typeof PROVIDER_MAP] || "";
                if (mc.base_url === "") throw new Error('缺失模型基础URL');
            }
            return new Ctor(mc.use, mc.name, mc.provider, mc.base_url, mc.api_key, mc.body);
        } catch (e) {
            Logger.error(`${key}解析错误，内容:${tomlString}，错误信息:${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }).filter(x => x !== null);
}
