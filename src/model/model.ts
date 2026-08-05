// 模型管理器：按 use/名称选择对话/图片/嵌入模型
import ChatModel from "./chat";
import EmbeddingModel from "./embedding";
import ImageModel from "./image";
import { ChatModelUse, EmbeddingModelUse, ImageModelUse, ModelBody } from "./types";

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

    buildBody(args: { [key: string]: any }) {
        const body = JSON.parse(JSON.stringify(this.body));
        for (const key in args) {
            if (!args.hasOwnProperty(key)) body[key] = args[key];
        }
        return body;
    }
}

export default class Model {
    static chatModels: ChatModel[] = [];
    static imageModels: ImageModel[] = [];
    static embeddingModels: EmbeddingModel[] = [];

    static getChatModel(use: ChatModelUse, name: string = ''): ChatModel | ImageModel | null {
        if (name) {
            const namedList = Model.chatModels.filter(model => model.name === name && model.use.includes(use));
            if (namedList.length > 0) {
                return namedList[0];
            }
            const namedAnyList = Model.chatModels.filter(model => model.name === name && model.use.length === 0);
            if (namedAnyList.length > 0) {
                return namedAnyList[0];
            }
            // 指定名称不存在时回退到全局选择
            return Model.getChatModel(use);
        }
        const chatModelList = Model.chatModels.filter(model => model.use.includes(use));
        if (chatModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * chatModelList.length);
            return chatModelList[randomIndex];
        }
        const ImageModelList = Model.imageModels.filter(model => model.use.includes(use));
        if (ImageModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelList.length);
            return ImageModelList[randomIndex];
        }
        const chatModelAnyList = Model.chatModels.filter(model => model.use.length === 0);
        if (chatModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * chatModelAnyList.length);
            return chatModelAnyList[randomIndex];
        }
        const ImageModelAnyList = Model.imageModels.filter(model => model.use.length === 0);
        if (ImageModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelAnyList.length);
            return ImageModelAnyList[randomIndex];
        }
        return null;
    }

    static getImageModel(use: ImageModelUse): ImageModel | null {
        const ImageModelList = Model.imageModels.filter(model => model.use.includes(use));
        if (ImageModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelList.length);
            return ImageModelList[randomIndex];
        }
        const ImageModelAnyList = Model.imageModels.filter(model => model.use.length === 0);
        if (ImageModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * ImageModelAnyList.length);
            return ImageModelAnyList[randomIndex];
        }
        return null;
    }

    static getEmbeddingModel(use: EmbeddingModelUse): EmbeddingModel | null {
        const EmbeddingModelList = Model.embeddingModels.filter(model => model.use.includes(use));
        if (EmbeddingModelList.length > 0) {
            const randomIndex = Math.floor(Math.random() * EmbeddingModelList.length);
            return EmbeddingModelList[randomIndex];
        }
        const EmbeddingModelAnyList = Model.embeddingModels.filter(model => model.use.length === 0);
        if (EmbeddingModelAnyList.length > 0) {
            const randomIndex = Math.floor(Math.random() * EmbeddingModelAnyList.length);
            return EmbeddingModelAnyList[randomIndex];
        }
        return null;
    }
}
