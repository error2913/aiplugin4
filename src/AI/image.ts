import { ConfigManager } from "../config/configManager";
import { sendITTRequest } from "../service";
import { generateId } from "../utils/utils";
import { logger } from "../logger";
import { AI } from "./AI";
import { MessageSegment } from "../utils/utils_string";

export class Image {
    static validKeys: (keyof Image)[] = ['id', 'file', 'content'];
    id: string;
    file: string;
    content: string;

    constructor() {
        this.id = generateId();
        this.file = '';
        this.content = '';
    }

    get isUrl(): boolean {
        return this.file.startsWith('http');
    }

    get base64(): string {
        return ConfigManager.ext.storageGet(`base64_${this.id}`) || '';
    }

    set base64(value: string) {
        ConfigManager.ext.storageSet(`base64_${this.id}`, value);
    }
}

export class ImageManager {
    static validKeys: (keyof ImageManager)[] = ['stolenImages', 'stealStatus'];
    stolenImages: Image[];
    stealStatus: boolean;

    constructor() {
        this.stolenImages = [];
        this.stealStatus = false;
    }

    static getImageCQCode(img: Image): string {
        if (!img) return '';
        const file = img.base64 ? seal.base64ToImage(img.base64) : img.file;
        return `[CQ:image,file=${file}]`;
    }

    stealImages(images: Image[]) {
        const { maxStolenImageNum } = ConfigManager.image;
        this.stolenImages = this.stolenImages.concat(images.filter(item => item.isUrl)).slice(-maxStolenImageNum);
    }

    drawLocalImageFile(): string {
        const { localImagePathMap } = ConfigManager.image;
        const ids = Object.keys(localImagePathMap);
        if (ids.length == 0) return '';
        const index = Math.floor(Math.random() * ids.length);
        return localImagePathMap[ids[index]];
    }

    async drawStolenImageFile(): Promise<string> {
        if (this.stolenImages.length === 0) return '';

        const index = Math.floor(Math.random() * this.stolenImages.length);
        const image = this.stolenImages.splice(index, 1)[0];
        const url = image.file;

        if (!await ImageManager.checkImageUrl(url)) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return await this.drawStolenImageFile();
        }

        return url;
    }

    async drawImageFile(): Promise<string> {
        const { localImagePathMap } = ConfigManager.image;

        const files = Object.values(localImagePathMap);
        if (this.stolenImages.length == 0 && files.length == 0) return '';

        const index = Math.floor(Math.random() * (files.length + this.stolenImages.length));
        return index < files.length ? files[index] : await this.drawStolenImageFile();
    }

    /**
     * 提取并替换CQ码中的图片
     * @param ctx 
     * @param message 
     * @returns 
     */
    async handleImageMessageSegment(ctx: seal.MsgContext, seg: MessageSegment): Promise<{ content: string, images: Image[] }> {
        const { receiveImage } = ConfigManager.image;
        if (!receiveImage || seg.type !== 'image') return { content: '', images: [] };

        let content = '';
        const images: Image[] = [];
        try {
            const file = seg.data.url || seg.data.file || '';
            if (!file) return { content: '', images: [] };

            const image = new Image();
            image.file = file;
            if (image.isUrl) {
                const { condition } = ConfigManager.image;
                const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
                if (fmtCondition === 1) image.content = await ImageManager.imageToText(file);
            }

            content += image.content ? `<|img:${image.id}:${image.content}|>` : `<|img:${image.id}|>`;
            images.push(image);
        } catch (error) {
            logger.error('在handleImageMessage中处理图片时出错:', error);
        }

        if (this.stealStatus) this.stealImages(images);
        return { content, images };
    }

    static async checkImageUrl(url: string): Promise<boolean> {
        let isValid = false;

        try {
            const response = await fetch(url, { method: 'GET' });

            if (response.ok) {
                const contentType = response.headers.get('Content-Type');
                if (contentType && contentType.startsWith('image')) {
                    logger.info('URL有效且未过期');
                    isValid = true;
                } else {
                    logger.warning(`URL有效但未返回图片 Content-Type: ${contentType}`);
                }
            } else {
                if (response.status === 500) {
                    logger.warning(`URL不知道有没有效 状态码: ${response.status}`);
                    isValid = true;
                } else {
                    logger.warning(`URL无效或过期 状态码: ${response.status}`);
                }
            }
        } catch (error) {
            logger.error('在checkImageUrl中请求出错:', error);
        }

        return isValid;
    }

    static async imageToText(imageUrl: string, text = ''): Promise<string> {
        const { defaultPrompt, urlToBase64 } = ConfigManager.image;

        let useBase64 = false;
        let imageContent = {
            "type": "image_url",
            "image_url": { "url": imageUrl }
        }
        if (urlToBase64 == '总是') {
            const { base64, format } = await ImageManager.imageUrlToBase64(imageUrl);
            if (!base64 || !format) {
                logger.warning(`转换为base64失败`);
                return '';
            }

            useBase64 = true;
            imageContent = {
                "type": "image_url",
                "image_url": { "url": `data:image/${format};base64,${base64}` }
            }
        }

        const textContent = {
            "type": "text",
            "text": text ? text : defaultPrompt
        }

        const messages = [{
            role: "user",
            content: [imageContent, textContent]
        }]

        const { maxChars } = ConfigManager.image;

        const raw_reply = await sendITTRequest(messages, useBase64);
        const reply = raw_reply.slice(0, maxChars);

        return reply;
    }

    static async imageUrlToBase64(imageUrl: string): Promise<{ base64: string, format: string }> {
        const { imageTobase64Url } = ConfigManager.backend;

        try {
            const response = await fetch(`${imageTobase64Url}/image-to-base64`, {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({ url: imageUrl })
            });

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
            }
            if (!text) {
                throw new Error("响应体为空");
            }

            try {
                const data = JSON.parse(text);
                if (data.error) {
                    throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                }
                if (!data.base64 || !data.format) {
                    throw new Error(`响应体中缺少base64或format字段`);
                }
                return data;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (error) {
            logger.error("在imageUrlToBase64中请求出错：", error);
            return { base64: '', format: '' };
        }
    }

    static async extractExistingImagesToSave(ctx: seal.MsgContext, ai: AI, s: string): Promise<Image[]> {
        const images = [];
        const match = s.match(/[<＜][\|│｜]img:.+?(?:[\|│｜][>＞]|[\|│｜>＞])/g);
        if (match) {
            for (let i = 0; i < match.length; i++) {
                const id = match[i].match(/[<＜][\|│｜]img:(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/)[1];
                const image = ai.context.findImage(ctx, id);
                if (image) {
                    if (image.isUrl) {
                        const { base64 } = await ImageManager.imageUrlToBase64(image.file);
                        if (!base64) {
                            logger.error(`图片${id}转换为base64失败`);
                            continue;
                        }
                        image.file = '';
                        image.base64 = base64;
                    }
                    images.push(image);
                }
            }
        }
        return images;
    }
}