import { ConfigManager } from "../config/config";
import { sendITTRequest } from "./service";
import { generateId } from "../utils/utils";
import { logger } from "./logger";

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

    updateSavedImageList(name: string, scene: string, base64: string) {
        const { maxSavedImageNum } = ConfigManager.image;
        
        const savedImages = this.imageList.filter(img => !img.isUrl && (() => {
            try {
                const meta = JSON.parse(img.content);
                return meta && typeof meta.name === 'string';
            } catch {
                return false;
            }
        })());
        
        if (savedImages.length >= maxSavedImageNum) {
            throw new Error(`保存图片已达到上限${maxSavedImageNum}张，无法继续保存`);
        }

        let finalName = name;
        let count = 1;
        while (this.imageList.some(img => {
            try {
                const meta = JSON.parse(img.content);
                return meta.name === finalName;
            } catch {
                return false;
            }
        })) {
            finalName = `${name}_${count++}`;
        }

        const img = new Image(`${base64}`);
        img.content = JSON.stringify({ name: finalName, scene: scene || '' });

        this.imageList.push(img);
        return finalName;
    }


    drawLocalImageFile(): string {
        const { localImagePaths } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
            if (path.trim() === '') {
                return acc;
            }
            try {
                const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
                if (!name) {
                    throw new Error(`本地图片路径格式错误:${path}`);
                }

                acc[name] = path;
            } catch (e) {
                logger.error(e);
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
        const stolenImages = this.imageList.filter(img => img.isUrl);
        if (stolenImages.length === 0) {
            return '';
        }

        const index = Math.floor(Math.random() * stolenImages.length);
        const image = stolenImages.splice(index, 1)[0];
        const url = image.file;

        if (!await ImageManager.checkImageUrl(url)) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return await this.drawStolenImageFile();
        }

        return url;
    }

    async drawSaveImageFile(): Promise<{ file: string, name: string, scene: string } | null> {
        const savedImages = this.imageList.filter(img => !img.isUrl && (() => {
            try {
                const meta = JSON.parse(img.content);
                return meta && typeof meta.name === 'string';
            } catch {
                return false;
            }
        })());
        if (savedImages.length === 0) {
            return null;
        }
        const index = Math.floor(Math.random() * savedImages.length);
        const image = savedImages.splice(index, 1)[0];
        const imagefile = seal.base64ToImage(image.file);

        try {
            const meta = JSON.parse(image.content);
            return {
                file: imagefile,
                name: meta.name,
                scene: meta.scene || ''
            };
        } catch {
            return null;
        }
    }

    async drawImageFile(): Promise<string> {
        const { localImagePaths } = ConfigManager.image;
        const localImages: { [key: string]: string } = localImagePaths.reduce((acc: { [key: string]: string }, path: string) => {
            if (path.trim() === '') {
                return acc;
            }
            try {
                const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
                if (!name) {
                    throw new Error(`本地图片路径格式错误:${path}`);
                }

                acc[name] = path;
            } catch (e) {
                logger.error(e);
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
            const image = this.imageList[index - values.length];
            if (!image.isUrl) {
                const file = seal.base64ToImage(image.file);
                return file;
            } else {
                this.imageList.splice(index - values.length, 1);
                const url = image.file;

                if (!await ImageManager.checkImageUrl(url)) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    return await this.drawImageFile();
                }

                return url;
            }
        }
    }

    /**
     * 提取并替换CQ码中的图片
     * @param ctx 
     * @param message 
     * @returns 
     */
    static async handleImageMessage(ctx: seal.MsgContext, message: string): Promise<{ message: string, images: Image[] }> {
        const { receiveImage } = ConfigManager.image;

        const images: Image[] = [];

        const match = message.match(/\[CQ:image,file=(.*?)\]/g);
        if (match !== null) {
            for (let i = 0; i < match.length; i++) {
                try {
                    const file = match[i].match(/\[CQ:image,file=(.*?)\]/)[1];

                    if (!receiveImage) {
                        message = message.replace(`[CQ:image,file=${file}]`, '');
                        continue;
                    }

                    const image = new Image(file);

                    message = message.replace(`[CQ:image,file=${file}]`, `<|img:${image.id}|>`);

                    if (image.isUrl) {
                        const { condition } = ConfigManager.image;

                        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
                        if (fmtCondition === 1) {
                            const reply = await ImageManager.imageToText(file);
                            if (reply) {
                                image.content = reply;
                                message = message.replace(`<|img:${image.id}|>`, `<|img:${image.id}:${reply}|>`);
                            }
                        }
                    }

                    images.push(image);
                } catch (error) {
                    logger.error('在handleImageMessage中处理图片时出错:', error);
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
}