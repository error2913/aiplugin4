export class Model {
    name: string;
    provider: string;
    base_url: string;
    api_key: string;

    max_tokens: number;
    stop: string[] | null;
    stream: boolean;
    temperature: number;
    top_p: number;

    constructor(name: string, provider: string, base_url: string, api_key: string) {
        this.name = name;
        this.provider = provider;
        this.base_url = base_url;
        this.api_key = api_key;

        this.max_tokens = 1024;
        this.stop = null;
        this.stream = false;
        this.temperature = 1;
        this.top_p = 1;
    }
}

export class ChatModel extends Model {
    constructor(name: string, provider: string, base_url: string, api_key: string) {
        super(name, provider, base_url, api_key);
    }

    // wip
    async call() {

    }
}

export class ImageModel extends Model {
    constructor(name: string, provider: string, base_url: string, api_key: string) {
        super(name, provider, base_url, api_key);
    }

    // wip
    async call() {

    }
}

export class EmbeddingModel extends Model {
    constructor(name: string, provider: string, base_url: string, api_key: string) {
        super(name, provider, base_url, api_key);
    }

    // wip
    async call() {

    }
}

export class ModelManager {
    chatModels: ChatModel[] = [];
    imageModels: ImageModel[] = [];
    embeddingModels: EmbeddingModel[] = [];
}