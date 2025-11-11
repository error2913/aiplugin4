import { ConfigManager } from "../config/config";
import { sendITTRequest } from "../service";
import { generateId } from "../utils/utils";
import { logger } from "../logger";
import { AI } from "./AI";
import { MessageSegment } from "../utils/utils_string";

export class Image {
    id: string;
    isUrl: boolean;
    file: string;
    scenes: string[];
    base64: string;
    content: string;
    weight: number;

    constructor(file: string) {
        this.id = generateId();
        this.isUrl = file.startsWith('http');
        this.file = file;
        this.scenes = [];
        this.base64 = '';
        this.content = '';
        this.weight = 1;
    }
}

export class ImageManager {
    static validKeys: (keyof ImageManager)[] = ['stolenImages', 'savedImages', 'stealStatus'];
    stolenImages: Image[];
    savedImages: Image[];
    stealStatus: boolean;

    constructor() {
        this.stolenImages = [];
        this.savedImages = [];
        this.stealStatus = false;
    }

    static generateImageId(ai: AI, name: string): string {
        let id = name;

        let acc = 0;
        do {
            id = name + (acc++ ? `_${acc}` : '');
        } while (ai.context.findImage(id, ai));

        return id;
    }

    static getImageCQCode(img: Image): string {
        if (!img.isUrl && img.base64 !== '') {
            return `[CQ:image,file=${seal.base64ToImage(img.base64)}]`;
        }
        return `[CQ:image,file=${img.file}]`;
    }

    stealImages(images: Image[]) {
        const { maxStolenImageNum } = ConfigManager.image;
        this.stolenImages = this.stolenImages.concat(images.filter(item => item.isUrl)).slice(-maxStolenImageNum);
    }

    saveImages(images: Image[]) {
        const { maxSavedImageNum } = ConfigManager.image;
        this.savedImages = this.savedImages.concat(images);

        if (this.savedImages.length > maxSavedImageNum) {
            this.savedImages = this.savedImages
                .sort((a, b) => b.weight - a.weight)
                .slice(0, maxSavedImageNum);
        }
    }

    delSavedImage(nameList: string[]) {
        this.savedImages = this.savedImages.filter(img => !nameList.includes(img.id));
    }

    clearSavedImages() {
        this.savedImages = [];
    }

    drawLocalImageFile(): string {
        const { localImagePaths } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
            if (path.trim() === '') return acc;
            try {
                const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
                if (!name) throw new Error(`本地图片路径格式错误:${path}`);
                acc[name] = path;
            } catch (e) {
                logger.error(e);
            }
            return acc;
        }, {});

        const keys = Object.keys(localImages);
        if (keys.length == 0) return '';
        const index = Math.floor(Math.random() * keys.length);
        return localImages[keys[index]];
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

    drawSavedImageFile(): string {
        if (this.savedImages.length === 0) return null;
        const index = Math.floor(Math.random() * this.savedImages.length);
        const image = this.savedImages[index];
        return seal.base64ToImage(image.base64);
    }

    async drawImageFile(): Promise<string> {
        const { localImagePaths } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
            if (path.trim() === '') return acc;
            try {
                const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
                if (!name) throw new Error(`本地图片路径格式错误:${path}`);
                acc[name] = path;
            } catch (e) {
                logger.error(e);
            }
            return acc;
        }, {});

        const values = Object.values(localImages);
        if (this.stolenImages.length == 0 && values.length == 0 && this.savedImages.length == 0) return '';

        const index = Math.floor(Math.random() * (values.length + this.stolenImages.length + this.savedImages.length));

        if (index < values.length) return values[index];
        else if (index < values.length + this.stolenImages.length) return await this.drawStolenImageFile();
        else return this.drawSavedImageFile();
    }

    /**
     * 提取并替换CQ码中的图片
     * @param ctx 
     * @param message 
     * @returns 
     */
    static async handleImageMessage(ctx: seal.MsgContext, messageArray: MessageSegment[]): Promise<{ messageArray: MessageSegment[], images: Image[] }> {
        const { receiveImage } = ConfigManager.image;

        const processedArray: MessageSegment[] = [];
        const images: Image[] = [];

        for (const item of messageArray) {
            if (item.type !== 'image') {
                processedArray.push(item);
                continue;
            }

            try {
                const file = item.data.url || item.data.file || '';
                if (!file || !receiveImage) {
                    continue;
                }

                const image = new Image(file);

                if (image.isUrl) {
                    const { condition } = ConfigManager.image;

                    const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
                    if (fmtCondition === 1) {
                        const reply = await ImageManager.imageToText(file);
                        if (reply) {
                            image.content = reply;
                        }
                    }
                }

                processedArray.push({ type: 'text', data: { text: image.content ? `<|img:${image.id}:${image.content}|>` : `<|img:${image.id}|>` } });
                images.push(image);
            } catch (error) {
                logger.error('在handleImageMessage中处理图片时出错:', error);
            }
        };

        return { messageArray: processedArray, images };
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

    static async extractExistingImages(ai: AI, s: string): Promise<Image[]> {
        const images = [];
        const match = s.match(/[<＜][\|│｜]img:.+?(?:[\|│｜][>＞]|[\|│｜>＞])/g);
        if (match) {
            for (let i = 0; i < match.length; i++) {
                const id = match[i].match(/[<＜][\|│｜]img:(.+?)(?:[\|│｜][>＞]|[\|│｜>＞])/)[1];
                const image = ai.context.findImage(id, ai);

                if (image) {
                    if (!image.isUrl) {
                        if (image.base64) {
                            image.weight += 1;
                        }
                        images.push(image);
                    } else {
                        const { base64 } = await ImageManager.imageUrlToBase64(image.file);
                        if (!base64) {
                            logger.error(`图片${id}转换为base64失败`);
                            continue;
                        }

                        image.isUrl = false;
                        image.base64 = base64;
                        images.push(image);
                    }
                }
            }
        }
        return images;
    }
}