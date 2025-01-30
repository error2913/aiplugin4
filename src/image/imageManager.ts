import { ConfigManager } from "../utils/configUtils";
import { getUrlsInCQCode, parseBody } from "../utils/utils";

export class ImageManager {
    images: string[];
    stealStatus: boolean;

    constructor() {
        this.images = [];
        this.stealStatus = false;
    }

    static reviver(value: any): ImageManager {
        const im = new ImageManager();
        const validKeys = ['images', 'stealStatus'];

        for (const k of validKeys) {
            if (value.hasOwnProperty(k)) {
                im[k] = value[k];
            }
        }

        return im;
    }

    async handleImageMessage(ctx: seal.MsgContext, message: string): Promise<string> {
        const { maxImageNum } = ConfigManager.getImageStorageConfig();
        const urls = getUrlsInCQCode(message);
  
        try {
          const url = urls[0];
          const reply = await this.imageToText(ctx, url);
          if (reply) {
            message = message.replace(/\[CQ:image,file=http.*?\]/, `<|图片:${reply}|>`);
          }
        } catch (error) {
          console.error('Error in imageToText:', error);
        }
  
        message = message.replace(/\[CQ:image,file=.*?\]/, '<|图片|>');
  
        if (urls.length !== 0) {
          this.images = this.images.concat(urls).slice(-maxImageNum);
        }

        return message;
    }

    drawLocalImage(): string {
        const { localImages } = ConfigManager.getLocalImageConfig();
        const keys = Object.keys(localImages);
        if (keys.length == 0) {
            return '';
        }
        const index = Math.floor(Math.random() * keys.length);
        return localImages[keys[index]];
    }

    async drawStolenImage(): Promise<string> {
        if (this.images.length == 0) {
            return '';
        }

        const index = Math.floor(Math.random() * this.images.length);
        const url = this.images.splice(index, 1)[0];

        if (!await this.checkImageUrl(url)) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return await this.drawStolenImage();
        }

        return url;
    }

    async drawImage(): Promise<string> {
        const { localImages } = ConfigManager.getLocalImageConfig();
        const values = Object.values(localImages);
        if (this.images.length == 0 && values.length == 0) {
            return '';
        }

        const index = Math.floor(Math.random() * (values.length + this.images.length));

        if (index < values.length) {
            return values[index];
        } else {
            const url = this.images.splice(index - values.length, 1)[0];

            if (!await this.checkImageUrl(url)) {
                await new Promise(resolve => setTimeout(resolve, 500));
                return await this.drawImage();
            }

            return url;
        }
    }

    async checkImageUrl(url: string): Promise<boolean> {
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

    async imageToText(ctx: seal.MsgContext, imageUrl: string, text = ''): Promise<string> {
        const { condition } = ConfigManager.getImageConditionConfig();

        const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
        if (fmtCondition == 0) {
          return '图片';
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
                throw new Error(`请求失败：${JSON.stringify(data.error)}`);
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
            return '图片';
        }
    }
}