import { ConfigManager } from "../utils/configUtils";
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

    static async handleImageMessage(ctx: seal.MsgContext, message: string): Promise<{message: string, images: Image[]}>  {
        const images: Image[] = [];

        const match = message.match(/\[CQ:image,file=(.*?)\]/g);
        if (match !== null) {
            for (let i = 0; i < match.length; i++) {
                try {
                    const file = match[i].match(/\[CQ:image,file=(.*?)\]/)[1];
                    const image = new Image(file);

                    message = message.replace(`[CQ:image,file=${file}]`, `<|图片${image.id}|>`);

                    if (image.isUrl) {
                        const reply = await ImageManager.imageToText(ctx, file);
                        if (reply) {
                            image.content = reply;
                            message = message.replace(`<|图片${image.id}|>`, `<|图片${image.id}:${reply}|>`);
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
                    console.log('URL is valid and not expired.');
                    isValid = true;
                } else {
                    console.log(`URL is valid but does not return an image. Content-Type: ${contentType}`);
                }
            } else {
                console.log(`URL is expired or invalid. Status: ${response.status}`);
            }
        } catch (error) {
            console.error('Error checking URL:', error);
        }

        return isValid;
    }

    static async imageToText(ctx: seal.MsgContext, imageUrl: string, text = ''): Promise<string> {
        const { condition } = ConfigManager.getImageConditionConfig();

        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
        if (fmtCondition == 0) {
            return '';
        }

        const messages = [{
            role: "user",
            content: [
                {
                    "type": "image_url",
                    "image_url": { "url": imageUrl }
                }, {
                    "type": "text",
                    "text": text ? text : "请帮我分析这张图片，简短地输出文字描述。"
                }
            ]
        }]

        const { url, apiKey, maxChars, bodyTemplate } = ConfigManager.getImageRequestConfig();

        try {
            const bodyObject = parseBody(bodyTemplate, messages, null, null);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(bodyObject)
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (data.error) {
                throw new Error(`请求失败：${JSON.stringify(data.error.message)}`);
            }

            if (data.choices && data.choices.length > 0) {
                const reply = data.choices[0].message.content;
                console.log("AI返回图片内容：", reply);
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