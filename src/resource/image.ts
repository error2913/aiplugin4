// 图片资源：URL/base64/本地路径图片，图片识别与存储
import Config from "../config/config";
import { getHost } from "../core/host";
import { logger } from "../logger";
import Model from "../model/model";
import { IMAGE_PROMPT_TEMPLATE } from "../prompt/templates";
import { backendAuthHeaders, backendStatusHint } from "../utils/backend";
import { buildImageTruncateMarker } from "../utils/raw_marker";
import { getSessionId } from "../utils/seal";
import { decodeUrlHtmlEntities, MessageSegment } from "../utils/string";
import { getPlatform } from "../utils/target_id";
import { generateId, resolveLocalPath, revive, TypeDescriptor } from "../utils/utils";

import { ImageHost } from "./image_host";
import type { HostItem, ImageSource } from "./image_host";
import { ImageIndex } from "./image_index";
import { parseImageRef, rewriteHostedImageRefs } from "./image_ref";

const log = logger.withTag('image');

// URL 转 base64 失败后的冷却期：1 小时内不再重复请求，超时后允许重试一次
const IMAGE_BASE64_RETRY_TTL = 60 * 60 * 1000;

// URL 转 base64 连续失败达到该次数后永久放弃，不再按冷却期重试
const IMAGE_BASE64_RETRY_MAX = 3;

// Image.get 里刷新「最后使用时间」的最小间隔：避免每次渲染都写 storage
const IMAGE_LAST_USED_TOUCH_TTL = 60 * 60 * 1000;

// QQ 图床临时直链的域名：带 rkey 且到手后很快失效，服务端下载方（插件后端/模型）常常拿不到
const TEMPORARY_IMAGE_URL_HOSTS = [
    'multimedia.nt.qq.com.cn',
    'multimedia.nt.qq.com',
    'gchat.qpic.cn',
    'c2cpicdw.qpic.cn',
    'c2cpic.qpic.cn',
];

// 进行中的 URL→base64 请求，按 Image 实例去重（同一实例并发调用共享同一次请求）
const pendingUrlToBase64 = new WeakMap<Image, Promise<void>>();

export default class Image {
    static validKeysMap: { [key in keyof Image]?: TypeDescriptor<Image[key]> } = {
        imageId: 'string',
        sourceSessionId: 'string',
        path: 'string',
        url: 'string',
        base64: 'string',
        format: 'string',
        description: 'string',
        rawDescription: 'string',
        raw: 'string',
        base64Failed: 'boolean',
        base64FailedAt: 'number',
        base64FailedCount: 'number',
        urlBroken: 'boolean',
        hostedUrl: 'string',
        hostedId: 'string',
        hostedAt: 'number',
        lastUsedAt: 'number',
        sourceMeta: 'string',
    }
    imageId: string;
    sourceSessionId: string;
    path: string;
    url: string;
    base64: string;
    format: string;
    description: string;
    /** 识别转文字结果的完整原文：仅在展示文本被截断时写入（不参与渲染/预算），供 read_raw kind=image 按需读取 */
    rawDescription: string;
    /** 接收时的原始消息段 data（JSON），含 file/file_unique/md5/subType/url 等，供 resolve_special_id 查询 */
    raw: string;
    /** URL 转 base64 是否失败过（冷却期内不再重复请求） */
    base64Failed: boolean;
    /** 最近一次 URL 转 base64 失败的毫秒时间戳，用于冷却期判断 */
    base64FailedAt: number;
    /** URL 转 base64 连续失败次数，达到上限后永久放弃重试 */
    base64FailedCount: number;
    /** URL 已确认不可用（后端下载被 4xx 拒绝 / 模型报下载图片失败），不再发给模型也不再重试转换 */
    urlBroken: boolean;
    /** 图床相对路径（如 /i/<sha256>；空 = 未入库） */
    hostedUrl: string;
    /** 图床 id（sha256），取 b64 / 后续释放用 */
    hostedId: string;
    /** 入库时间（ms），0 = 未入库 */
    hostedAt: number;
    /** 最后一次使用时间（ms），清理任务据此判断是否过期；0 = 旧数据 */
    lastUsedAt: number;
    /** 来源信息（JSON：platform/group_id/user_id/message_id/at），入库时上报图床 */
    sourceMeta: string;
    /** 图床虚拟引用图：只存在内存，绝不落 storage / 索引 */
    virtualHosted: boolean;

