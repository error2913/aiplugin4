// 模型配置：纯文本/多模态/嵌入模型 TOML 解析，并同步 Model 静态列表
import { load } from 'js-toml'

import Logger from "../../logger";
import ChatModel from "../../model/chat";
import EmbeddingModel from "../../model/embedding";
import Model from "../../model/model";
import MultimodalModel from "../../model/multimodal";
import { ModelBody, ModelUse } from "../../model/types";
import { revive, TypeDescriptor } from "../../utils/utils";
import { ext } from "../config";
import { CHAT_MODEL_TO_PROVIDER, EMBEDDING_MODEL_TO_PROVIDER, MULTIMODAL_MODEL_TO_PROVIDER, PROVIDER_MAP } from "../static_config";


export default class ModelConfig {

    static register() {

        seal.ext.registerTemplateConfig(ext, "纯文本模型", [
            `# 使用toml格式
name = "deepseek-v4-flash"          # 必填，模型名
api_key = "sk-xxxx"                 # 必填，API 密钥
use = ["chat", "compression"]       # 必填，用途，可多个：chat/compression/summarization/judge
provider = "deepseek"               # 可选，服务商，省略时自动识别
base_url = "https://api.deepseek.com/v1"  # 可选，API 地址，省略时取服务商默认
ignore = 0                         # 可选，1=忽略该条配置，0/不写=正常

[body]                              # 可选，请求参数覆盖；默认 max_tokens=8192、stop=null、stream=false
temperature = 1                     # 可选
top_p = 1                           # 可选
max_tokens = 8192                   # 可选`
        ], '每行一个纯文本模型（TOML）。必填：name（模型名）、api_key（API 密钥）、use（用途，可多个）。可选：provider（服务商，省略时按模型名自动识别：deepseek/openai/google/zhipu/alibaba/anthropic/moonshot/xai/mistral/siliconflow）、base_url（API 地址，省略时按服务商取默认）、body（请求参数覆盖）。use 可选值：chat（普通对话）/compression（消息压缩）/summarization（记忆总结）/judge（群聊插话评分，未单独配置时回退到 chat 模型）。ignore 可选：1=忽略该条配置（不出现在列表/不可选中），0/不写=正常；默认纯文本模型取列表第一项；body 未配置时使用 max_tokens=8192、stop=null、stream=false。下方默认值即完整示例，可直接修改。完整格式指导与各平台模型示例见 https://github.com/error2913/aiplugin4/blob/main/docs/MODELS-chat.md （仓库文档）。', "模型");
        seal.ext.registerTemplateConfig(ext, "多模态模型", [
            `# 使用toml格式
name = "glm-4v"                     # 必填，模型名
api_key = "sk-xxxx"                 # 必填，API 密钥
use = ["image-understanding"]       # 必填，用途：image-understanding / chat / compression / summarization / judge
provider = "zhipu"                  # 可选，服务商，省略时自动识别
base_url = "https://open.bigmodel.cn/api/paas/v4"  # 可选，API 地址，省略时取服务商默认
ignore = 0                         # 可选，1=忽略该条配置，0/不写=正常

[body]                              # 可选，请求参数覆盖；默认 max_tokens=2048、stop=null、stream=false
temperature = 1                     # 可选
max_tokens = 2048                   # 可选`
        ], '每行一个多模态模型（TOML）。必填：name（模型名）、api_key（API 密钥）、use（用途）。可选：provider（服务商，省略时按模型名自动识别：zhipu/alibaba/openai/google/siliconflow）、base_url（API 地址，省略时按服务商取默认）、body（请求参数覆盖）。use 可选值：image-understanding（图片理解/图片转文字）、chat/compression/summarization/judge（把该模型当作对应用途的对话模型使用，上下文里的图片会以图片内容直接传给模型，不再转成文本标签；.ai model 可选中 use 含 chat 的条目作为会话模型）。本列表内的模型一律按多模态处理；同名模型若也出现在纯文本模型列表，按纯文本模型处理；ignore 可选：1=忽略该条配置（不出现在列表/不可选中），0/不写=正常。body 未配置时使用 max_tokens=2048、stop=null、stream=false。下方默认值即完整示例，可直接修改。完整格式指导与各平台模型示例见 https://github.com/error2913/aiplugin4/blob/main/docs/MODELS-image.md （仓库文档）。', "模型");
        seal.ext.registerTemplateConfig(ext, "嵌入模型", [
            `# 使用toml格式
name = "text-embedding-v4"          # 必填，模型名
api_key = "sk-xxxx"                 # 必填，API 密钥
use = ["text-embedding"]            # 必填，用途：text-embedding
provider = "alibaba"                # 可选，服务商，省略时自动识别
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"  # 可选，API 地址，省略时取服务商默认
ignore = 0                         # 可选，1=忽略该条配置，0/不写=正常

[body]                              # 可选，请求参数覆盖；默认 encoding_format=float、dimensions=1024
dimensions = 1024                   # 可选，输出向量维度，须与后端一致（如 text-embedding-v4 为 1024）`
        ], '每行一个嵌入模型（TOML）。必填：name（模型名）、api_key（API 密钥）、use（用途）。可选：provider（服务商，省略时按模型名自动识别：alibaba/openai/zhipu/siliconflow）、base_url（API 地址，省略时按服务商取默认）、body（请求参数覆盖）。use 可选值：text-embedding（文本嵌入）。body 默认 encoding_format=float；向量检索维度取第一个嵌入模型的 body.dimensions，未配置时自动降级为关键词/分数检索；ignore 可选：1=忽略该条配置（不出现在列表/不可选中），0/不写=正常。下方默认值即完整示例，可直接修改。完整格式指导与各平台模型示例见 https://github.com/error2913/aiplugin4/blob/main/docs/MODELS-embedding.md （仓库文档）。', "模型");
    }

    static get() {
        const config = {
            CHAT_MODELS: getModelsConfig("纯文本模型", CHAT_MODEL_TO_PROVIDER, ChatModel),
            MULTIMODAL_MODELS: getModelsConfig("多模态模型", MULTIMODAL_MODEL_TO_PROVIDER, MultimodalModel),
            EMBEDDING_MODELS: getModelsConfig("嵌入模型", EMBEDDING_MODEL_TO_PROVIDER, EmbeddingModel),
        };
        // 同步到 Model 静态列表，供 Model.getChatModel 等使用
        Model.chatModels = config.CHAT_MODELS;
        Model.multimodalModels = config.MULTIMODAL_MODELS;
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
        body: { objectValue: 'any' },
        ignore: 'any'
    }
    name: string;
    provider: string;
    base_url: string;
    api_key: string;
    use: ModelUse[];
    body: ModelBody;
    ignore: number;
    constructor() {
        this.name = "";
        this.provider = "";
        this.base_url = "";
        this.api_key = "";
        this.use = [];
        this.body = {};
        this.ignore = 0;
    }
}

function getModelsConfig<T extends ChatModel | MultimodalModel | EmbeddingModel>(
    key: string,
    m2p: { [model: string]: string },
    modelConstructor: new (use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) => T
): T[] {
    // 构造器实参收窄为各自 use 类型，这里做兼容转换
    const Ctor = modelConstructor as new (use: ModelUse[], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) => T;
    return seal.ext.getTemplateConfig(ext, key).map(tomlString => {
        try {
            const mc = revive(ModelConfigItem, load(tomlString));
            // ignore=1：忽略该条模型配置（不出现在列表、不可选中、不作为默认）
            if (mc.ignore === 1 || mc.ignore === true || mc.ignore === '1') return null;
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
