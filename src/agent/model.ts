export class Model {
    name: string;
    provider: string;
    base_url: string;
    api_key: string;
    type: 'chat' | 'code' | 'image' | 'embedding' | 'audio' | 'video';

    constructor(name: string, provider: string, base_url: string, api_key: string, type: 'chat' | 'code' | 'image' | 'embedding' | 'audio' | 'video') {
        this.name = name;
        this.provider = provider;
        this.base_url = base_url;
        this.api_key = api_key;
        this.type = type;
    }

    async call() {

    }
}