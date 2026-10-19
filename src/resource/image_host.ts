// 图床客户端：把图片字节存到 aiplugin4-backends 的 image-host，换取稳定地址与 base64 出口。
//
// 约定（后端 1.0.5+）：
//   - 接口返回的 url 一律是相对路径（/i/<id>、/i/<id>/b64），对外绝对地址由插件拼
//   - 配置两个地址：`url` 是插件访问图床接口的地址（可为 127.0.0.1）；
//     `publicUrl` 是给协议端（NapCat）与模型用的对外地址，必须是 **IP 或域名**，由启动器
//     「复制后端配置」的「图床对外地址」自动生成（留空自动探测本机 IP）。
//     只有 publicUrl 为空且 url 回环时才降级：发图用本地文件、模型用内联 base64。
//   - 上传/取字节都要 Token（后端卡片里的 Token）；/i/* 本身公开，但带上更省心
//   - goja 的 fetch 只能读文本，所以所有响应都按 JSON 处理
import Config from "../config/config";
import { logger } from "../logger";
import { backendAuthHeaders } from "../utils/backend";
import { isLoopbackUrl } from "../utils/url";

export { isLoopbackUrl };

const log = logger.withTag('image-host');

/** 图床请求超时：上传要下载远端图 + 落盘，比普通 JSON 接口慢，给 20s */
const UPLOAD_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 10_000;

/** 来源信息：图片从哪条消息/哪个群/谁那里来的（用于图床画廊展示来源） */
export interface ImageSource {
    platform?: string;
    group_id?: string;
    user_id?: string;
    message_id?: string;
    session_id?: string;
    at?: number;
    raw_url?: string;
}

export interface HostItem {
    /** 图床 id（sha256） */
    id: string;
    /** 相对路径，如 /i/<id> */
    url: string;
    /** 相对路径，如 /i/<id>/b64 */
    b64Url: string;
    /** true = 哈希命中已有字节，只追加了 ref */
    dedup: boolean;
}

function normalizeBase(raw: string): string {
    const base = String(raw || '').trim().replace(/\/+$/, '');
    return base;
}