    constructor() {
        this.imageId = '';
        this.sourceSessionId = '';
        this.path = '';
        this.url = '';
        this.base64 = '';
        this.format = '';
        this.description = '';
        this.rawDescription = '';
        this.raw = '';
        this.base64Failed = false;
        this.base64FailedAt = 0;
        this.base64FailedCount = 0;
        this.urlBroken = false;
        this.hostedUrl = '';
        this.hostedId = '';
        this.hostedAt = 0;
        this.lastUsedAt = 0;
        this.sourceMeta = '';
        this.virtualHosted = false;
    }

    get type(): 'url' | 'local' | 'base64' {
        if (this.base64) return 'base64';
        if (this.url.startsWith('http')) return 'url';
        // 已入图床但本地没有 url（如生图 base64 转存后）：仍按 URL 图片处理，便于走 b64 出口
        if (this.hostedId) return 'url';
        return 'local';
    }

    /** 是否已入图床 */
    get hosted(): boolean {
        return !!(this.hostedId && ImageHost.enabled);
    }

    /** 头像类图片：qlogo 是稳定公网地址，模型能直接下载，不需要（也不该）转存图床 */
    get isAvatarImage(): boolean {
        return this.imageId.startsWith('user_avatar:') || this.imageId.startsWith('group_avatar:');
    }

    /**
     * 图床对外绝对地址：已入图床且配置了对外地址（image-host.publicUrl 或非回环 url）时用图床地址，
     * 否则原始 URL。对外的发送/模型取图必须先判 ImageHost.externalEnabled（见 getSendFile()）。
     */
    get remoteUrl(): string {
        return this.hosted
            ? (ImageHost.externalUrl(this.hostedUrl || `/i/${this.hostedId}`) || this.url)
            : this.url;
    }

