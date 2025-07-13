import { ConfigManager } from "../config/config";
import { sendITTRequest } from "./service";
import { generateId } from "../utils/utils";
import { logger } from "./logger";

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
    stolenImages: Image[];
    savedImages: Image[];
    stealStatus: boolean;

    constructor() {
        this.stolenImages = [];
        this.savedImages = [];
        this.stealStatus = false;
    }

    static reviver(value: any): ImageManager {
        const im = new ImageManager();
        const validKeys = ['stolenImages', 'savedImages', 'stealStatus'];

        for (const k of validKeys) {
            if (value.hasOwnProperty(k)) {
                im[k] = value[k];
            }
        }

        return im;
    }

    updateStolenImages(images: Image[]) {
        const { maxStolenImageNum } = ConfigManager.image;
        this.stolenImages = this.stolenImages.concat(images.filter(item => item.isUrl)).slice(-maxStolenImageNum);
    }

    updateSavedImages(images: Image[]) {
        const { maxSavedImageNum } = ConfigManager.image;
        this.savedImages = this.savedImages.concat(images.filter(item => item.isUrl));
    
        if (this.savedImages.length > maxSavedImageNum) {
            this.savedImages.sort((a, b) => a.weight - b.weight);
            this.savedImages = this.savedImages.slice(-maxSavedImageNum);
        }
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
        if (this.stolenImages.length === 0) {
            return '';
        }

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

    getSavedImagesInfo(): string {
        if (this.savedImages.length === 0) {
            return '暂无保存的图片';
        }
        
        const imageList = this.savedImages.map((img, index) => 
            `${index + 1}.   名称: ${img.id}\n   应用场景: ${img.scenes.join('、') || '无'}\n   权重: ${img.weight}`
        ).join('\n');
        
        return `保存的图片列表:\n${imageList}`;
    }

    getSavedImagesInfoWithCQ(): string {
        if (this.savedImages.length === 0) {
            return '暂无保存的图片';
        }
        
        const imageList = this.savedImages.map((img, index) => {
            const filePath = seal.base64ToImage(img.base64);
            return `${index + 1}.  名称: ${img.id}\n   应用场景: ${img.scenes.join('、') || '无'}\n   权重: ${img.weight}\n   [CQ:image,file=${filePath}]`;
        }).join('\n\n');
        
        return `保存的图片列表:\n${imageList}`;
    }

    deleteSavedImageByName(imageName: string): string {
        const imageIndex = this.savedImages.findIndex(img => img.id === imageName);
        if (imageIndex === -1) {
            return `未找到名称为"${imageName}"的保存图片`;
        }

        const deletedImage = this.savedImages.splice(imageIndex, 1)[0];
        return `已删除图片"${deletedImage.id}"`;
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
        if (this.stolenImages.length == 0 && values.length == 0 && this.savedImages.length == 0) {
            return '';
        }

        const index = Math.floor(Math.random() * (values.length + this.stolenImages.length + this.savedImages.length));

        if (index < values.length) {
            return values[index];
        } else if (index < values.length + this.stolenImages.length) {
            return await this.drawStolenImageFile();
        } else {
            return this.drawSavedImageFile();
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