/** 带超时的 Promise：settle 后清掉定时器（goja 里 setTimeout 也是数字 id） */
function withDeadline<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`请求超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        fn().then(
            value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer as any);
                resolve(value);
            },
            error => {
                if (settled) return;
                settled = true;
                clearTimeout(timer as any);
                reject(error);
            }
        );
    });
}

function pickItem(data: any): HostItem | null {
    if (!data || typeof data !== 'object') return null;
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) return null;
    return {
        id,
        url: typeof data.url === 'string' && data.url ? data.url : `/i/${id}`,
        b64Url: typeof data.b64_url === 'string' && data.b64_url ? data.b64_url : `/i/${id}/b64`,
        dedup: !!data.dedup,
    };
}

class _ImageHost {
    /** 最近一次请求失败原因（供上层区分永久性 4xx 与普通失败） */
    static lastError = '';
    /** 上传并发上限：合并转发几十张图时不要一次打爆后端 */
    private static readonly MAX_UPLOAD_CONCURRENCY = 4;
    private static activeUploads = 0;
    private static uploadWaiters: Array<() => void> = [];

    private static async acquireUploadSlot(): Promise<void> {
        if (this.activeUploads < this.MAX_UPLOAD_CONCURRENCY) {
            this.activeUploads++;
            return;
        }
        await new Promise<void>((resolve) => this.uploadWaiters.push(resolve));
        this.activeUploads++;
    }

    private static releaseUploadSlot(): void {
        this.activeUploads = Math.max(0, this.activeUploads - 1);
        const next = this.uploadWaiters.shift();
        if (next) next();
    }

    /** 测试用：清空并发计数（不影响生产） */
    static resetUploadSlotsForTest(): void {
        this.activeUploads = 0;
        this.uploadWaiters = [];
    }

    /** 配置的图床地址（插件请求图床接口用；去掉尾部 /）；空 = 未启用 */
    static get base(): string {
        return normalizeBase(Config.backend.IMAGE_HOST);
    }

    static get enabled(): boolean {
        return !!this.base;
    }

    /** 配置的图床地址是否为回环：回环只有插件自己可达，对外（协议端/模型）一律不能用 */
    static get isLoopback(): boolean {
        return isLoopbackUrl(this.base);
    }

    /**
     * 对外地址（协议端发图 / 模型取图用）：
     *   1. 配了 image-host.publicUrl → 用它（必须是协议端与模型都能访问的 IP/域名）；
     *   2. 否则 url 本身不是回环 → 用 url；
     *   3. 否则空（回环且没配 publicUrl = 对外不可用，发送/模型侧自动降级）。
     */
    static get externalBase(): string {
        const pub = normalizeBase(Config.backend.IMAGE_HOST_PUBLIC_URL || '');
        if (pub && !isLoopbackUrl(pub)) return pub;
        return this.isLoopback ? '' : this.base;
    }

    /** 对外地址是否可用（不可用时发送走本地文件、模型走内联字节） */
    static get externalEnabled(): boolean {
        return !!this.externalBase;
    }

    /** 相对路径 → 对外绝对地址（对外不可用时返回空串） */
    static externalUrl(path: string): string {
        const p = String(path || '');
        const base = this.externalBase;
        if (!p || !base) return '';
        if (/^https?:\/\//i.test(p)) return p;
        return base + (p.startsWith('/') ? p : `/${p}`);
    }

    /** 内部相对路径 → 绝对地址（插件请求图床接口用；已经是 http(s) 的原样返回） */
    static absolute(path: string): string {
        const p = String(path || '');
        if (!p) return '';
        if (/^https?:\/\//i.test(p)) return p;
        return this.base + (p.startsWith('/') ? p : `/${p}`);
    }

    /** 当前配置对应的 b64 出口绝对地址（hostedId 为空返回空串） */
    static b64Url(hostedId: string): string {
        return hostedId ? this.absolute(`/i/${hostedId}/b64`) : '';
    }

    private static headers(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...backendAuthHeaders(Config.backend.IMAGE_HOST_TOKEN),
        };
    }

    private static async requestJson(path: string, init: any, timeoutMs: number, tag: string): Promise<any | null> {
        const url = this.absolute(path);
        try {
            const response = await withDeadline(() => fetch(url, init), timeoutMs);
            const text = await response.text();
            if (!response.ok) {
                const snippet = text.length > 160 ? `${text.slice(0, 160)}…` : text;
                this.lastError = `HTTP ${response.status} ${snippet}`;
                log.warning(`${tag}失败：HTTP ${response.status} ${snippet}`);
                return null;
            }
            this.lastError = '';
            if (!text) return null;
            return JSON.parse(text);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = message;
            log.warning(`${tag}请求出错：${message}`);
            return null;
        }
    }

    /** 探测图床是否可用（/api/health 公开） */
    static async probe(): Promise<boolean> {
        if (!this.enabled) return false;
        const data = await this.requestJson('/api/health', { method: 'GET' }, READ_TIMEOUT_MS, '探测图床');
        const ok = !!(data && data.ok);
        if (ok && !this.externalEnabled) {
            log.warning(`图床未配置对外地址（后端配置 image-host.publicUrl），且 url 是回环地址（${this.base}）：`
                + `QQ 协议端与模型都访问不到该地址。请在后端 WebUI 点「复制后端配置」时填写「图床对外地址」`
                + `（IP 或域名，如 192.168.1.10），或手动给 image-host 加 "publicUrl": "http://<IP或域名>:46680"。`
                + `当前会降级：发图用本地文件、模型用内联 base64。`);
        }
        return ok;
    }

    /** 按 URL 抓取入库 */
    static async uploadByUrl(url: string, ref: string, source?: ImageSource): Promise<HostItem | null> {
        if (!this.enabled || !url) return null;
        const body: any = { url, ref };
        if (source) body.source = source;
        await this.acquireUploadSlot();
        try {
            const data = await this.requestJson('/api/upload',
                { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
                UPLOAD_TIMEOUT_MS, '上传图床');
            return pickItem(data);
        } finally {
            this.releaseUploadSlot();
        }
    }

    /** 直接上传 base64（生图结果等插件已经拿到字节的场景） */
    static async uploadBase64(base64: string, format: string, ref: string, source?: ImageSource): Promise<HostItem | null> {
        if (!this.enabled || !base64) return null;
        const body: any = { base64, format: format || 'png', ref };
        if (source) body.source = source;
        await this.acquireUploadSlot();
        try {
            const data = await this.requestJson('/api/upload',
                { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
                UPLOAD_TIMEOUT_MS, '上传图床');
            return pickItem(data);
        } finally {
            this.releaseUploadSlot();
        }
    }

    /** 取 b64 出口：返回 { base64, format }，失败返回 null */
    static async fetchBase64(hostedId: string): Promise<{ base64: string; format: string } | null> {
        if (!this.enabled || !hostedId) return null;
        const data = await this.requestJson(`/i/${hostedId}/b64`, { method: 'GET', headers: this.headers() },
            READ_TIMEOUT_MS, '读取图床base64');
        if (!data || typeof data.base64 !== 'string' || !data.base64) return null;
        return { base64: data.base64, format: typeof data.format === 'string' ? data.format : '' };
    }

    /** 释放引用（v1 没有插件侧删除，预留给后续 GC） */
    static async release(refs: string[]): Promise<boolean> {
        const list = (refs || []).filter(Boolean);
        if (!this.enabled || list.length === 0) return false;
        const data = await this.requestJson('/api/release',
            { method: 'POST', headers: this.headers(), body: JSON.stringify({ refs: list }) },
            READ_TIMEOUT_MS, '释放图床引用');
        return !!data;
    }

    /** 拉变更日志（删除/清理事件），用于插件侧清理对账 */
    static async fetchChanges(since: number, limit = 500): Promise<{ cursor: number; reset: boolean; events: any[] } | null> {
        if (!this.enabled) return null;
        const path = `/api/changes?since=${Math.max(0, Math.floor(since))}&limit=${Math.max(1, Math.min(500, limit))}`;
        const data = await this.requestJson(path, { method: 'GET', headers: this.headers() },
            READ_TIMEOUT_MS, '拉取图床变更');
        if (!data || typeof data.cursor !== 'number') return null;
        return {
            cursor: Number(data.cursor) || 0,
            reset: !!data.reset,
            events: Array.isArray(data.events) ? data.events : [],
        };
    }

    /** 对账：返回图床上已不存在的 ref（网络失败返回 null，调用方本轮跳过） */
    static async exists(refs: string[]): Promise<string[] | null> {
        const list = (refs || []).filter(Boolean);
        if (!this.enabled) return null;
        if (!list.length) return [];
        const missing: string[] = [];
        for (let i = 0; i < list.length; i += 500) {
            const part = list.slice(i, i + 500);
            const data = await this.requestJson('/api/exists',
                { method: 'POST', headers: this.headers(), body: JSON.stringify({ refs: part }) },
                READ_TIMEOUT_MS, '图床引用对账');
            if (!data || !Array.isArray(data.missing)) return null;
            for (const ref of data.missing) {
                if (typeof ref === 'string' && ref) missing.push(ref);
            }
        }
        return missing;
    }
}

export const ImageHost = _ImageHost;
export default ImageHost;
