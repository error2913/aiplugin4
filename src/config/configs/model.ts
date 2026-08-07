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
name = "deepseek-v4-flash"          # 必填，模型名
api_key = "sk-xxxx"                 # 必填，API 密钥
use = ["chat", "compression"]       # 必填，用途，可多个：chat/compression/summarization
provider = "deepseek"               # 可选，服务商，省略时自动识别
base_url = "https://api.deepseek.com/v1"  # 可选，API 地址，省略时取服务商默认

[body]                              # 可选，请求参数覆盖；默认 max_tokens=8192、stop=null、stream=false
temperature = 1                     # 可选
top_p = 1                           # 可选
max_tokens = 8192                   # 可选`
        ], '每行一个模型（TOML）。必填：name（模型名）、api_key（API 密钥）、use（用途，可多个）。可选：provider（服务商，省略时按模型名自动识别：deepseek/openai/google/zhipu/alibaba/anthropic/moonshot/xai/mistral/siliconflow）、base_url（API 地址，省略时按服务商取默认）、body（请求参数覆盖）。use 可选值：chat（普通对话）/compression（消息压缩）/summarization（记忆总结）。默认对话模型取列表第一项；body 未配置时使用 max_tokens=8192、stop=null、stream=false。下方默认值即完整示例，可直接修改。', "模型");
        seal.ext.registerTemplateConfig(ext, "图片模型", [
            `# 使用toml格式
name = "glm-4v"                     # 必填，模型名
api_key = "sk-xxxx"                 # 必填，API 密钥
use = ["image-understanding"]       # 必填，用途：image-understanding
provider = "zhipu"                  # 可选，服务商，省略时自动识别
base_url = "https://open.bigmodel.cn/api/paas/v4"  # 可选，API 地址，省略时取服务商默认

[body]                              # 可选，请求参数覆盖；默认 max_tokens=4096、stop=null、stream=false
temperature = 1                     # 可选
max_tokens = 4096                   # 可选`
        ], '每行一个图片模型（TOML）。必填：name（模型名）、api_key（API 密钥）、use（用途）。可选：provider（服务商，省略时按模型名自动识别：zhipu/alibaba/openai/google/siliconflow）、base_url（API 地址，省略时按服务商取默认）、body（请求参数覆盖）。use 可选值：image-understanding（图片理解/图片转文字）。body 未配置时使用 max_tokens=4096、stop=null、stream=false。下方默认值即完整示例，可直接修改。', "模型");
        seal.ext.registerTemplateConfig(ext, "嵌入模型", [
            `# 使用toml格式
name = "text-embedding-v4"          # 必填，模型名
api_key = "sk-xxxx"                 # 必填，API 密钥
use = ["text-embedding"]            # 必填，用途：text-embedding
provider = "alibaba"                # 可选，服务商，省略时自动识别
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"  # 可选，API 地址，省略时取服务商默认

[body]                              # 可选，请求参数覆盖；默认 encoding_format=float
dimensions = 1024                   # 可选，输出维度，需与「向量维度」配置一致`
        ], '每行一个嵌入模型（TOML）。必填：name（模型名）、api_key（API 密钥）、use（用途）。可选：provider（服务商，省略时按模型名自动识别：alibaba/openai/zhipu/siliconflow）、base_url（API 地址，省略时按服务商取默认）、body（请求参数覆盖）。use 可选值：text-embedding（文本嵌入）。body 未配置时使用 encoding_format=float；输出向量维度需与「向量维度」配置一致。下方默认值即完整示例，可直接修改。', "模型");
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
