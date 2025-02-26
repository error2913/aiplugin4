import { ConfigManager } from "../config/config";
import { sendITTRequest } from "./service";
import { generateId, log } from "../utils/utils";

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
        const { maxImageNum } = ConfigManager.image;
        this.imageList = this.imageList.concat(images.filter(item => item.isUrl)).slice(-maxImageNum);
    }

    drawLocalImageFile(): string {
        const { localImagesTemplate } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagesTemplate.reduce((acc: { [key: string]: string }, item: string) => {
            const match = item.match(/<(.+)>.*/);
            if (match !== null) {
                const key = match[1];
                acc[key] = item.replace(/<.*>/g, '');
            }
            return acc;
        }, {});

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
        const { localImagesTemplate } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagesTemplate.reduce((acc: { [key: string]: string }, item: string) => {
            const match = item.match(/<(.+)>.*/);
            if (match !== null) {
                const key = match[1];
                acc[key] = item.replace(/<.*>/g, '');
            }
            return acc;
        }, {});

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

    /**
     * 提取并替换CQ码中的图片
     * @param ctx 
     * @param message 
     * @returns 
     */
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
                        const { condition } = ConfigManager.image;

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
                    log('URL有效且未过期');
                    isValid = true;
                } else {
                    log(`URL有效但未返回图片 Content-Type: ${contentType}`);
                }
            } else {
                if (response.status === 500) {
                    log(`URL不知道有没有效 状态码: ${response.status}`);
                    isValid = true;
                } else {
                    log(`URL无效或过期 状态码: ${response.status}`);
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

        const { maxChars } = ConfigManager.image;

        const raw_reply = await sendITTRequest(messages);
        const reply = raw_reply.slice(0, maxChars);

        return reply;
    }
}