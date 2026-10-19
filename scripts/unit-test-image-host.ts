// 图床接入单元测试（由 scripts/test-unit.cjs 打包后加载运行，不启动 SealDice/QQ）
// @ts-nocheck
import assert from "node:assert/strict";

import Config, { ext } from "../src/config/config";
Config.registerConfig();

import Image from "../src/resource/image";
import { ImageGC } from "../src/resource/image_gc";
import { ImageHost, isLoopbackUrl } from "../src/resource/image_host";
import { ImageIndex } from "../src/resource/image_index";
import { resolveSendMessage } from "../src/transport/ob11/message_segments";
import { textToMultimodalContent } from "../src/utils/message";
import { decodeUrlHtmlEntities } from "../src/utils/string";

const TC = (globalThis as any).__TEST_CONFIG__;
const BACKEND = 'http://test-host:46680';
const I2B64 = 'http://test-i2b64';
// 真后端用例专用：模块加载时记住 Node 原生 fetch。其它用例会临时替换 globalThis.fetch，
// 若某个用例异常退出没还原，真后端用例不能被带崩。
const NODE_FETCH = (globalThis as any).fetch;

interface RecordedCall { url: string; init: any; }

let calls: RecordedCall[] = [];
let stored: Record<string, string> = {};
let routes: Array<{ match: (url: string) => boolean; status?: number; data?: any; text?: string }> = [];

function resetConfigCache(): void {
    (Config as any).cache = {};
}

function useHost(enabled = true, token = 'tok-123', url = BACKEND, publicUrl = ''): void {
    TC.stringConfigs['后端配置'] = JSON.stringify({
        version: 1,
        backends: {
            'image-url-to-base64': { url: I2B64 },
            'image-host': enabled ? { url, token, ...(publicUrl ? { publicUrl } : {}) } : { url: '' },
        },
    });
    resetConfigCache();
}

/** 回环地址 = 协议端/模型都访问不到，对外应降级为本地文件 / base64 */
function useLoopbackHost(): void {
    useHost(true, 'tok-123', 'http://127.0.0.1:46680');
}

function restoreHost(): void {
    delete TC.stringConfigs['后端配置'];
    resetConfigCache();
    calls = [];
    routes = [];
}

function captureStorage(): void {
    stored = {};
    (ext as any).storageSet = (key: string, value: string) => { stored[key] = value; };
    (ext as any).storageGet = (key: string) => stored[key] ?? '';
}

function mockFetch(): void {
    const original = (globalThis as any).fetch;
    (globalThis as any).__origFetch = original;
    (globalThis as any).fetch = async (url: string, init: any) => {
        calls.push({ url: String(url), init: init || {} });
        const route = routes.find(r => r.match(String(url)));
        if (!route) return { ok: false, status: 404, text: async () => '{"error":"not_found"}' };
        const status = route.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => (route.text !== undefined ? route.text : JSON.stringify(route.data ?? {})),
        };
    };
}

function restoreFetch(): void {
    (globalThis as any).fetch = (globalThis as any).__origFetch;
}

function uploadRoute(): { match: (url: string) => boolean; data: any } {
    return {
        match: (url) => url === `${BACKEND}/api/upload`,
        data: { id: 'abc123', url: '/i/abc123', b64_url: '/i/abc123/b64', dedup: false },
    };
}

function b64Route(): { match: (url: string) => boolean; data: any } {
    return {
        match: (url) => url.endsWith('/i/abc123/b64'),
        data: { base64: 'QUJD', format: 'png' },
    };
}

function releaseRoute(): { match: (url: string) => boolean; data: any } {
    return {
        match: (url) => url === `${BACKEND}/api/release`,
        data: { ok: true, released: 1, blobs_freed: 0 },
    };
}

function existsRoute(missing: string[]): { match: (url: string) => boolean; data: any } {
    return {
        match: (url) => url === `${BACKEND}/api/exists`,
        data: { missing },
    };
}

function useGcDays(days: number): void {
    if (days > 0) TC.intConfigs['图片清理天数'] = days;
    else delete TC.intConfigs['图片清理天数'];
    resetConfigCache();
}

function makeStoredImage(imageId: string, lastUsedAt: number, hostedId = '', url = 'https://example.com/a.png'): Image {
    const img = new Image();
    img.imageId = imageId;
    img.url = url;
    img.lastUsedAt = lastUsedAt;
    if (hostedId) {
        img.hostedId = hostedId;
        img.hostedUrl = `/i/${hostedId}`;
        img.hostedAt = lastUsedAt;
    }
    Image.save(img);
    return img;
}