    /**
     * 发送给协议端使用的图片值（本地文件路径 / URL）。
     *
     * - 已有字节（base64）→ 本地文件；
     * - 已入图床且对外地址可用（IP/域名）→ 直接给图床稳定地址；
     * - 已入图床但对外地址不可用（回环且没配 publicUrl）→ 取 b64 落成本地文件；
     * - 其余 → 原始 URL / 本地路径。
     *
     * 回环地址不要外发：协议端常在容器/另一台机器，127.0.0.1 指向它自己。
     */
    async getSendFile(): Promise<string> {
        if (this.base64) return seal.base64ToImage(this.base64);
        if (this.hosted && ImageHost.externalEnabled) return this.remoteUrl;
        if (this.hosted) {
            const data = await ImageHost.fetchBase64(this.hostedId);
            if (data && data.base64) return seal.base64ToImage(data.base64);
            log.warning(`图片${this.imageId}从图床取字节失败，无法生成本地文件`
                + (ImageHost.lastError ? `：${ImageHost.lastError}` : '')
                + '；请检查图床地址是否可从插件访问');
            // 兜底：原始 http(s) 链接（可能已过期，但总比回环地址强）
            if (this.url && /^https?:\/\//i.test(this.url)) return this.url;
            return '';
        }
        return this.url || this.path;
    }

    /** 同步版 CQ（只用于本地图展示；外发请用 getSendFile()，hosted 需要异步取字节/判可达性） */
    get CQCode(): string {
        const file = this.type === 'base64'
            ? seal.base64ToImage(this.base64)
            : (this.hosted
                ? (ImageHost.externalEnabled ? this.remoteUrl : '')
                : (this.url || this.path));
        if (!file) return '';
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
        return this.type === 'base64' ? this.base64Url : this.remoteUrl;
    }

    async checkImageUrl(): Promise<boolean> {
        if (this.type !== 'url') return true;
        let isValid = false;
        try {
            const response = await fetch(this.url, { method: 'GET' });

            if (response.ok) {
                const contentType = response.headers.get('Content-Type');
                if (contentType && contentType.startsWith('image')) {
                    log.info('URL有效且未过期');
                    isValid = true;
                } else {
                    log.warning(`URL有效但未返回图片 Content-Type: ${contentType}`);
                }
            } else {
                if (response.status === 500) {
                    log.warning(`URL不知道有没有效 状态码: ${response.status}`);
                    isValid = true;
                } else {
                    log.warning(`URL无效或过期 状态码: ${response.status}`);
                }
            }
        } catch (error) {
            log.exception('在checkImageUrl中请求出错', error);
        }
        return isValid;
    }

    /** 转换失败是否应跳过请求：URL 已确认不可用，或 1 小时冷却期内，或连续失败达上限后永久阻断 */
    isBase64RetryBlocked(): boolean {
        if (this.urlBroken) return true;
        if (this.base64FailedCount >= IMAGE_BASE64_RETRY_MAX) return true;
        if (!this.base64Failed) return false;
        return Date.now() - this.base64FailedAt < IMAGE_BASE64_RETRY_TTL;
    }

    /** QQ 图床等带 rkey 的临时直链：到手后很快失效，模型侧往往也下载不到，不宜作为 image_url 交给模型 */
    static isTemporaryUrl(url: string): boolean {
        if (!url) return false;
        if (/[?&]rkey=/i.test(url)) return true;
        let host = '';
        try {
            host = new URL(url).hostname.toLowerCase();
        } catch (_e) {
            return false;
        }
        return TEMPORARY_IMAGE_URL_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
    }

    /**
     * 该图片是否已不适合作为 image_url 交给模型：URL 已确认不可用，
     * 或 QQ 临时直链转换失败后进入冷却/永久放弃（链接多半已过期，不值得再赌）。
     * base64 图片与稳定公网 URL 不受影响。
     */
    isUrlUnusable(): boolean {
        if (this.base64) return false;
        if (this.urlBroken) return true;
        if (this.type !== 'url') return false;
        return this.isBase64RetryBlocked() && Image.isTemporaryUrl(this.url);
    }

    /** 模型侧报告无法下载这些 URL 时调用：只处理非图床 URL（图床走 markModelDownloadFailures 探测） */
    static markUrlBrokenByUrls(urls: string[]): number {
        const targets = new Set((urls || []).filter(u => u && !u.startsWith('data:')));
        if (targets.size === 0) return 0;
        let marked = 0;
        for (const img of Object.values(this.imageMap)) {
            if (!img || img.base64 || img.urlBroken) continue;
            if (img.hostedId) continue;   // 图床图不能凭模型报错就永久标坏
            const candidate = img.remoteUrl || img.url;
            if (!candidate || !targets.has(candidate)) continue;
            img.urlBroken = true;
            this.save(img);
            marked++;
        }
        return marked;
    }

    /**
     * 模型报“无法下载图片”时：图床 URL 先探测 404/可达性。
     * - 图床返回 200：图片存在，标记本轮改用内联 b64（不标坏），返回 retryInline=true；
     * - 404：真正已删，标 urlBroken；
     * - 网络错误/不可达：不标坏，留待下轮。
     * 非图床 URL 仍按旧规则标坏。
     */
    static async markModelDownloadFailures(urls: string[]): Promise<{ marked: number; retryInline: boolean }> {
        const targets = new Set((urls || []).filter(u => u && !u.startsWith('data:')));
        if (targets.size === 0) return { marked: 0, retryInline: false };
        let marked = 0;
        let retryInline = false;
        const hostedImages: Image[] = [];
        for (const img of Object.values(this.imageMap)) {
            if (!img || img.base64 || img.urlBroken) continue;
            const candidate = img.remoteUrl || img.url;
            if (!candidate || !targets.has(candidate)) continue;
            if (img.hostedId) hostedImages.push(img);
            else {
                img.urlBroken = true;
                this.save(img);
                marked++;
            }
        }
        for (const entry of this.hostedRefs.values()) {
            const img = entry.img;
            if (!img || img.base64 || img.urlBroken) continue;
            const candidate = img.remoteUrl || img.url;
            if (candidate && targets.has(candidate)) hostedImages.push(img);
        }
        for (const img of hostedImages) {
            if (!img.hostedId) continue;
            const data = await ImageHost.fetchBase64(img.hostedId);
            if (data) {
                // 图片还在：本轮改用内联 b64 重发，不标 urlBroken（之后修好 publicUrl 仍可恢复 URL）
                this.preferInlineForModel(img.imageId);
                img.base64 = data.base64;
                img.format = data.format || img.format || 'png';
                img.urlBroken = false;
                retryInline = true;
            } else if (ImageHost.lastStatus === 404) {
                // 图床已彻底删除：与 GC 对账一致，清掉 hosted 字段，发送时不再指向死链
                img.urlBroken = true;
                img.hostedId = '';
                img.hostedUrl = '';
                img.hostedAt = 0;
                img.base64 = '';
                this.save(img);
                marked++;
            }
            // 其它错误（网络/5xx/超时）：不标坏，下一轮再试
        }
        return { marked, retryInline };
    }

    /**
     * 转换失败是否属于「该 URL 已不可用」的永久性失败：后端会把上游下载被 4xx 拒绝的原因写进错误正文
     * （如 "400 Client Error: Bad Request for url: ..."、QQ 的 download url has expired），重试没有意义；
     * 429 限速与 5xx 仍按可重试处理。
     */
    private isPermanentUrlError(text: string): boolean {
        if (/url has expired|retcode["'\s:]*-\s*5503007/i.test(text)) return true;
        const m = text.match(/\b(4\d{2})\s+Client Error\b/i);
        if (m && m[1] !== '429') return true;
        // 图床等后端返回结构化错误：{"error":"fetch_failed","upstream_status":400,...}
        const status = text.match(/upstream_status["'\s:]+(4\d{2})/i);
        return !!status && status[1] !== '429';
    }

    /**
     * 获取图片的 base64：URL 图片转 base64 供模型读取。
     * 失败后进入 1 小时冷却期，连续失败达上限后永久放弃；同一实例并发调用共享同一次请求。
     */
    async urlToBase64() {
        if (this.type !== 'url') return;
        if (this.isBase64RetryBlocked()) return;

        const pending = pendingUrlToBase64.get(this);
        if (pending) return pending;

        const task = (async () => {
            try {
                await this.doUrlToBase64();
            } finally {
                pendingUrlToBase64.delete(this);
            }
        })();
        pendingUrlToBase64.set(this, task);
        return task;
    }

    private async doUrlToBase64() {
        // 配了图床就只走图床：入库 → 取 b64 出口；失败按现有冷却/永久放弃规则降级，不回退 i2b64
        if (ImageHost.enabled) {
            await this.doUrlToBase64ViaHost();
            return;
        }
        const { IMAGE_TO_BASE64: imageTobase64Url, IMAGE_TO_BASE64_TOKEN: imageTobase64Token } = Config.backend;
        try {
            const response = await fetch(`${imageTobase64Url}/image-to-base64`, {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    ...backendAuthHeaders(imageTobase64Token),
                },
                body: JSON.stringify({ url: this.src })
            });

            const text = await response.text();
            if (!response.ok) throw new Error(`请求失败! 状态码: ${response.status}${backendStatusHint(response.status, 'image-url-to-base64')}\n响应体: ${text}`);
            if (!text) throw new Error("响应体为空");

            try {
                const data = JSON.parse(text);
                if (data.error) throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                if (!data.base64 || !data.format) throw new Error(`响应体中缺少base64或format字段`);
                this.base64 = data.base64;
                this.format = data.format;
                this.base64Failed = false;
                this.base64FailedAt = 0;
                this.base64FailedCount = 0;
                this.urlBroken = false;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (error) {
            this.markBase64Failure(error);
        }

        Image.save(this);
    }

    /** 配了图床时的转换路径：先确保入库，再从 b64 出口取字节 */
    private async doUrlToBase64ViaHost() {
        try {
            if (!this.hostedId) {
                if (!this.url || !/^https?:/i.test(this.url)) throw new Error('该图片没有可上传的 URL');
                const item = await ImageHost.uploadByUrl(this.url, this.imageId, this.sourceInfo(), this.autoTypeTags());
                if (!item) throw new Error('上传图床失败' + (ImageHost.lastError ? `：${ImageHost.lastError}` : ''));
                this.applyHostItem(item);
            }
            const data = await ImageHost.fetchBase64(this.hostedId);
            if (!data) throw new Error('图床 b64 出口失败' + (ImageHost.lastError ? `：${ImageHost.lastError}` : ''));
            this.base64 = data.base64;
            this.format = data.format || this.format || 'png';
            this.base64Failed = false;
            this.base64FailedAt = 0;
            this.base64FailedCount = 0;
            this.urlBroken = false;
        } catch (error) {
            this.markBase64Failure(error);
        }
        Image.save(this);
    }

    /** 统一处理转换失败：永久性失败直接放弃，其余计数 + 冷却 */
    private markBase64Failure(error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const permanent = this.isPermanentUrlError(message);
        // 永久性失败直接按「连续失败达上限」处理：不再按冷却期重试，且不再作为 image_url 交给模型
        this.base64FailedCount = permanent ? IMAGE_BASE64_RETRY_MAX : this.base64FailedCount + 1;
        this.base64Failed = true;
        this.base64FailedAt = Date.now();
        if (permanent) {
            this.urlBroken = true;
            const snippet = message.length > 120 ? message.slice(0, 120) + '…' : message;
            log.warning('图片' + this.imageId + '的URL已确认不可用（' + snippet + '），不再重试转换，发送给模型时降级为文本标签');
        } else if (this.base64FailedCount >= IMAGE_BASE64_RETRY_MAX) {
            log.warning('图片' + this.imageId + '连续' + this.base64FailedCount + '次转base64失败，已永久放弃该图片的转换重试');
        }
        log.exception('在imageUrlToBase64中请求出错', error);
    }

    /** 把图床返回的条目写进字段（同时清掉 base64：图床已有字节） */
    private applyHostItem(item: HostItem) {
        this.hostedId = item.id;
        this.hostedUrl = item.url;
        this.hostedAt = Date.now();
        this.base64 = '';
    }

    private sourceInfo(): ImageSource {
        const info: ImageSource = {};
        if (this.sourceMeta) {
            try {
                const meta = JSON.parse(this.sourceMeta);
                if (meta && typeof meta === 'object') Object.assign(info, meta);
            } catch (_e) { /* 旧数据/坏数据：忽略 */ }
        }
        if (this.url) info.raw_url = this.url;
        if (this.sourceSessionId) info.session_id = this.sourceSessionId;
        if (!info.at) info.at = Date.now();
        return info;
    }

    /** 拿到图片字节（base64）：有图床优先走图床，失败返回空串；成功时 base64 只在内存，不落盘 */
    async ensureBytes(): Promise<string> {
        if (this.base64) return this.base64;
        // 头像走公开地址即可，不进图床也不转 base64
        if (this.isAvatarImage) return '';
        if (ImageHost.enabled || this.type === 'url') await this.urlToBase64();
        return this.base64;
    }

    /**
     * 模型/上游取图地址：URL 或 data URL。
     * - 图床：模型可达则给 remoteUrl；内网/云模型或本轮已被模型报下载失败则走 b64 出口；
     * - 非图床 URL：优先转 b64（与旧行为一致），失败再回退稳定原始 URL；
     * - 头像：公开 qlogo URL。
     */
    async getModelSrc(model?: { baseUrl?: string }): Promise<string> {
        if (this.base64) return this.base64Url;
        if (this.urlBroken) return '';
        if (this.isAvatarImage) return this.url || '';
        if (this.hostedId && ImageHost.enabled) {
            if (!this.urlBroken && !Image.inlineModelIds.has(this.imageId)) {
                const url = ImageHost.urlForModel(this.hostedId, model?.baseUrl);
                if (url) return url;
            }
            const data = await ImageHost.fetchBase64(this.hostedId);
            if (data) {
                this.base64 = data.base64;
                this.format = data.format || this.format || 'png';
                this.urlBroken = false;
                return this.base64Url;
            }
            if (ImageHost.lastStatus === 404) this.urlBroken = true;
            // 图床取不到时，最后回退稳定原始 URL（QQ 临时直链不赌）
            if (this.url && !Image.isTemporaryUrl(this.url) && !this.urlBroken) return this.url;
            return '';
        }
        if (this.type === 'url' && this.url && !this.isBase64RetryBlocked()) {
            await this.urlToBase64();
        }
        if (this.base64) return this.base64Url;
        if (this.url && !Image.isTemporaryUrl(this.url)) return this.url;
        return '';
    }

    /** 工具产出图片的自动类型标签（确定性映射，不调模型） */
    private autoTypeTags(): string[] {
        const { AUTO_TYPE_TAGS, AUTO_TYPE_TAG_MAX } = Config.image;
        if (!AUTO_TYPE_TAGS) return [];
        const tool = String(this.sourceInfo().tool || '').toLowerCase();
        const server = String(this.sourceInfo().server || '').toLowerCase();
        let tags: string[] = [];
        if (tool === 'text_to_image' || tool === 'image-generation') tags = ['ai-generated'];
        else if (tool === 'meme_generator' || tool === 'meme') tags = ['meme'];
        else if (tool === 'mcp' || server) tags = ['mcp-image'];
        else if (tool) tags = ['tool-image'];
        const max = Math.max(1, Math.min(4, Number(AUTO_TYPE_TAG_MAX) || 2));
        return Array.from(new Set(tags)).slice(0, max);
    }

    /** 把手里已有的 base64 转存图床；成功返回 true（base64 被清空，字节由图床保存） */
    async adoptBase64ToHost(): Promise<boolean> {
        if (!ImageHost.enabled || !this.base64) return false;
        const item = await ImageHost.uploadBase64(this.base64, this.format, this.imageId, this.sourceInfo(), this.autoTypeTags());
        if (!item) return false;
        this.applyHostItem(item);
        return true;
    }

    /** 图床有字节后，内存里的 base64 可以丢掉（落盘时也会被剥离） */
    dropBase64IfHosted(): void {
        if (this.hostedId && this.base64) this.base64 = '';
    }

    /** 图片创建后的异步入库（不阻塞消息处理） */
    static async captureToHost(img: Image): Promise<boolean> {
        if (!ImageHost.enabled || !img || img.hostedId) return false;
        if (!img.url || !/^https?:\/\//i.test(img.url)) return false;
        const item = await ImageHost.uploadByUrl(img.url, img.imageId, img.sourceInfo(), img.autoTypeTags());
        if (!item) return false;
        img.applyHostItem(item);
        Image.save(img);
        return true;
    }

    async imageToText(prompt = '') {
        const { URL_TO_BASE64 } = Config.image;
        const defaultPrompt = IMAGE_PROMPT_TEMPLATE({});

        const model = Model.getMultimodalModel('image-understanding');
        if (!model) {
            log.error(`未找到支持image-understanding的模型`);
            return;
        }

        // URL 已确认不可用（QQ 直链过期等）：识图模型同样下载不到，不再白花一次请求
        if (this.urlBroken) {
            log.warning(`图片${this.imageId}的URL已确认不可用，跳过识图`);
            Image.save(this);
            return;
        }

        // 图床/头像：交给 getModelSrc 统一选择 URL 或 b64（模型可达性判断）
        // 非图床 URL：保持旧行为（“总是”先转 b64；配了图床时先入库再取 b64）
        let src = '';
        if (this.hosted || this.isAvatarImage) {
            src = await this.getModelSrc(model);
        } else {
            if (URL_TO_BASE64 == '总是' && this.type === 'url' && !this.isBase64RetryBlocked()) await this.urlToBase64();
            if (ImageHost.enabled && this.type === 'url' && !this.base64) await this.urlToBase64();
            // 取不到 b64 时保留旧行为：把原始/稳定 URL 交给识图模型（图床失败不阻断识图）
            src = this.base64 ? this.base64Url : this.src;
        }
        if (!src) {
            log.warning(`图片${this.imageId}取不到可用的识图地址（图床不可达/图片已删），跳过识图`);
            Image.save(this);
            return;
        }

        this.description = this.truncateIfLong(await model.callITT(src, prompt ? prompt : defaultPrompt));

        // 图床：首次给了 URL 但模型没识别出来 → 用 b64 再试一次（不依赖“自动”配置；宁可多一次本地请求）
        if (!this.description && this.hosted && this.hostedId) {
            const data = await ImageHost.fetchBase64(this.hostedId);
            if (data) {
                this.base64 = data.base64;
                this.format = data.format || this.format || 'png';
                this.description = this.truncateIfLong(await model.callITT(this.base64Url, prompt ? prompt : defaultPrompt));
            }
        }

        if (!this.description && URL_TO_BASE64 === '自动' && this.type === 'url' && !this.isBase64RetryBlocked()) {
            log.info(`图片${this.imageId}第一次识别失败，自动尝试使用转换为base64`);
            await this.urlToBase64();
            if (this.base64) {
                this.description = this.truncateIfLong(await model.callITT(this.base64Url, prompt ? prompt : defaultPrompt));
            }
        }

        if (!this.description) log.error(`图片${this.imageId}识别失败`);
        else Image.save(this); // 持久化 description/rawDescription（含截断时保留的完整识别原文）
    }

    /** 图片转文字结果超长时不再交给压缩智能体，改为只展示开头 N 字并把完整原文存入 rawDescription；未超阈值时展示即原文 */
    private truncateIfLong(text: string): string {
        const { IMAGE_TEXT_TRUNCATE_CHARS } = Config.image;
        if (!text) return text;
        if (IMAGE_TEXT_TRUNCATE_CHARS > 0 && text.length > IMAGE_TEXT_TRUNCATE_CHARS) {
            this.rawDescription = text;
            return text.slice(0, IMAGE_TEXT_TRUNCATE_CHARS);
        }
        return text;
    }


    static imageMap: { [key: string]: Image } = {};

    // ---- CIR 虚拟图注册表：图床 sha256 → 内存 Image（不落 storage / 索引） ----
    private static readonly HOSTED_REF_MAX = 256;
    private static readonly HOSTED_REF_TTL = 60 * 60 * 1000;
    private static hostedRefs = new Map<string, { img: Image; at: number }>();
    /** 本轮模型取图失败、要求改用内联 b64 的图片（imageId） */
    private static inlineModelIds = new Set<string>();

    static resetHostedRefsForTest(): void {
        this.hostedRefs.clear();
        this.inlineModelIds.clear();
    }

    static hostedRefCountForTest(): number {
        return this.hostedRefs.size;
    }

    private static trimHostedRefs(): void {
        const now = Date.now();
        for (const [id, entry] of this.hostedRefs) {
            if (now - entry.at > this.HOSTED_REF_TTL) this.hostedRefs.delete(id);
        }
        while (this.hostedRefs.size > this.HOSTED_REF_MAX) {
            let oldestKey = '';
            let oldestAt = Number.MAX_SAFE_INTEGER;
            for (const [id, entry] of this.hostedRefs) {
                if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = id; }
            }
            if (!oldestKey) break;
            this.hostedRefs.delete(oldestKey);
        }
    }

    /** 标记该图本轮改用内联 b64（模型 URL 取图失败时使用） */
    static preferInlineForModel(imageId: string): void {
        if (imageId) this.inlineModelIds.add(imageId);
    }

    static resetInlineModelForTest(): void {
        this.inlineModelIds.clear();
    }


    static generateImageId(): string {
        let id = generateId(), a = 0;
        while (this.get(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                log.error(`生成图片id失败，已尝试1000次，放弃`);
                throw new Error(`生成图片id失败，已尝试1000次，放弃`);
            }
        }
        return id;
    }

    static createUrlImage(sourceSessionId: string, url: string, imageId?: string, source?: ImageSource): Image {
        imageId = imageId || this.generateImageId();
        const img = new Image();
        img.imageId = imageId;
        img.sourceSessionId = sourceSessionId;
        // QQ 官方 bot 的图片 URL 常被 HTML 转义成 &amp;，直接请求会 400
        img.url = decodeUrlHtmlEntities(url);
        img.lastUsedAt = Date.now();
        if (source) {
            try { img.sourceMeta = JSON.stringify(source); } catch (_e) { img.sourceMeta = ''; }
        }
        this.imageMap[imageId] = img;
        this.save(img);
        // 配了图床：异步入库，不阻塞消息处理（失败不影响原链路）
        if (ImageHost.enabled) void this.captureToHost(img);
        return img;
    }

    static createLocalImage(imageId: string, path: string): Image {
        const img = new Image();
        img.imageId = imageId;
        img.path = resolveLocalPath(path);
        this.imageMap[imageId] = img;
        return img;
    }

    /**
     * 图床已入库的 id（MCP image_search 返回的 sha256）→ 虚拟 Image：
     * 不落 storage、不重复上传，发送时直接用图床稳定地址（[img:h<sha>] 可用）。
     * 虚拟图进内存 LRU，重复引用复用同一实例。
     */
    static fromHostedId(hostedId: string): Image | null {
        const id = String(hostedId || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(id) || !ImageHost.enabled) return null;
        const now = Date.now();
        const hit = this.hostedRefs.get(id);
        if (hit) {
            hit.at = now;
            return hit.img;
        }
        const img = new Image();
        img.imageId = `h${id}`;
        img.hostedId = id;
        img.hostedUrl = `/i/${id}`;
        img.lastUsedAt = now;
        img.virtualHosted = true;
        this.hostedRefs.set(id, { img, at: now });
        this.trimHostedRefs();
        return img;
    }

    /**
     * CIR v1 统一解析入口：接受 [img:<ref>]、裸 ref、/:描述、/i/<sha>、头像别名。
     * 所有“从标签/id 找图片”的路径都应走这里，不再各自 Image.get(id.split(':')[0])。
     */
    static resolveRef(raw: unknown): Image | null {
        const parsed = parseImageRef(raw);
        if (!parsed) return null;
        if (parsed.kind === 'hosted') return this.fromHostedId(parsed.id);
        if (parsed.kind === 'user_avatar') return this.getUserAvatar(parsed.id);
        if (parsed.kind === 'group_avatar') return this.getGroupAvatar(parsed.id);
        const img = this.get(parsed.id);
        if (img) return img;
        // 兼容旧行为：整体找不到时取首个冒号前（如 [img:id:描述] 的 id 已由 parse 处理）
        if (parsed.id.includes(':')) return this.get(parsed.id.split(':')[0]);
        return null;
    }

    /** 把工具输出里的图床引用改写为 [img:h<sha>] 并注册虚拟图；其它标签原样保留 */
    static normalizeToolText(text: string): string {
        // 图床未配置时不做翻译：避免把 [img:sha] 变成无法解析的 h 引用
        if (!ImageHost.enabled) return text;
        return rewriteHostedImageRefs(text, sha => { this.fromHostedId(sha); }).text;
    }

    /** 把 Image 转成 OpenAI 兼容的 image_url 内容块；取不到返回 null */
    static async toModelPart(
        image: Image,
        model?: { baseUrl?: string },
    ): Promise<{ type: 'image_url'; image_url: { url: string } } | null> {
        const src = await image.getModelSrc(model);
        return src ? { type: 'image_url', image_url: { url: src } } : null;
    }

    static get(imageId: string): Image | null {
        if (!Object.prototype.hasOwnProperty.call(this.imageMap, imageId)) {
            let img = new Image();
            try {
                const text = getHost().storage.get(`image_${imageId}`);
                if (!text) return null;
                const data = JSON.parse(text || '{}');
                img = revive(Image, data);
                // 旧存量图片可能带着 &amp; URL，加载时顺手治愈
                img.url = decodeUrlHtmlEntities(img.url);
            } catch (error) {
                log.exception(`加载图片${imageId}失败`, error);
                return null;
            }
            this.imageMap[imageId] = img;
        }
        const img = this.imageMap[imageId];
        // 「用过」才更新清理计时：内存里刷新，最多每小时落盘一次，避免每次渲染都写 storage
        const now = Date.now();
        if (img && now - (img.lastUsedAt || 0) >= IMAGE_LAST_USED_TOUCH_TTL) {
            img.lastUsedAt = now;
            this.save(img);
        }
        return img || null;
    }
    static save(img: Image) {
        // 图床虚拟引用：只存在内存，不落 storage、不进索引
        if (img.virtualHosted) return;
        // 索引：清理任务靠它枚举图片（海豹 storage 没有遍历能力）
        if (img.imageId) {
            if (!img.lastUsedAt) img.lastUsedAt = Date.now();
            ImageIndex.touch(img.imageId, img.lastUsedAt, img.hostedId);
        }
        // 有图床时不再持久化 base64（内存里可留一份给本轮请求用）：字节在图床，模型按需从 b64 出口取
        if (ImageHost.enabled && img.hostedId) {
            getHost().storage.set(`image_${img.imageId}`, JSON.stringify({ ...img, base64: '' }));
            return;
        }
        getHost().storage.set(`image_${img.imageId}`, JSON.stringify(img));
    }

    static getUserAvatar(uid: string): Image {
        const img = new Image();
        img.imageId = `user_avatar:${uid}`;
        const rawId = uid.replace(/^.+:/, '');
        // qlogo 仅 QQ 平台可用；其它平台返回空 URL，由发送路径跳过头像
        img.url = getPlatform(uid) === 'QQ' ? `https://q1.qlogo.cn/g?b=qq&nk=${rawId}&s=640` : '';
        return img;
    }

    static getGroupAvatar(gid: string): Image {
        const img = new Image();
        img.imageId = `group_avatar:${gid}`;
        const rawId = gid.replace(/^.+:/, '');
        img.url = getPlatform(gid) === 'QQ' ? `https://p.qlogo.cn/gh/${rawId}/${rawId}/640` : '';
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
    static async handleImageMessageSegment(ctx: seal.MsgContext, seg: MessageSegment, messageId = ''): Promise<{ content: string, images: Image[] }> {
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

            const sid = getSessionId(ctx);
            const source: ImageSource = {
                platform: getPlatform(sid),
                group_id: ctx.group ? String(ctx.group.groupId) : '',
                user_id: ctx.player ? String(ctx.player.userId) : '',
                message_id: messageId,
                at: Date.now(),
            };
            for (const key of Object.keys(source) as Array<keyof ImageSource>) {
                if (!source[key]) delete source[key];   // 空字段不占地方
            }
            const image = this.createUrlImage(sid, file, undefined, source);
            // 保留接收到的原始段字段（file/file_unique/md5/subType/url 等），供 resolve_special_id 查询
            try {
                image.raw = JSON.stringify(seg.data || {});
            } catch (_e) {
                image.raw = '';
            }
            const { IMAGE_CONDITION } = Config.image;
            const fmtCondition = parseInt(seal.format(ctx, `{${IMAGE_CONDITION}}`));
            if (fmtCondition === 1) await image.imageToText();
            Image.save(image); // 持久化原始字段

            content += image.description ? `[img:${image.imageId}:${image.description}]` : `[img:${image.imageId}]`;
            // 展示描述被截断时（rawDescription 存在且长于展示），在 [img] 标签外追加指针标记，
            // 让纯文本/多模态模型都能看到 image_id 并可 read_raw kind=image 翻完整识别原文
            if (image.rawDescription && image.description && image.rawDescription.length > image.description.length) {
                content += buildImageTruncateMarker(image.rawDescription.length, image.description.length, image.imageId);
            }
            images.push(image);
        } catch (error) {
            log.exception('在handleImageMessage中处理图片时出错', error);
        }

        return { content, images };
    }

}
