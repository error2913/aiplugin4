// 图片资源：URL/base64/本地路径图片，图片识别与存储
import Agent from "../agent/agent";
import { ext } from "../config/config";
import Config from "../config/config";
import { logger } from "../logger";
import Model from "../model/model";
import { IMAGE_PROMPT_TEMPLATE } from "../prompt/templates";
import { getSessionId } from "../utils/seal";
import { MessageSegment } from "../utils/string";
import { generateId, resolveLocalPath, revive, TypeDescriptor } from "../utils/utils";

// 图片转文字结果超过该字数时交给压缩智能体压缩，避免撑爆上下文
const IMAGE_TEXT_COMPRESS_MIN_LENGTH = 5000;

export default class Image {
    static validKeysMap: { [key in keyof Image]?: TypeDescriptor<Image[key]> } = {
        imageId: 'string',
        sourceSessionId: 'string',
        path: 'string',
        url: 'string',
        base64: 'string',
        format: 'string',
        description: 'string',
    }
    imageId: string;
    sourceSessionId: string;
    path: string;
    url: string;
    base64: string;
    format: string;
    description: string;

    constructor() {
        this.imageId = '';
        this.sourceSessionId = '';
        this.path = '';
        this.url = '';
        this.base64 = '';
        this.format = '';
        this.description = '';
    }

    get type(): 'url' | 'local' | 'base64' {
        if (this.base64) return 'base64';
        if (this.url.startsWith('http')) return 'url';
        return 'local';
    }

    get CQCode(): string {
        const file = this.type === 'base64' ? seal.base64ToImage(this.base64) : (this.url || this.path);
        return `[CQ:image,file=${file}]`;
    }

    get base64Url(): string {
        let format = this.format;
        if (!format || format === "unknown") format = 'png';
        return `data:image/${format};base64,${this.base64}`
    }

    /**
     * 获取图片的URL，若为base64则返回base64Url
     */
    get src(): string {
        return this.type === 'base64' ? this.base64Url : this.url;
    }