export const tests: Record<string, () => void | Promise<void>> = {
    /** HTML 实体解码：只解 ampersand 族，&notify 不误伤 */
    testDecodeUrlHtmlEntities(): void {
        assert.equal(
            decodeUrlHtmlEntities('https://x/download?appid=1&amp;fileid=2&amp;rkey=3'),
            'https://x/download?appid=1&fileid=2&rkey=3',
        );
        assert.equal(decodeUrlHtmlEntities('https://x/?a=1&#38;b=2'), 'https://x/?a=1&b=2');
        assert.equal(decodeUrlHtmlEntities('https://x/?a=1&#x26;b=2'), 'https://x/?a=1&b=2');
        assert.equal(decodeUrlHtmlEntities('https://x/?a=1&amp;amp;b=2'), 'https://x/?a=1&b=2');
        assert.equal(decodeUrlHtmlEntities('https://x/?notify=1'), 'https://x/?notify=1');
        assert.equal(decodeUrlHtmlEntities('/local/path&amp;x'), '/local/path&amp;x', '非 http(s) 不动');
    },

    /** 建 URL 图片时解码：入库的 Image.url 已是正确地址 */
    testCreateUrlImageDecodesHtmlEntities(): void {
        captureStorage();
        const img = Image.createUrlImage('', 'https://x/download?appid=1&amp;fileid=2');
        try {
            assert.equal(img.url, 'https://x/download?appid=1&fileid=2');
        } finally {
            delete Image.imageMap[img.imageId];
        }
    },

    /** 旧存量图片（storage 里是 &amp;）加载时治愈 */
    testRevivedImageDecodesHtmlEntities(): void {
        captureStorage();
        stored['image_legacy_amp'] = JSON.stringify({
            imageId: 'legacy_amp',
            url: 'https://x/download?appid=1&amp;fileid=2',
        });
        const img = Image.get('legacy_amp');
        try {
            assert.ok(img);
            assert.equal(img!.url, 'https://x/download?appid=1&fileid=2');
        } finally {
            delete Image.imageMap['legacy_amp'];
        }
    },

    /** 图床按 URL 上传时使用解码后的地址 */
    async testUploadUsesDecodedUrl(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        routes = [uploadRoute(), b64Route()];
        const img = Image.createUrlImage('', 'https://up.example/download?appid=1&amp;fileid=2');
        try {
            await img.urlToBase64();
            const upload = calls.find(c => c.url === `${BACKEND}/api/upload`);
            assert.ok(upload, '应调用图床上传');
            const body = JSON.parse(upload!.init.body);
            assert.equal(body.url, 'https://up.example/download?appid=1&fileid=2');
        } finally {
            delete Image.imageMap[img.imageId];
            restoreFetch();
            restoreHost();
        }
    },

    /** 图床返回 upstream_status:400 → 判永久失败，不再重试 */
    async testHostUpstream4xxMarksPermanent(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        routes = [{
            match: (url: string) => url === `${BACKEND}/api/upload`,
            status: 400,
            text: '{"error":"fetch_failed","upstream_status":400}',
        }];
        const img = Image.createUrlImage('', 'https://up.example/expired.png');
        try {
            await img.urlToBase64();
            assert.equal(img.isUrlUnusable(), true, '上游 4xx 应标记 URL 不可用');
            assert.ok(img.base64FailedCount >= 3, '应直接按连续失败上限处理');
        } finally {
            delete Image.imageMap[img.imageId];
            restoreFetch();
            restoreHost();
        }
    },

    /** MCP image_search 的图床 sha256 id 可直接写 [img:ID] 发送 */
    async testHostedIdCanBeSentAsImgTag(): Promise<void> {
        useHost();
        const id = 'a'.repeat(64);
        try {
            const img = Image.fromHostedId(id);
            assert.ok(img, '图床 id 应能转成虚拟 Image');
            assert.equal(img!.type, 'url');
            assert.equal(img!.remoteUrl, `${BACKEND}/i/${id}`);

            const segs = await resolveSendMessage(
                {} as any,
                { context: { findImage: async (_ctx: any, x: string) => (x === id ? img : null) } } as any,
                `[img:${id}]`,
            );
            assert.ok(Array.isArray(segs), '应解析成消息段数组');
            const imageSeg = (segs as any[]).find((s) => s.type === 'image');
            assert.ok(imageSeg, '应生成 image 段');
            assert.equal(imageSeg.data.file, `${BACKEND}/i/${id}`, '发送时应使用图床稳定地址');
        } finally {
            delete Image.imageMap[id];
            restoreHost();
        }
    },

    /** 未启用图床时，图床 id 不应被当成可发送图片 */
    testHostedIdRequiresImageHost(): void {
        restoreHost();
        assert.equal(Image.fromHostedId('b'.repeat(64)), null);
    },

    /** 未配置图床：ImageHost 关闭，绝对地址原样返回 */
    testImageHostDisabledByDefault(): void {
        restoreHost();
        assert.equal(ImageHost.enabled, false, '未配置时不应启用');
        assert.equal(ImageHost.absolute('/i/x'), '/i/x');
        restoreHost();
    },

    /** 按 URL 上传：带 ref/source/Authorization，解析 id 与相对路径 */
    async testImageHostUploadByUrl(): Promise<void> {
        useHost();
        mockFetch();
        routes = [uploadRoute()];
        try {
            const item = await ImageHost.uploadByUrl('https://example.com/a.png', 'img_1', { session_id: 'g1', raw_url: 'https://example.com/a.png' });
            assert.ok(item, '上传应成功');
            assert.equal(item!.id, 'abc123');
            assert.equal(item!.url, '/i/abc123');
            assert.equal(item!.b64Url, '/i/abc123/b64');
            assert.equal(calls.length, 1, '只应发一次请求');
            assert.equal(calls[0].url, `${BACKEND}/api/upload`);
            assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
            const body = JSON.parse(calls[0].init.body);
            assert.equal(body.url, 'https://example.com/a.png');
            assert.equal(body.ref, 'img_1');
            assert.equal(body.source.session_id, 'g1');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 图床报错：返回 null 且不抛异常（主链路不能被图床拽崩） */
    async testImageHostUploadFailureIsSoft(): Promise<void> {
        useHost();
        mockFetch();
        routes = [{ match: (url) => url === `${BACKEND}/api/upload`, status: 500, data: { error: 'boom' } }];
        try {
            const item = await ImageHost.uploadByUrl('https://example.com/a.png', 'img_1');
            assert.equal(item, null);
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 入库成功后：CQCode 用图床绝对地址，src 同一地址，不落 base64 */
    async testCapturedImageUsesHostedUrl(): Promise<void> {
        useHost();
        mockFetch();
        routes = [uploadRoute()];
        try {
            const img = new Image();
            img.imageId = 'img_capture';
            img.url = 'https://example.com/a.png';
            const ok = await Image.captureToHost(img);
            assert.equal(ok, true);
            assert.equal(img.hostedId, 'abc123');
            assert.equal(img.hostedUrl, '/i/abc123');
            assert.ok(img.hostedAt > 0, '应记录入库时间');
            assert.equal(img.base64, '');
            assert.equal(img.CQCode, `[CQ:image,file=${BACKEND}/i/abc123]`);
            assert.equal(img.src, `${BACKEND}/i/abc123`);
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 有图床时持久化剥离 base64（内存仍可保留给本轮请求） */
    async testSaveStripsBase64WhenHosted(): Promise<void> {
        useHost();
        captureStorage();
        try {
            const img = new Image();
            img.imageId = 'img_save';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            img.base64 = 'QUJD';
            Image.save(img);
            assert.equal(img.base64, 'QUJD', '内存里应保留');
            const data = JSON.parse(stored['image_img_save']);
            assert.equal(data.base64, '', '落盘应剥离 base64');
            assert.equal(data.hostedUrl, '/i/abc123');
        } finally {
            restoreHost();
        }
    },

    /** 已入库时 ensureBytes 直接走 b64 出口，不重复上传 */
    async testEnsureBytesFromHost(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        routes = [b64Route()];
        try {
            const img = new Image();
            img.imageId = 'img_bytes';
            img.url = 'https://example.com/a.png';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            const b64 = await img.ensureBytes();
            assert.equal(b64, 'QUJD');
            assert.equal(img.format, 'png');
            assert.equal(calls.length, 1, '只应请求 b64 出口');
            assert.equal(calls[0].url, `${BACKEND}/i/abc123/b64`);
            const data = JSON.parse(stored['image_img_bytes']);
            assert.equal(data.base64, '', '落盘不应带 base64');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 配了图床后 urlToBase64 只走图床：先入库再取 b64，绝不调 i2b64 */
    async testHostModeDoesNotUseI2b64(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        routes = [uploadRoute(), b64Route()];
        try {
            const img = new Image();
            img.imageId = 'img_route';
            img.url = 'https://example.com/a.png';
            await img.urlToBase64();
            assert.equal(img.base64, 'QUJD');
            const urls = calls.map(c => c.url);
            assert.deepEqual(urls, [`${BACKEND}/api/upload`, `${BACKEND}/i/abc123/b64`]);
            assert.equal(urls.some(u => u.includes('image-to-base64')), false, '不应回退 i2b64');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 生图 base64：入库成功则清空 base64，失败则保留兜底 */
    async testAdoptBase64ToHost(): Promise<void> {
        useHost();
        mockFetch();
        routes = [uploadRoute()];
        try {
            const img = new Image();
            img.imageId = 'img_gen';
            img.base64 = 'QUJD';
            img.format = 'png';
            const ok = await img.adoptBase64ToHost();
            assert.equal(ok, true);
            assert.equal(img.base64, '', '入库后应清空 base64');
            assert.equal(img.hostedUrl, '/i/abc123');
            assert.equal(JSON.parse(calls[0].init.body).base64, 'QUJD');
        } finally {
            restoreFetch();
            restoreHost();
        }

        useHost();
        mockFetch();
        routes = [{ match: (url) => url === `${BACKEND}/api/upload`, status: 503, data: { error: 'down' } }];
        try {
            const img = new Image();
            img.imageId = 'img_gen_fail';
            img.base64 = 'QUJD';
            const ok = await img.adoptBase64ToHost();
            assert.equal(ok, false);
            assert.equal(img.base64, 'QUJD', '失败时应保留 base64');
            assert.equal(img.hostedUrl, '');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 模型报图床地址加载失败时，能按 remoteUrl 命中 */
    async testMarkUrlBrokenMatchesHostedUrl(): Promise<void> {
        useHost();
        captureStorage();
        try {
            const img = new Image();
            img.imageId = 'img_broken';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            Image.imageMap['img_broken'] = img;
            const n = Image.markUrlBrokenByUrls([`${BACKEND}/i/abc123`]);
            assert.equal(n, 1);
            assert.equal(img.urlBroken, true);
        } finally {
            delete Image.imageMap['img_broken'];
            restoreHost();
        }
    },

    /** 只有图床 id、没有本地 url/base64（生图转存后重载）：仍能取到字节 */
    async testEnsureBytesForHostedOnlyImage(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        routes = [b64Route()];
        try {
            const img = new Image();
            img.imageId = 'img_hosted_only';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            assert.equal(img.type, 'url', '有图床时按 URL 图片处理');
            const b64 = await img.ensureBytes();
            assert.equal(b64, 'QUJD');
            assert.equal(img.src, 'data:image/png;base64,QUJD');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 释放引用：POST /api/release，带 token；空列表不发请求 */
    async testRelease(): Promise<void> {
        useHost();
        mockFetch();
        routes = [{ match: (url) => url === `${BACKEND}/api/release`, data: { ok: true, released: 1 } }];
        try {
            assert.equal(await ImageHost.release([]), false, '空列表不应发请求');
            assert.equal(calls.length, 0);
            assert.equal(await ImageHost.release(['img_1']), true);
            assert.equal(calls[0].url, `${BACKEND}/api/release`);
            assert.deepEqual(JSON.parse(calls[0].init.body).refs, ['img_1']);
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 收到消息建图（createUrlImage）即异步入库 */
    async testCreateUrlImageCaptures(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        routes = [uploadRoute()];
        try {
            const img = Image.createUrlImage('g1', 'https://example.com/x.png', 'img_create');
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(img.hostedUrl, '/i/abc123', '创建后应异步入库');
            assert.equal(calls.length, 1, '应触发一次上传');
            assert.equal(JSON.parse(calls[0].init.body).ref, 'img_create');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 回环判断：只有 127.x/localhost/::1/0.0.0.0 算回环，IP 与域名都算对外可用 */
    testIsLoopbackUrl(): void {
        for (const u of ['http://127.0.0.1:46680', 'http://127.1.2.3:46680', 'http://localhost:46680',
            'http://foo.localhost', 'http://[::1]:46680', 'http://0.0.0.0:46680']) {
            assert.equal(isLoopbackUrl(u), true, `${u} 应判为回环`);
        }
        for (const u of ['http://192.168.1.10:46680', 'http://10.0.0.5:46680', 'https://img.example.com',
            'http://test-host:46680', '']) {
            assert.equal(isLoopbackUrl(u), false, `${u} 不应判为回环`);
        }
    },

    /** 图床地址是 IP/域名：多模态组包直接用稳定 URL 交给模型（不再转 base64） */
    async testMultimodalUsesHostedUrl(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        try {
            const img = new Image();
            img.imageId = 'img_mm';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            Image.imageMap['img_mm'] = img;
            const out = await textToMultimodalContent('[img:img_mm]');
            assert.ok(Array.isArray(out), '应产出多模态内容块');
            const part = (out as any[])[0];
            assert.equal(part.type, 'image_url');
            assert.equal(part.image_url.url, `${BACKEND}/i/abc123`, '模型应拿到 IP/域名图床地址');
            assert.equal(calls.length, 0, 'IP/域名可用时不应再请求 b64 出口');
        } finally {
            delete Image.imageMap['img_mm'];
            restoreFetch();
            restoreHost();
        }
    },

    /** 图床地址是 IP/域名：发送直接用稳定 URL（[img:ID] / hosted 图片都一样） */
    async testHostedSendUsesUrlWhenIpOrDomain(): Promise<void> {
        useHost();
        captureStorage();
        mockFetch();
        try {
            const img = new Image();
            img.imageId = 'img_send_url';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            Image.imageMap['img_send_url'] = img;
            const segs = await resolveSendMessage(
                {} as any,
                { context: { findImage: async (_ctx: any, x: string) => (x === 'img_send_url' ? img : null) } } as any,
                '[img:img_send_url]',
            );
            const imageSeg = (segs as any[]).find((s) => s.type === 'image');
            assert.ok(imageSeg, '应生成 image 段');
            assert.equal(imageSeg.data.file, `${BACKEND}/i/abc123`, '发送应使用 IP/域名地址');
            assert.equal(calls.length, 0, '不应请求 b64 出口');
        } finally {
            delete Image.imageMap['img_send_url'];
            restoreFetch();
            restoreHost();
        }
    },

    /** 回环地址：发送降级为本地文件（绝不把 127.0.0.1 交给协议端） */
    async testLoopbackHostSendUsesLocalFile(): Promise<void> {
        useLoopbackHost();
        captureStorage();
        mockFetch();
        routes = [b64Route()];
        try {
            const img = new Image();
            img.imageId = 'img_loop';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            Image.imageMap['img_loop'] = img;
            assert.equal(ImageHost.isLoopback, true, '回环地址应被识别');
            const file = await img.getSendFile();
            assert.equal(file, '/tmp/aiplugin4-test-media-4.bin', '应落成本地文件');
            assert.equal(file.includes('127.0.0.1'), false, '不得外发回环地址');
            assert.equal(calls.length, 1);
            assert.ok(calls[0].url.endsWith('/i/abc123/b64'), '应从 b64 出口取字节');
            assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');

            const segs = await resolveSendMessage(
                {} as any,
                { context: { findImage: async (_ctx: any, x: string) => (x === 'img_loop' ? img : null) } } as any,
                '[img:img_loop]',
            );
            const imageSeg = (segs as any[]).find((s) => s.type === 'image');
            assert.ok(imageSeg, '应生成 image 段');
            assert.equal(imageSeg.data.file, '/tmp/aiplugin4-test-media-4.bin');
        } finally {
            delete Image.imageMap['img_loop'];
            restoreFetch();
            restoreHost();
        }
    },

    /** 回环地址：模型侧仍取内联字节（模型访问不到回环） */
    async testLoopbackHostModelUsesBase64(): Promise<void> {
        useLoopbackHost();
        captureStorage();
        mockFetch();
        routes = [b64Route()];
        try {
            const img = new Image();
            img.imageId = 'img_loop_mm';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            Image.imageMap['img_loop_mm'] = img;
            const out = await textToMultimodalContent('[img:img_loop_mm]');
            const part = (out as any[])[0];
            assert.equal(part.type, 'image_url');
            assert.equal(part.image_url.url, 'data:image/png;base64,QUJD', '回环地址时模型应拿到内联字节');
        } finally {
            delete Image.imageMap['img_loop_mm'];
            restoreFetch();
            restoreHost();
        }
    },

    /** 图床 url 是回环，但配了 publicUrl（IP/域名）：发送与模型都用 publicUrl，不降级 */
    async testPublicUrlOverridesLoopbackForSendAndModel(): Promise<void> {
        useHost(true, 'tok-123', 'http://127.0.0.1:46680', 'http://192.168.1.10:46680');
        captureStorage();
        mockFetch();
        try {
            const img = new Image();
            img.imageId = 'img_pub';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            Image.imageMap['img_pub'] = img;
            assert.equal(ImageHost.externalBase, 'http://192.168.1.10:46680', '对外地址应用 publicUrl');
            assert.equal(ImageHost.externalEnabled, true);

            const file = await img.getSendFile();
            assert.equal(file, 'http://192.168.1.10:46680/i/abc123', '发送应用 publicUrl');
            assert.equal(calls.length, 0, '对外地址可用时不应取 b64');

            const out = await textToMultimodalContent('[img:img_pub]');
            const part = (out as any[])[0];
            assert.equal(part.image_url.url, 'http://192.168.1.10:46680/i/abc123', '模型也应用 publicUrl');
        } finally {
            delete Image.imageMap['img_pub'];
            restoreFetch();
            restoreHost();
        }
    },

    /** 图床 url 是 IP、publicUrl 也配置时以 publicUrl 为准 */
    async testPublicUrlWinsOverNonLoopbackUrl(): Promise<void> {
        useHost(true, 'tok-123', 'http://10.0.0.5:46680', 'https://img.example.com');
        try {
            assert.equal(ImageHost.externalBase, 'https://img.example.com');
            assert.equal(ImageHost.externalUrl('/i/abc'), 'https://img.example.com/i/abc');
            assert.equal(ImageHost.absolute('/i/abc'), 'http://10.0.0.5:46680/i/abc', '内部请求仍用 url');
        } finally {
            restoreHost();
        }
    },

    /** 回环地址且取字节失败、又没有原始 URL：发送返回空（调用方跳过，不回退回环地址） */
    async testLoopbackHostSendFailsSoftWithoutFallback(): Promise<void> {
        useLoopbackHost();
        captureStorage();
        mockFetch();
        routes = [{ match: (url) => url.endsWith('/i/abc123/b64'), status: 500, data: { error: 'boom' } }];
        try {
            const img = new Image();
            img.imageId = 'img_loop_fail';
            img.hostedId = 'abc123';
            img.hostedUrl = '/i/abc123';
            const file = await img.getSendFile();
            assert.equal(file, '', '取不到字节且无原始 URL 时应返回空');
            assert.equal(file.includes('127.0.0.1'), false);
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 头像（qlogo 公网地址）不进图床：ensureBytes 直接返回空且不发请求 */
    async testAvatarNotHosted(): Promise<void> {
        useHost();
        mockFetch();
        try {
            const avatar = Image.getUserAvatar('QQ:12345');
            assert.equal(avatar.isAvatarImage, true);
            assert.equal(await avatar.ensureBytes(), '');
            assert.equal(calls.length, 0, '头像不应触发图床请求');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 真后端联调（设 IMAGE_HOST_E2E=<地址> 时才跑）：上传 base64 → 取字节 → 释放 */
    async testImageHostRealBackend(): Promise<void> {
        const base = process.env.IMAGE_HOST_E2E || '';
        if (!base) return; // 默认跳过：单元测试不依赖外部服务
        const token = process.env.IMAGE_HOST_E2E_TOKEN || '';
        TC.stringConfigs['后端配置'] = JSON.stringify({
            version: 1,
            backends: {
                'image-url-to-base64': { url: I2B64 },
                'image-host': { url: base, token },
            },
        });
        resetConfigCache();
        assert.equal(ImageHost.enabled, true, '真后端用例：图床应已启用');
        assert.equal(ImageHost.base, base, '真后端用例：地址应为 E2E 地址');
        const prevFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = NODE_FETCH;
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        try {
            const item = await ImageHost.uploadBase64(png, 'png', 'e2e_ref_1');
            assert.ok(item, '真实后端上传应成功');
            assert.equal(item!.url, `/i/${item!.id}`);
            const bytes = await ImageHost.fetchBase64(item!.id);
            assert.ok(bytes, '真实后端应能取回字节');
            assert.equal(bytes!.base64, png);

            // Image 层：base64 转存 → 清空 → 再按需取回
            const img = new Image();
            img.imageId = 'e2e_img';
            img.base64 = png;
            img.format = 'png';
            assert.equal(await img.adoptBase64ToHost(), true, 'Image 转存应成功');
            assert.equal(img.base64, '', '转存后应清空 base64');
            assert.ok(img.hostedId, '应记录图床 id');
            assert.equal(await img.ensureBytes(), png, '按需取回的字节应与原图一致');

            assert.equal(await ImageHost.release(['e2e_ref_1', 'e2e_img']), true, '释放引用应成功');
        } finally {
            (globalThis as any).fetch = prevFetch;
            delete TC.stringConfigs['后端配置'];
            resetConfigCache();
        }
    },

    /** 入库时携带来源信息（平台/群/用户/消息 id） */
    async testCaptureCarriesSourceMeta(): Promise<void> {
        useHost();
        mockFetch();
        routes = [uploadRoute()];
        try {
            Image.createUrlImage('QQ-Group:123', 'https://example.com/x.png', 'img_meta', {
                platform: 'QQ',
                group_id: '123',
                user_id: '456',
                message_id: 'mid-1',
                at: 1700000000000,
            });
            await new Promise(resolve => setTimeout(resolve, 30));
            const body = JSON.parse(calls[0].init.body);
            assert.deepEqual(body.source, {
                platform: 'QQ',
                group_id: '123',
                user_id: '456',
                message_id: 'mid-1',
                at: 1700000000000,
                session_id: 'QQ-Group:123',
                raw_url: 'https://example.com/x.png',
            });
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** exists 对账接口：解析 missing；网络失败返回 null */
    async testImageHostExists(): Promise<void> {
        useHost();
        mockFetch();
        try {
            routes = [existsRoute(['a', 'c'])];
            const missing = await ImageHost.exists(['a', 'b', 'c']);
            assert.deepEqual(missing, ['a', 'c']);
            assert.deepEqual(JSON.parse(calls[0].init.body).refs, ['a', 'b', 'c']);

            routes = [{ match: (url) => url === `${BACKEND}/api/exists`, status: 500, data: {} }];
            assert.equal(await ImageHost.exists(['a']), null, '网络失败应为 null（调用方跳过）');
        } finally {
            restoreFetch();
            restoreHost();
        }
    },

    /** 上传并发上限：合并转发几十张图时最多 4 个并发请求 */
    async testUploadConcurrencyCap(): Promise<void> {
        useHost();
        const origFetch = (globalThis as any).fetch;
        ImageHost.resetUploadSlotsForTest();
        let active = 0;
        let peak = 0;
        (globalThis as any).fetch = async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'x', url: '/i/x', b64_url: '/i/x/b64' }) };
        };
        try {
            const jobs = Array.from({ length: 10 }, (_, i) => ImageHost.uploadByUrl(`https://example.com/${i}.png`, `r${i}`));
            await Promise.all(jobs);
            assert.ok(peak <= 4, `并发应 ≤ 4，实际 ${peak}`);
            assert.ok(peak >= 2, `应确实并发执行，实际 ${peak}`);
        } finally {
            (globalThis as any).fetch = origFetch;
            ImageHost.resetUploadSlotsForTest();
            restoreHost();
        }
    },

    /** exists 对账：图床上已不存在的图片被标记失效，图床还在的不动 */
    async testGcReconcileMarksMissing(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        routes = [existsRoute(['img_rec1'])];
        const now = Date.now();
        try {
            makeStoredImage('img_rec1', now, 'blob1');
            makeStoredImage('img_rec2', now, 'blob2');
            const marked = await ImageGC.reconcile();
            assert.equal(marked, 1);
            const gone = Image.get('img_rec1')!;
            assert.equal(gone.urlBroken, true);
            assert.equal(gone.hostedId, '');
            const alive = Image.get('img_rec2')!;
            assert.equal(alive.urlBroken, false, '图床还在的图片不应被标记');
            assert.equal(alive.hostedId, 'blob2');
        } finally {
            delete Image.imageMap['img_rec1'];
            delete Image.imageMap['img_rec2'];
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 索引：分片写入、按 id 删除、可枚举 */
    testImageIndex(): void {
        captureStorage();
        ImageIndex.resetForTest();
        try {
            ImageIndex.touch('a', 1000);
            ImageIndex.touch('b', 2000, 'blob1');
            const all = ImageIndex.all();
            assert.equal(all.length, 2);
            const b = all.find(x => x.id === 'b')!;
            assert.equal(b.entry.u, 2000);
            assert.equal(b.entry.h, 'blob1');
            ImageIndex.remove('a');
            assert.equal(ImageIndex.all().length, 1);
        } finally {
            ImageIndex.resetForTest();
        }
    },

    /** 清理：删除过期记录、保留新记录、把过期 ref 交给图床释放 */
    async testGcTrimDeletesStaleAndReleases(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        routes = [releaseRoute()];
        const now = Date.now();
        try {
            makeStoredImage('img_old', now - 40 * 86400_000, 'blobOld');
            makeStoredImage('img_new', now, 'blobNew');
            const deleted = await ImageGC.trim();
            assert.equal(deleted, 1);
            assert.equal(stored['image_img_old'], '', '过期记录应被清空');
            assert.notEqual(stored['image_img_new'], '', '新记录应保留');
            assert.deepEqual(JSON.parse(calls[0].init.body).refs, ['img_old']);
            assert.equal(ImageIndex.all().some(x => x.id === 'img_old'), false);
        } finally {
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 清理：内存里正在使用的图片不删（交叉清理安全） */
    async testGcSkipsInMemoryImage(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        routes = [releaseRoute()];
        const now = Date.now();
        const img = makeStoredImage('img_live', now - 40 * 86400_000, 'blobLive');
        Image.imageMap['img_live'] = img;
        try {
            const deleted = await ImageGC.trim();
            assert.equal(deleted, 0, '内存中在用的图片不应被清理');
            assert.notEqual(stored['image_img_live'], '');
        } finally {
            delete Image.imageMap['img_live'];
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 图床释放失败 → 进待补发队列；下次成功后再清空 */
    async testGcPendingReleaseRetry(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        const now = Date.now();
        try {
            makeStoredImage('img_p1', now - 40 * 86400_000, 'blobP');
            routes = [{ match: (url) => url === `${BACKEND}/api/release`, status: 500, data: {} }];
            await ImageGC.trim();
            assert.deepEqual(JSON.parse(stored['image_release_pending'] || '[]'), ['img_p1']);

            routes = [releaseRoute()];
            const released = await ImageGC.flushPending();
            assert.equal(released, 1);
            assert.deepEqual(JSON.parse(stored['image_release_pending'] || '[]'), []);
        } finally {
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 图床删除对账：delete_ref 命中后把图片标记失效并清掉图床字段 */
    async testGcSyncChangesMarksBroken(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        const now = Date.now();
        makeStoredImage('img_chg', now, 'blob1');
        routes = [{
            match: (url) => url.startsWith(`${BACKEND}/api/changes`),
            data: { cursor: 3, reset: false, events: [{ seq: 3, kind: 'delete_ref', blob_id: 'blob1', ref: 'img_chg' }] },
        }];
        try {
            const marked = await ImageGC.syncChanges();
            assert.equal(marked, 1);
            const img = Image.get('img_chg')!;
            assert.equal(img.urlBroken, true);
            assert.equal(img.hostedId, '');
            assert.equal(img.hostedUrl, '');
            assert.equal(stored['image_host_cursor'], '3');
        } finally {
            delete Image.imageMap['img_chg'];
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 图床删除对账：没有 ref 的事件按 blob id 命中索引里的图片 */
    async testGcSyncChangesByBlobId(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        const now = Date.now();
        makeStoredImage('img_blob', now, 'blobX');
        routes = [{
            match: (url) => url.startsWith(`${BACKEND}/api/changes`),
            data: { cursor: 5, reset: false, events: [{ seq: 5, kind: 'delete_blob', blob_id: 'blobX' }] },
        }];
        try {
            assert.equal(await ImageGC.syncChanges(), 1);
            const img = Image.get('img_blob')!;
            assert.equal(img.urlBroken, true);
            assert.equal(img.hostedId, '');
        } finally {
            delete Image.imageMap['img_blob'];
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 交叉清理：两个图片共享同一 blob，只清过期的那条 ref，另一条不动 */
    async testGcSharedBlobOnlyReleasesExpiredRef(): Promise<void> {
        useHost(); captureStorage(); useGcDays(30); ImageIndex.resetForTest();
        mockFetch();
        routes = [releaseRoute()];
        const now = Date.now();
        try {
            makeStoredImage('img_shared_old', now - 40 * 86400_000, 'sharedBlob');
            makeStoredImage('img_shared_new', now, 'sharedBlob');
            const deleted = await ImageGC.trim();
            assert.equal(deleted, 1);
            assert.deepEqual(JSON.parse(calls[0].init.body).refs, ['img_shared_old']);
            assert.notEqual(stored['image_img_shared_new'], '', '另一条引用的记录应保留');
        } finally {
            ImageGC.resetForTest(); restoreFetch(); restoreHost(); useGcDays(0);
        }
    },

    /** 清理天数为 0：完全不清理 */
    async testGcDisabledWhenDaysZero(): Promise<void> {
        useHost(); captureStorage(); useGcDays(0); ImageIndex.resetForTest();
        mockFetch();
        const now = Date.now();
        try {
            makeStoredImage('img_keep', now - 400 * 86400_000, 'blobK');
            assert.equal(await ImageGC.trim(), 0);
            assert.notEqual(stored['image_img_keep'], '');
            assert.equal(calls.length, 0);
        } finally {
            ImageGC.resetForTest(); restoreFetch(); restoreHost();
        }
    },

    /** 真后端联调（设 IMAGE_HOST_E2E 时）：过期清理真的释放 ref；WebUI 删除能被 changes 对账到 */
    async testImageGcRealBackend(): Promise<void> {
        const base = process.env.IMAGE_HOST_E2E || '';
        if (!base) return;
        const token = process.env.IMAGE_HOST_E2E_TOKEN || '';
        TC.stringConfigs['后端配置'] = JSON.stringify({
            version: 1,
            backends: {
                'image-url-to-base64': { url: I2B64 },
                'image-host': { url: base, token },
            },
        });
        resetConfigCache();
        assert.equal(ImageHost.enabled, true, '真后端用例：图床应已启用');
        const prevFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = NODE_FETCH;
        captureStorage();
        useGcDays(30);
        ImageIndex.resetForTest();
        const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const png2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const api = async (path: string, init: any = {}) => {
            const headers: any = { 'Authorization': `Bearer ${token}` };
            if (init.body) headers['Content-Type'] = 'application/json';
            const resp = await (globalThis as any).fetch(base + path, { ...init, headers });
            return resp.json();
        };
        try {
            // 1) 入库 → 过期 → 清理：真实后端应释放该 ref
            const img = new Image();
            img.imageId = 'e2e_gc_1';
            img.base64 = png1;
            img.format = 'png';
            assert.equal(await img.adoptBase64ToHost(), true, '入库应成功');
            img.lastUsedAt = Date.now() - 40 * 86400_000;
            Image.save(img);
            assert.equal(await ImageGC.trim(), 1, '应清掉 1 条过期记录');
            const ex = await api('/api/exists', { method: 'POST', body: JSON.stringify({ refs: ['e2e_gc_1'] }) });
            assert.deepEqual(ex.missing, ['e2e_gc_1'], '真实后端应已释放该 ref');

            // 2) WebUI 删除 → changes 对账 → 插件标记失效
            const img2 = new Image();
            img2.imageId = 'e2e_gc_2';
            img2.base64 = png2;
            img2.format = 'png';
            assert.equal(await img2.adoptBase64ToHost(), true, '第二张入库应成功');
            Image.save(img2);
            const del = await api('/api/image/' + img2.hostedId, { method: 'DELETE' });
            assert.equal(del.ok, true, 'WebUI 删除应成功');
            // 软删除：ref 还在，exists 对账不应误伤
            assert.equal(await ImageGC.reconcile(), 0, '软删除仍保留 ref，对账不应误伤');
            // 彻底删除：ref 级联清掉，exists 对账应标记失效
            const purge = await api('/api/batch', { method: 'POST', body: JSON.stringify({ action: 'purge', ids: [img2.hostedId] }) });
            assert.ok(purge && purge.ok, '彻底删除应成功');
            assert.ok((await ImageGC.reconcile()) >= 1, '彻底删除后 exists 对账应标记失效');
            const after = Image.get('e2e_gc_2')!;
            assert.equal(after.urlBroken, true, '删除后应标记不可用');
            assert.equal(after.hostedId, '', '删除后应清掉图床 id');
            // change_log 对账同样能命中（幂等）
            const marked = await ImageGC.syncChanges();
            assert.ok(marked >= 1, 'changes 对账也应命中');

            // 3) 同哈希：两个独立图片对象共享一份字节，各自一条 ref
            const a = new Image();
            a.imageId = 'e2e_share_a';
            a.base64 = png1;
            a.format = 'png';
            assert.equal(await a.adoptBase64ToHost(), true);
            Image.save(a);
            const b = new Image();
            b.imageId = 'e2e_share_b';
            b.base64 = png1;
            b.format = 'png';
            assert.equal(await b.adoptBase64ToHost(), true);
            Image.save(b);
            assert.equal(a.hostedId, b.hostedId, '同哈希应指向同一 blob');
            assert.notEqual(a.imageId, b.imageId, '图片 id 必须各自独立');
            let ex2 = await api('/api/exists', { method: 'POST', body: JSON.stringify({ refs: ['e2e_share_a', 'e2e_share_b'] }) });
            assert.deepEqual(ex2.missing, [], '两条 ref 都应存在');
            assert.equal(await ImageHost.release(['e2e_share_a']), true);
            ex2 = await api('/api/exists', { method: 'POST', body: JSON.stringify({ refs: ['e2e_share_a', 'e2e_share_b'] }) });
            assert.deepEqual(ex2.missing, ['e2e_share_a'], '释放一条后另一条应保留');
        } finally {
            (globalThis as any).fetch = prevFetch;
            delete Image.imageMap['e2e_gc_1'];
            delete Image.imageMap['e2e_gc_2'];
            delete Image.imageMap['e2e_share_a'];
            delete Image.imageMap['e2e_share_b'];
            ImageGC.resetForTest();
            ImageIndex.resetForTest();
            delete TC.stringConfigs['后端配置'];
            resetConfigCache();
            useGcDays(0);
        }
    },
};



