import { ChatModel, EmbeddingModel, ImageModel } from "../../agent/model";
import { logger } from "../../logger";
import { ConfigManager } from "../configManager";
import { CHAT_MODEL_MAP, EMBEDDING_MODEL_MAP, IMAGE_MODEL_MAP } from "../static_config";

export class ModelConfig {
    static ext: seal.ExtInfo;

    static register() {
        ModelConfig.ext = ConfigManager.getExt('aiplugin4:模型');

        seal.ext.registerOptionConfig(ModelConfig.ext, "快速选择对话模型", "", getChatModelOptions(), '');
        seal.ext.registerStringConfig(ModelConfig.ext, "快速填入对话模型api key", "", '');
        seal.ext.registerOptionConfig(ModelConfig.ext, "快速选择图片模型", "", getImageModelOptions(), '');
        seal.ext.registerStringConfig(ModelConfig.ext, "快速填入图片模型api key", "", '');
        seal.ext.registerOptionConfig(ModelConfig.ext, "快速选择嵌入模型", "", getEmbeddingModelOptions(), '');
        seal.ext.registerStringConfig(ModelConfig.ext, "快速填入嵌入模型api key", "", '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "对话模型", [`{
    "name": "deepseek-chat",
    "use": ["chat"],
    "api_key": "sk-xxxx",
    "body": ${JSON.stringify(DEFAULT_CHAT_MODEL_BODY)}
}`], '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "图片模型", [`{
    "name": "glm-4v",
    "use": ["any"],
    "api_key": "sk-xxxx",
    "base_url": "https://open.bigmodel.cn/api/paas/v4",
    "body": ${JSON.stringify(DEFAULT_IMAGE_MODEL_BODY)}
}`], '');
        seal.ext.registerTemplateConfig(ModelConfig.ext, "嵌入模型", [`{
    "name": "text-embedding-v4",
    "use": ["any"],
    "api_key": "sk-xxxx",
    "body": ${JSON.stringify(DEFAULT_EMBEDDING_MODEL_BODY)}
}`], '');
    }

    static get() {
        return {
            CHAT_MODELS: [getFastChatModel(), ...getChatModelsConfig()].filter(model => model !== null),
            IMAGE_MODELS: [getFastImageModel(), ...getImageModelsConfig()].filter(model => model !== null),
            EMBEDDING_MODELS: [getFastEmbeddingModel(), ...getEmbeddingModelsConfig()].filter(model => model !== null),
        }
    }
}

const DEFAULT_CHAT_MODEL_BODY = {
    "max_tokens": 4096,
    "stop": null,
    "stream": false,
    "temperature": 1,
    "top_p": 1
}
const DEFAULT_IMAGE_MODEL_BODY = {
    "max_tokens": 4096,
    "stop": null,
    "stream": false
}
const DEFAULT_EMBEDDING_MODEL_BODY = {
    "encoding_format": "float"
}

function getChatModelOptions() {
    const op: string[] = [];
    Object.keys(CHAT_MODEL_MAP).forEach(provider => {
        CHAT_MODEL_MAP[provider].model.forEach(model => {
            op.push(`${provider}/${model}`);
        });
    });
    return op;
}

function getImageModelOptions() {
    const op: string[] = [];
    Object.keys(IMAGE_MODEL_MAP).forEach(provider => {
        IMAGE_MODEL_MAP[provider].model.forEach(model => {
            op.push(`${provider}/${model}`);
        });
    });
    return op;
}

function getEmbeddingModelOptions() {
    const op: string[] = [];
    Object.keys(EMBEDDING_MODEL_MAP).forEach(provider => {
        EMBEDDING_MODEL_MAP[provider].model.forEach(model => {
            op.push(`${provider}/${model}`);
        });
    });
    return op;
}

function getFastChatModel(): ChatModel | null {
    const model = seal.ext.getOptionConfig(ModelConfig.ext, "快速选择对话模型");
    const apiKey = seal.ext.getStringConfig(ModelConfig.ext, "快速填入对话模型api key");
    const [provider, name] = model.split('/');
    const baseUrl = CHAT_MODEL_MAP[provider].baseUrl;
    return new ChatModel(name, ["any"], provider, baseUrl, apiKey, DEFAULT_CHAT_MODEL_BODY);
}

function getFastImageModel(): ImageModel | null {
    const model = seal.ext.getOptionConfig(ModelConfig.ext, "快速选择图片模型");
    const apiKey = seal.ext.getStringConfig(ModelConfig.ext, "快速填入图片模型api key");
    const [provider, name] = model.split('/');
    const baseUrl = IMAGE_MODEL_MAP[provider].baseUrl;
    return new ImageModel(name, ["any"], provider, baseUrl, apiKey, DEFAULT_IMAGE_MODEL_BODY);
}

function getFastEmbeddingModel(): EmbeddingModel | null {
    const model = seal.ext.getOptionConfig(ModelConfig.ext, "快速选择嵌入模型");
    const apiKey = seal.ext.getStringConfig(ModelConfig.ext, "快速填入嵌入模型api key");
    const [provider, name] = model.split('/');
    const baseUrl = EMBEDDING_MODEL_MAP[provider].baseUrl;
    return new EmbeddingModel(name, ["any"], provider, baseUrl, apiKey, DEFAULT_EMBEDDING_MODEL_BODY);
}

function getChatModelsConfig(): ChatModel[] {
    return seal.ext.getTemplateConfig(ModelConfig.ext, "对话模型").map(x => {
        try {
            const data = JSON.parse(x);
            if (!data.hasOwnProperty('name')) throw new Error('缺失模型名称');
            if (!data.hasOwnProperty('api_key')) throw new Error('缺失模型API密钥');
            if (!data.hasOwnProperty('body')) data.body = DEFAULT_CHAT_MODEL_BODY;
            if (!data.hasOwnProperty('use')) data.use = ["any"];
            if (!data.hasOwnProperty('provider')) data.provider = "";
            if (!data.hasOwnProperty('base_url')) {
                for (const provider in CHAT_MODEL_MAP) {
                    if (CHAT_MODEL_MAP[provider].model.includes(data.name)) {
                        data.base_url = CHAT_MODEL_MAP[provider].baseUrl;
                        break;
                    }
                }
                if (!data.hasOwnProperty('base_url')) throw new Error('缺失模型基础URL');
            }

            return new ChatModel(data.name, data.use, data.provider, data.base_url, data.api_key, data.body);
        } catch (e) {
            logger.error(`对话模型解析错误，内容:${x}，错误信息:${e.message}`);
            return null;
        }
    }).filter(x => x !== null);
}

function getImageModelsConfig(): ImageModel[] {
    return seal.ext.getTemplateConfig(ModelConfig.ext, "图片模型").map(x => {
        try {
            const data = JSON.parse(x);
            if (!data.hasOwnProperty('name')) throw new Error('缺失模型名称');
            if (!data.hasOwnProperty('api_key')) throw new Error('缺失模型API密钥');
            if (!data.hasOwnProperty('body')) data.body = DEFAULT_IMAGE_MODEL_BODY;
            if (!data.hasOwnProperty('use')) data.use = ["any"];
            if (!data.hasOwnProperty('provider')) data.provider = "";
            if (!data.hasOwnProperty('base_url')) {
                for (const provider in IMAGE_MODEL_MAP) {
                    if (IMAGE_MODEL_MAP[provider].model.includes(data.name)) {
                        data.base_url = IMAGE_MODEL_MAP[provider].baseUrl;
                        break;
                    }
                }
                if (!data.hasOwnProperty('base_url')) throw new Error('缺失模型基础URL');
            }

            return new ImageModel(data.name, data.use, data.provider, data.base_url, data.api_key, data.body);
        } catch (e) {
            logger.error(`图片模型解析错误，内容:${x}，错误信息:${e.message}`);
            return null;
        }
    }).filter(x => x !== null);
}

function getEmbeddingModelsConfig(): EmbeddingModel[] {
    return seal.ext.getTemplateConfig(ModelConfig.ext, "嵌入模型").map(x => {
        try {
            const data = JSON.parse(x);
            if (!data.hasOwnProperty('name')) throw new Error('缺失模型名称');
            if (!data.hasOwnProperty('api_key')) throw new Error('缺失模型API密钥');
            if (!data.hasOwnProperty('body')) data.body = DEFAULT_EMBEDDING_MODEL_BODY;
            if (!data.hasOwnProperty('use')) data.use = ["any"];
            if (!data.hasOwnProperty('provider')) data.provider = "";
            if (!data.hasOwnProperty('base_url')) {
                for (const provider in EMBEDDING_MODEL_MAP) {
                    if (EMBEDDING_MODEL_MAP[provider].model.includes(data.name)) {
                        data.base_url = EMBEDDING_MODEL_MAP[provider].baseUrl;
                        break;
                    }
                }
                if (!data.hasOwnProperty('base_url')) throw new Error('缺失模型基础URL');
            }

            return new EmbeddingModel(data.name, data.use, data.provider, data.base_url, data.api_key, data.body);
        } catch (e) {
            logger.error(`嵌入模型解析错误，内容:${x}，错误信息:${e.message}`);
            return null;
        }
    }).filter(x => x !== null);
}