    async checkImageUrl(): Promise<boolean> {
        if (this.type !== 'url') return true;
        let isValid = false;
        try {
            const response = await fetch(this.url, { method: 'GET' });

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

    async urlToBase64() {
        if (this.type !== 'url') return;
        const { IMAGE_TO_BASE64: imageTobase64Url } = Config.backend;
        try {
            const response = await fetch(`${imageTobase64Url}/image-to-base64`, {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({ url: this.src })
            });

            const text = await response.text();
            if (!response.ok) throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
            if (!text) throw new Error("响应体为空");

            try {
                const data = JSON.parse(text);
                if (data.error) throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                if (!data.base64 || !data.format) throw new Error(`响应体中缺少base64或format字段`);
                this.base64 = data.base64;
                this.format = data.format;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (error) {
            logger.error("在imageUrlToBase64中请求出错：", error);
        }

        Image.save(this);
    }

    async imageToText(prompt = '') {
        if (!Config.model.IMAGE_MODEL_ENABLED) {
            logger.info(`图片模型开关未开启，跳过识别: ${this.imageId}`);
            return;
        }
        const { URL_TO_BASE64 } = Config.image;
        const defaultPrompt = IMAGE_PROMPT_TEMPLATE({});

        if (URL_TO_BASE64 == '总是' && this.type === 'url') await this.urlToBase64();

        const model = Model.getImageModel('image-understanding');
        if (!model) {
            logger.error(`未找到支持image-understanding的模型`);
            return;
        }

        this.description = await this.compressIfLong(await model.callITT(this.src, prompt ? prompt : defaultPrompt));

        if (!this.description && URL_TO_BASE64 === '自动' && this.type === 'url') {
            logger.info(`图片${this.imageId}第一次识别失败，自动尝试使用转换为base64`);
            await this.urlToBase64();
            this.description = await this.compressIfLong(await model.callITT(this.src, prompt ? prompt : defaultPrompt));
        }

        if (!this.description) logger.error(`图片${this.imageId}识别失败`);
    }

    /** 图片转文字结果过长时交给压缩智能体压缩，失败时保留原文 */
    private async compressIfLong(text: string): Promise<string> {
        if (!text || text.length <= IMAGE_TEXT_COMPRESS_MIN_LENGTH) return text;
        try {
            const compressed = await Agent.get('compress_agent').chat(text);
            if (compressed) return compressed;
        } catch (e) {
            logger.warning('压缩图片识别结果失败，保留原文: ' + (e instanceof Error ? e.message : String(e)));
        }
        return text;
    }


    static imageMap: { [key: string]: Image } = {};

    static generateImageId(): string {
        let id = generateId(), a = 0;
        while (this.get(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                logger.error(`生成图片id失败，已尝试1000次，放弃`);
                throw new Error(`生成图片id失败，已尝试1000次，放弃`);
            }
        }
        return id;
    }

    static createUrlImage(sourceSessionId: string, url: string, imageId?: string): Image {
        imageId = imageId || this.generateImageId();
        const img = new Image();
        img.imageId = imageId;
        img.sourceSessionId = sourceSessionId;
        img.url = url;
        this.imageMap[imageId] = img;
        this.save(img);
        return img;
    }

    static createLocalImage(imageId: string, path: string): Image {
        const img = new Image();
        img.imageId = imageId;
        img.path = resolveLocalPath(path);
        this.imageMap[imageId] = img;
        return img;
    }

    static get(imageId: string): Image | null {
        if (!Object.prototype.hasOwnProperty.call(this.imageMap, imageId)) {
            let img = new Image();
            try {
                const text = ext.storageGet(`image_${imageId}`);
                if (!text) return null;
                const data = JSON.parse(text || '{}');
                img = revive(Image, data);
            } catch (error) {
                logger.error(`加载图片${imageId}失败: ${error}`);
                return null;
            }
            this.imageMap[imageId] = img;
        }
        return this.imageMap[imageId];
    }
    static save(img: Image) {
        ext.storageSet(`image_${img.imageId}`, JSON.stringify(img));
    }

    static getUserAvatar(uid: string): Image {
        const img = new Image();
        img.imageId = `user_avatar:${uid}`;
        img.url = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/^.+:/, '')}&s=640`;
        return img;
    }

    static getGroupAvatar(gid: string): Image {
        const img = new Image();
        img.imageId = `group_avatar:${gid}`;
        img.url = `https://p.qlogo.cn/gh/${gid.replace(/^.+:/, '')}/${gid.replace(/^.+:/, '')}/640`;
        return img;
    }

    static get LocalImageList() {
        const { LOCAL_IMAGE_PATH_MAP } = Config.image;
        return Object.keys(LOCAL_IMAGE_PATH_MAP).map(id => this.createLocalImage(id, LOCAL_IMAGE_PATH_MAP[id]));
    }

    static getLocalImageListText(p: number = 1): string {
        const images = this.LocalImageList;
        if (images.length == 0) return '';
        if (p > Math.ceil(images.length / 5)) p = Math.ceil(images.length / 5);
        return images.slice((p - 1) * 5, p * 5)
            .map((img, i) => {
                return `${i + 1 + (p - 1) * 5}. 名称:${img.imageId}
${img.CQCode}`;
            }).join('\n') + `\n当前页码:${p}/${Math.ceil(images.length / 5)}`;
    }

    /**
     * 提取并替换CQ码中的图片 wip
     * @param ctx 
     * @param message 
     * @returns 
     */
    static async handleImageMessageSegment(ctx: seal.MsgContext, seg: MessageSegment): Promise<{ content: string, images: Image[] }> {
        const { RECEIVE_IMAGE } = Config.received;
        if (!RECEIVE_IMAGE || seg.type !== 'image') return { content: '', images: [] };

        let content = '';
        const images: Image[] = [];
        try {
            const rawFile = seg.data.url || seg.data.file || '';
            // Milky 原生 image 的 file 是 FileElement 对象，OB11 通常是字符串；
            // 统一取 URL/本地文件字段，避免把对象写入 Image.url 后在 type getter 中报错。
            const file = typeof rawFile === 'object' && rawFile !== null
                ? ((rawFile as any).url || (rawFile as any).file || '')
                : String(rawFile);
            if (!file) return { content: '', images: [] };

            const image = this.createUrlImage(getSessionId(ctx), file);
            const { IMAGE_CONDITION } = Config.image;
            const fmtCondition = parseInt(seal.format(ctx, `{${IMAGE_CONDITION}}`));
            if (fmtCondition === 1) await image.imageToText();

            content += image.description ? `[img:${image.imageId}:${image.description}]` : `[img:${image.imageId}]`;
            images.push(image);
        } catch (error) {
            logger.error('在handleImageMessage中处理图片时出错:', error);
        }

        return { content, images };
    }

}
