import { ChatModel, EmbeddingModel, ImageModel } from "../../agent/model";
import { ModelBody } from "../../model/types";
import { logger } from "../../logger";
import Config from "../config";
import { CHAT_MODEL_TO_PROVIDER, EMBEDDING_MODEL_TO_PROVIDER, IMAGE_MODEL_TO_PROVIDER, PROVIDER_MAP } from "../static_config";

export default class ModelConfig {
    static ext: seal.ExtInfo;

    static register() {
        ModelConfig.ext = Config.getExt('aiplugin4:模型');

        seal.ext.registerTemplateConfig(ModelConfig.ext, "对话模型", [`{
    "use": ["chat"],
    "name": "deepseek-chat",
    "api_key": "sk-xxxx",
    "body": {
        "temperature": 1,
        "top_p": 1
    }
}`], '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "图片模型", [`{
    "use": ["image-understanding"],
    "name": "glm-4v",
    "api_key": "sk-xxxx"
}`], '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "嵌入模型", [`{
    "use": ["text-embedding"],
    "name": "text-embedding-v4",
    "api_key": "sk-xxxx"
}`], '');
    }

    static get() {
        return {
            CHAT_MODELS: getModelsConfig("对话模型", CHAT_MODEL_TO_PROVIDER, ChatModel),
            IMAGE_MODELS: getModelsConfig("图片模型", IMAGE_MODEL_TO_PROVIDER, ImageModel),
            EMBEDDING_MODELS: getModelsConfig("嵌入模型", EMBEDDING_MODEL_TO_PROVIDER, EmbeddingModel),
        }
    }
}

function getModelsConfig<T extends ChatModel | ImageModel | EmbeddingModel>(
    key: string,
    m2p: { [model: string]: string },
    modelConstructor: new (use: T['use'], name: string, provider: string, base_url: string, api_key: string, body: ModelBody) => T
): T[] {
    return seal.ext.getTemplateConfig(ModelConfig.ext, key).map(x => {
        try {
            const data = JSON.parse(x);
            if (!data.hasOwnProperty('name')) throw new Error('缺失模型名称');
            if (!data.hasOwnProperty('api_key')) throw new Error('缺失模型API密钥');
            if (!data.hasOwnProperty('use')) data.use = [];
            if (!data.hasOwnProperty('body')) data.body = {};
            if (!data.hasOwnProperty('provider')) data.provider = m2p?.[data.name] || "";
            if (!data.hasOwnProperty('base_url')) {
                if (!data.hasOwnProperty('provider')) throw new Error('缺失模型基础URL 且 缺失模型供应商');
                data.base_url = PROVIDER_MAP?.[data.provider] || "";
                if (!data.hasOwnProperty('base_url')) throw new Error('缺失模型基础URL');
            }
            return new modelConstructor(data.use, data.name, data.provider, data.base_url, data.api_key, data.body);
        } catch (e) {
            logger.error(`${key}解析错误，内容:${x}，错误信息:${e.message}`);
            return null;
        }
    }).filter(x => x !== null);
}