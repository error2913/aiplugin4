import { ConfigManager } from "../utils/configUtils";
import { fetchData } from "../utils/requestUtils";
import { generateId, parseBody } from "../utils/utils";

export class Image {
    id: string;
    isUrl: boolean;
    file: string;
    content: string;

    constructor(file: string) {
        this.id = generateId();
        this.isUrl = file.startsWith('http');
        this.file = file;
        this.content = '';
    }
}

export class ImageManager {
    imageList: Image[];
    stealStatus: boolean;

    constructor() {
        this.imageList = [];
        this.stealStatus = false;
    }

    static reviver(value: any): ImageManager {
        const im = new ImageManager();
        const validKeys = ['imageList', 'stealStatus'];

        for (const k of validKeys) {
            if (value.hasOwnProperty(k)) {
                im[k] = value[k];
            }
        }

        return im;
    }

    updateImageList(images: Image[]) {
        const { maxImageNum } = ConfigManager.getImageStorageConfig();
        this.imageList = this.imageList.concat(images.filter(item => item.isUrl)).slice(-maxImageNum);
    }

    drawLocalImageFile(): string {
        const { localImages } = ConfigManager.getLocalImageConfig();
        const keys = Object.keys(localImages);
        if (keys.length == 0) {
            return '';
        }
        const index = Math.floor(Math.random() * keys.length);
        return localImages[keys[index]];
    }

    async drawStolenImageFile(): Promise<string> {
        if (this.imageList.length == 0) {
            return '';
        }

        const index = Math.floor(Math.random() * this.imageList.length);
        const image = this.imageList.splice(index, 1)[0];
        const url = image.file;

        if (!await ImageManager.checkImageUrl(url)) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return await this.drawStolenImageFile();
        }

        return url;
    }

    async drawImageFile(): Promise<string> {
        const { localImages } = ConfigManager.getLocalImageConfig();
        const values = Object.values(localImages);
        if (this.imageList.length == 0 && values.length == 0) {
            return '';
        }

        const index = Math.floor(Math.random() * (values.length + this.imageList.length));

        if (index < values.length) {
            return values[index];
        } else {
            const image = this.imageList.splice(index - values.length, 1)[0];
            const url = image.file;

            if (!await ImageManager.checkImageUrl(url)) {
                await new Promise(resolve => setTimeout(resolve, 500));
                return await this.drawImageFile();
            }

            return url;
        }
    }

    static async handleImageMessage(ctx: seal.MsgContext, message: string): Promise<{ message: string, images: Image[] }> {
        const images: Image[] = [];

        const match = message.match(/\[CQ:image,file=(.*?)\]/g);
        if (match !== null) {
            for (let i = 0; i < match.length; i++) {
                try {
                    const file = match[i].match(/\[CQ:image,file=(.*?)\]/)[1];
                    const image = new Image(file);

                    message = message.replace(`[CQ:image,file=${file}]`, `<|图片${image.id}|>`);

                    if (image.isUrl) {
                        const { condition } = ConfigManager.getImageConditionConfig();

                        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
                        if (fmtCondition === 1) {
                            const reply = await ImageManager.imageToText(file);
                            if (reply) {
                                image.content = reply;
                                message = message.replace(`<|图片${image.id}|>`, `<|图片${image.id}:${reply}|>`);
                            }
                        }
                    }

                    images.push(image);
                } catch (error) {
                    console.error('Error in imageToText:', error);
                }
            }
        }

        return { message, images };
    }

    static async checkImageUrl(url: string): Promise<boolean> {
        let isValid = false;

        try {
            const response = await fetch(url, { method: 'GET' });

            if (response.ok) {
                const contentType = response.headers.get('Content-Type');
                if (contentType && contentType.startsWith('image')) {
                    ConfigManager.printLog('URL有效且未过期');
                    isValid = true;
                } else {
                    ConfigManager.printLog(`URL有效但未返回图片 Content-Type: ${contentType}`);
                }
            } else {
                if (response.status === 500) {
                    ConfigManager.printLog(`URL不知道有没有效 状态码: ${response.status}`);
                    isValid = true;
                } else {
                    ConfigManager.printLog(`URL无效或过期 状态码: ${response.status}`);
                }
            }
        } catch (error) {
            console.error('Error checking URL:', error);
        }

        return isValid;
    }

    static async imageToText(imageUrl: string, text = ''): Promise<string> {
        const messages = [{
            role: "user",
            content: [
                {
                    "type": "image_url",
                    "image_url": { "url": imageUrl }
                }, {
                    "type": "text",
                    "text": text ? text : "请帮我用简短的语言概括这张图片的特征，包括图片类型、场景、主题等信息"
                }
            ]
        }]

        const { url, apiKey, maxChars, bodyTemplate } = ConfigManager.getImageRequestConfig();

        try {
            const bodyObject = parseBody(bodyTemplate, messages, null, null);
            const time = Date.now();

            const data = await fetchData(url, apiKey, bodyObject);

            if (data.choices && data.choices.length > 0) {
                const message = data.choices[0].message;
                const reply = message.content;

                ConfigManager.printLog(`响应内容:`, reply, '\nlatency', Date.now() - time, 'ms');

                return reply.slice(0, maxChars);
            } else {
                throw new Error("服务器响应中没有choices或choices为空");
            }
        } catch (error) {
            console.error("在imageToText中请求出错：", error);
            return '';
        }
    }
}