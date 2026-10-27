// 模型图源（19-模型图片尺寸上限与图源方案）单元测试
// 由 scripts/test-unit.cjs 打包后加载运行，不启动 SealDice/QQ
// @ts-nocheck
import assert from "node:assert/strict";

import "./test-host";

import Config from "../src/config/config";
Config.registerConfig();

import Image from "../src/resource/image";
import { ImageHost } from "../src/resource/image_host";
import {
    buildImageTrace,
    decodeBase64Prefix,
    decideModelSource,
    exceedsMaxSide,
    hostedIdFromImageUrl,
    locateRejectedImageRefs,
    parseImageSize,
    parseImageSizeFromBase64,
    type ModelSourceFacts,
} from "../src/resource/image_model_source";
import { classifyApiError, isImageDownloadFailure, isImageRejectedFailure, isImageRoleFailure, isPayloadTooLargeFailure, parseImageErrorPosition } from "../src/model/api_error";
import { toLLM, toLLMText } from "../src/context/content/llm";
import { demoteMediaParts, renderText } from "../src/context/content/render";
import { normalizeToolResult } from "../src/context/content/tool_result";
import { sanitizeChatMessages, textToMultimodalContent } from "../src/utils/message";

const TC = (globalThis as any).__TEST_CONFIG__;

// ---- 构造最小图片头（只够解析尺寸） ----
function bytes(list: number[]): Uint8Array {
    return Uint8Array.from(list);
}

function pngHeader(w: number, h: number): Uint8Array {
    const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h), 8, 2, 0, 0, 0]);
}

function jpegHeader(w: number, h: number): Uint8Array {
    return bytes([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
        0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x04, 0x11, 0x01, 0x00, 0xff, 0xd9,
    ]);
}

function gifHeader(w: number, h: number): Uint8Array {
    return bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff, 0, 0, 0, 0]);
}

function webpVp8lHeader(w: number, h: number): Uint8Array {
    const bits = ((h - 1) << 14) | (w - 1);
    return bytes([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x4c, 0x08, 0x00, 0x00, 0x00, 0x2f,
        bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff,
    ]);
}

function webpVp8xHeader(w: number, h: number): Uint8Array {
    const u24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
    return bytes([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...u24(w - 1), ...u24(h - 1),
    ]);
}

function bmpHeader(w: number, h: number): Uint8Array {
    const i32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    const head = new Array(54).fill(0);
    head[0] = 0x42; head[1] = 0x4d;
    const i32 = i32le(w);
    head[18] = i32[0]; head[19] = i32[1]; head[20] = i32[2]; head[21] = i32[3];
    const i32h = i32le(h);
    head[22] = i32h[0]; head[23] = i32h[1]; head[24] = i32h[2]; head[25] = i32h[3];
    return Uint8Array.from(head);
}

function toBase64(b: Uint8Array): string {
    return Buffer.from(b).toString('base64');
}

function useHost(url = 'http://test-host:46680', publicUrl = ''): void {
    TC.stringConfigs['后端配置'] = JSON.stringify({
        version: 1,
        backends: { 'image-host': { url, token: 'tok', ...(publicUrl ? { publicUrl } : {}) } },
    });
    // 单元测试桩不注册配置项 → int 读成 0；这里显式给出与出厂默认一致的图片限制
    TC.intConfigs['模型图片单边上限'] = 8192;
    TC.intConfigs['模型图片目标长边'] = 2048;
    TC.intConfigs['每轮最多内联图片数'] = 20;
    TC.intConfigs['每条工具结果最多升格图片数'] = 8;
    TC.boolConfigs['图片被模型拒绝时自动降级'] = true;
    TC.boolConfigs['图片降级通知'] = false;
    (Config as any).cache = {};
}

function restoreHost(): void {
    delete TC.stringConfigs['后端配置'];
    (Config as any).cache = {};
    (ImageHost as any).capabilities = [];
    delete (globalThis as any).__MODEL_SOURCE_TEST__;
}

function setCapabilities(list: string[]): void {
    (ImageHost as any).capabilities = list;
}

function baseFacts(over: Partial<ModelSourceFacts> = {}): ModelSourceFacts {
    return {
        imageId: 'img_1',
        kind: 'base64',
        isAvatar: false,
        hosted: false,
        backendVariant: false,
        variantUrl: '',
        inlineVariantUrl: '',
        remoteUrl: '',
        urlUnusable: false,
        base64Url: 'data:image/png;base64,QUJD',
        size: { w: 100, h: 100 },
        modelUnsafe: false,
        maxSide: 8192,
        ...over,
    };
}

export const tests = {
    /** 图片头解析：PNG/JPEG/GIF/WEBP(VP8L/VP8X)/BMP */
    testParseImageSizeAllFormats(): void {
        assert.deepEqual(parseImageSize(pngHeader(2304, 10102)), { w: 2304, h: 10102 });
        assert.deepEqual(parseImageSize(jpegHeader(1200, 20640)), { w: 1200, h: 20640 });
        assert.deepEqual(parseImageSize(gifHeader(320, 240)), { w: 320, h: 240 });
        assert.deepEqual(parseImageSize(webpVp8lHeader(100, 50)), { w: 100, h: 50 });
        assert.deepEqual(parseImageSize(webpVp8xHeader(300, 200)), { w: 300, h: 200 });
        assert.deepEqual(parseImageSize(bmpHeader(640, 480)), { w: 640, h: 480 });
        assert.equal(parseImageSize(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null);
    },

    /** base64 前缀解码 / data URI 前缀 / 尺寸解析 */
    testParseImageSizeFromBase64(): void {
        const png = pngHeader(2304, 10102);
        assert.deepEqual(parseImageSizeFromBase64(toBase64(png)), { w: 2304, h: 10102 });
        assert.deepEqual(parseImageSizeFromBase64(`data:image/png;base64,${toBase64(png)}`), { w: 2304, h: 10102 });
        assert.deepEqual(parseImageSizeFromBase64(`data:image/png;base64,${toBase64(png).replace(/=+$/, '')}`), { w: 2304, h: 10102 });
        assert.equal(parseImageSizeFromBase64(''), null);
        assert.equal(parseImageSizeFromBase64('not-base64!!'), null);
        assert.deepEqual(Array.from(decodeBase64Prefix('QUJD')), [65, 66, 67]);
    },

    /** 单边超限判定：0 = 不检查 */
    testExceedsMaxSide(): void {
        assert.equal(exceedsMaxSide({ w: 8192, h: 8192 }, 8192), false);
        assert.equal(exceedsMaxSide({ w: 8193, h: 100 }, 8192), true);
        assert.equal(exceedsMaxSide({ w: 100, h: 8193 }, 8192), true);
        assert.equal(exceedsMaxSide({ w: 99999, h: 99999 }, 0), false);
    },

    /** 选源决策表（方案 §5.3） */
    testDecideModelSourceTable(): void {
        // 头像：qlogo 原地址
        assert.deepEqual(decideModelSource(baseFacts({ isAvatar: true, kind: 'url', remoteUrl: 'https://q1.qlogo.cn/x' })),
            { kind: 'url', src: 'https://q1.qlogo.cn/x', reason: 'avatar' });
        // modelUnsafe / URL 坏了 / 本轮全降级
        assert.equal(decideModelSource(baseFacts({ modelUnsafe: true })).reason, 'unsafe');
        assert.equal(decideModelSource(baseFacts({ urlUnusable: true })).reason, 'broken');
        assert.equal(decideModelSource(baseFacts({ kind: 'url', remoteUrl: 'http://a/b.png', imagesAsText: true })).reason, 'images-as-text');
        // base64：尺寸已知且超限 → 文本；否则原样
        assert.equal(decideModelSource(baseFacts({ size: { w: 8193, h: 100 } })).reason, 'oversize');
        assert.equal(decideModelSource(baseFacts({ size: null })).reason, 'base64');
        // 图床 + 变体能力：变体 URL 优先，其次预取内联
        const hosted = baseFacts({ hosted: true, backendVariant: true, variantUrl: 'http://h/m/abc?max=2048', remoteUrl: 'http://h/i/abc' });
        assert.deepEqual(decideModelSource(hosted), { kind: 'url', src: 'http://h/m/abc?max=2048', reason: 'hosted-variant' });
        const hostedInline = baseFacts({ hosted: true, backendVariant: true, inlineVariantUrl: 'data:image/webp;base64,QQ==', remoteUrl: 'http://h/i/abc' });
        assert.equal(decideModelSource(hostedInline).reason, 'hosted-inline');
        // 有变体能力但两个地址都不可用 → 文本（不赌原图）
        assert.equal(decideModelSource(baseFacts({ hosted: true, backendVariant: true })).reason, 'unsafe');
        // 旧后端：保持现状 URL
        assert.deepEqual(decideModelSource(baseFacts({ hosted: true, backendVariant: false, kind: 'url', remoteUrl: 'http://h/i/abc' })),
            { kind: 'url', src: 'http://h/i/abc', reason: 'hosted-legacy' });
        // 非图床 URL / local
        assert.equal(decideModelSource(baseFacts({ kind: 'url', remoteUrl: 'https://cdn/x.jpg', size: null })).reason, 'url');
        assert.equal(decideModelSource(baseFacts({ kind: 'local' })).reason, 'local');
    },

    /** 模型报错识别：unsupported image 与 download failure 互斥 */
    testImageErrorClassification(): void {
        const unsupported = '.messages[1].image[20]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif.';
        assert.equal(isImageRejectedFailure(unsupported), true);
        assert.equal(isImageDownloadFailure(unsupported), false);
        const download = '.messages[0].image[0]: Failed to download image from http://x/i/abc';
        assert.equal(isImageRejectedFailure(download), false);
        assert.equal(isImageDownloadFailure(download), true);
        assert.equal(isImageRejectedFailure('params error'), false);
    },

    /** 错误里的图片定位解析 */
    testParseImageErrorPosition(): void {
        assert.deepEqual(parseImageErrorPosition('.messages[1].image[20]: boom'), { messageIndex: 1, imageIndex: 20 });
        assert.deepEqual(parseImageErrorPosition('messages[0]'), { messageIndex: 0, imageIndex: null });
        assert.equal(parseImageErrorPosition('no position here'), null);
    },

    /** 轨迹编号 + 精确定位（含 mime 形态退化） */
    testImageTraceAndLocate(): void {
        const messages = [
            { content: 'system' },
            { content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'u1' } }, { type: 'image_url', image_url: { url: 'u2' } }] },
            { content: [{ type: 'text', text: 't' }] },
            { content: [{ type: 'image_url', image_url: { url: 'u3' } }] },
        ];
        const trace = buildImageTrace(messages, ['ref1', 'ref2', 'ref3']);
        assert.deepEqual(trace, [
            { messageIndex: 1, imageIndexInMessage: 0, ref: 'ref1' },
            { messageIndex: 1, imageIndexInMessage: 1, ref: 'ref2' },
            { messageIndex: 3, imageIndexInMessage: 0, ref: 'ref3' },
        ]);
        assert.deepEqual(locateRejectedImageRefs('.messages[1].image[1]: unsupported', trace), ['ref2']);
        // 只有 .messages[N]：无法精确定位 → 全部
        assert.deepEqual(locateRejectedImageRefs('.messages[1]: unsupported', trace), ['ref1', 'ref2', 'ref3']);
        // 无轨迹 → 空（调用方 giveup）
        assert.deepEqual(locateRejectedImageRefs('.messages[1].image[0]', []), []);
    },

    /** 工具结果升格上限：超出保留 [img:] 文本 */
    testToolResultMaxMedia(): void {
        const text = Array.from({ length: 12 }, (_, i) => `[img:img_${i}]`).join(' ');
        const parts = normalizeToolResult({ text }, { allowImageRefs: true, noteUnregisteredMedia: false, maxMedia: 2 });
        const imageParts = parts.filter((p: any) => p.type === 'image');
        assert.equal(imageParts.length, 2, '最多升格 2 张');
        const textOut = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
        assert.ok(textOut.includes('[img:img_11]'), '超出上限的引用应保留文本');
    },

    /** 20 号方案 P0-A：aux/对外默认不解析图片 */
    async testAllowImagesGate(): Promise<void> {
        const text = '[img:abc] 你看这张图';
        assert.equal(await textToMultimodalContent(text, { allowImages: false }), text, 'allowImages=false 应原样返回文本');
        assert.equal(await textToMultimodalContent(text, { noImages: true }), text, 'noImages 应原样返回文本');
        const safe = sanitizeChatMessages([
            { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
            { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
        ]);
        assert.ok(!JSON.stringify(safe).includes('data:x'), '非 user 消息的图片块不能进入请求');
        assert.ok(safe[1].content.includes('image omitted'), '非 user 图片应降级为文本占位');
    },

    /** 20 号方案 INV-8：assistant 消息纯文本投影（保留 [img:] 标签、无 image 块） */
    testAssistantProjectionTextOnly(): void {
        const parts: any[] = [{ type: 'text', text: '看图 ' }, { type: 'image', ref: 'img_x', src: 'data:image/png;base64,AA' }];
        const text = toLLMText(parts, {}, {});
        assert.ok(text.includes('[img:img_x]'), '文本投影应保留图片标签');
        const rich = toLLM(parts, { vision: true }, 'openai', { imageUrl: () => 'data:image/png;base64,AA' });
        assert.ok(Array.isArray(rich) && rich.some((b: any) => b.type === 'image_url'), '对照组：可解析时 toLLM 会产出图片块');
        const demoted = demoteMediaParts(parts);
        assert.ok(demoted.every((p: any) => p.type === 'text'), '媒体 part 应全部降级为文本');
        assert.ok(renderText(demoted).includes('img_x'), '降级文本保留图片引用信息');
    },

    /** 20 号方案 P0-C：角色错误 / 413 分类 */
    testRoleAndPayloadClassification(): void {
        assert.equal(classifyApiError('', 400, '{"error":{"message":"Image in assistant message is not supported"}}'), 'image_role');
        assert.equal(classifyApiError('', 413, '<html><head><title>413 Request Entity Too Large</title></head></html>'), 'payload_too_large');
        assert.equal(classifyApiError('', 400, '{"error":{"message":".messages[0].image[0]: You have uploaded an unsupported image."}}'), 'image_rejected');
        assert.equal(isImageRoleFailure('Image in tool message is not supported'), true);
        assert.equal(isImageRoleFailure('.messages[1].image[0]: unsupported image'), false);
        assert.equal(isPayloadTooLargeFailure(413, ''), true);
        assert.equal(isPayloadTooLargeFailure(400, 'bad request'), false);
    },

    /** 20 号方案 P0-C：/m、/i、b64 出口的 URL → hostedId 映射 */
    testHostedUrlMapping(): void {
        const sha = 'd'.repeat(64);
        for (const url of [
            `http://host:46680/i/${sha}`,
            `http://host:46680/m/${sha}?max=2048`,
            `http://host:46680/i/${sha}/b64`,
            `http://host:46680/m/${sha}/b64?max=1536`,
        ]) {
            assert.equal(hostedIdFromImageUrl(url), sha, `应映射 ${url}`);
        }
        assert.equal(hostedIdFromImageUrl('http://host:46680/api/meta?ids=1'), '');
        assert.equal(hostedIdFromImageUrl('not-a-url'), '');
    },

    /** 20 号方案 P0-C：内联字节预算（超预算的 data URI 只留文本） */
    async testInlineByteBudget(): Promise<void> {
        const dataUrl = `data:image/png;base64,${toBase64(pngHeader(32, 32))}`;
        (Image as any).imageMap['img_budget'] = Object.assign(new Image(), {
            imageId: 'img_budget', format: 'png', base64: dataUrl.split(',')[1], modelUnsafe: false, urlBroken: false,
        });
        try {
            const tight = await textToMultimodalContent('[img:img_budget]', { inlineBudget: { left: 4, bytesLeft: 8 } });
            assert.ok(Array.isArray(tight) && !tight.some((p: any) => p.type === 'image_url'), '超字节预算应只留文本');
            const loose = await textToMultimodalContent('[img:img_budget]', { inlineBudget: { left: 4, bytesLeft: 1024 * 1024 } });
            assert.ok(Array.isArray(loose) && loose.some((p: any) => p.type === 'image_url'), '预算内应产出图片块');
        } finally {
            delete (Image as any).imageMap['img_budget'];
        }
    },

    /** 20 号方案 P1-C：MCP 原生 image block 也受工具结果图片上限约束 */
    testMcpImageCap(): void {
        const blocks = Array.from({ length: 3 }, () => ({ type: 'image', data: toBase64(pngHeader(8, 8)), mimeType: 'image/png' }));
        const parts = normalizeToolResult({ mcpContent: blocks } as any, { allowImageRefs: true, noteUnregisteredMedia: false, maxMedia: 1 });
        const imageParts = parts.filter((p: any) => p.type === 'image');
        assert.ok(imageParts.length <= 1, `MCP 图片最多 1 张，实际 ${imageParts.length}`);
    },

    /** Image 实体：尺寸解析/超限/模型不可用/变体 URL（含 capability + publicUrl） */
    testImageModelSourceIntegration(): void {
        useHost('http://test-host:46680', 'http://public-host:46680');
        setCapabilities(['model-variant', 'meta']);
        assert.equal(ImageHost.supportsModelVariant, true);
        assert.equal(ImageHost.modelUrl('a'.repeat(64), 2048), 'http://public-host:46680/m/' + 'a'.repeat(64) + '?max=2048');
        assert.equal(ImageHost.modelUrl('a'.repeat(64), 0), 'http://public-host:46680/m/' + 'a'.repeat(64));

        // 非图床 base64：尺寸超限 → 只留文本
        const big = new Image();
        big.imageId = 'img_big';
        big.format = 'png';
        big.base64 = toBase64(pngHeader(2304, 10102));
        assert.deepEqual(big.modelSourceDecision().reason, 'oversize');
        assert.equal(big.getModelSrc ? true : false, true);

        const small = new Image();
        small.imageId = 'img_small';
        small.format = 'png';
        small.base64 = toBase64(pngHeader(320, 240));
        assert.equal(small.modelSourceDecision().reason, 'base64');

        // 图床 + 变体能力：给 /m URL（外部地址可用）
        const hosted = new Image();
        hosted.imageId = 'img_hosted';
        hosted.hostedId = 'b'.repeat(64);
        hosted.hostedUrl = '/i/' + 'b'.repeat(64);
        hosted.format = 'png';
        const decision = hosted.modelSourceDecision({ baseUrl: 'https://api.example.com' });
        assert.equal(decision.kind, 'url');
        assert.equal(decision.src, 'http://public-host:46680/m/' + 'b'.repeat(64) + '?max=2048');

        // 模型不可用：不再产出图片块
        hosted.modelUnsafe = true;
        assert.equal(hosted.modelSourceDecision().kind, 'none');
        acceptUnsafeCleanup();
    },

    async testPrepareModelInlineUsesVariant(): Promise<void> {
        useHost('http://test-host:46680');
        setCapabilities(['model-variant']);
        const origFetch = (globalThis as any).fetch;
        const calls: string[] = [];
        (globalThis as any).fetch = async (url: string) => {
            calls.push(String(url));
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    base64: toBase64(pngHeader(1024, 512)),
                    format: 'png',
                    mime: 'image/png',
                    w: 1024,
                    h: 512,
                }),
            };
        };
        const img = new Image();
        img.imageId = 'img_prefetch';
        img.hostedId = 'c'.repeat(64);
        img.hostedUrl = '/i/' + 'c'.repeat(64);
        img.format = 'png';
        try {
            const url = await img.prepareModelInline(2048);
            assert.ok(url.startsWith('data:image/png;base64,'), '预取结果应是 data URI');
            assert.equal(calls.length, 1, '应请求一次 /m/<id>/b64');
            assert.ok(calls[0].includes('/m/' + 'c'.repeat(64) + '/b64?max=2048'), '应走模型变体 b64 出口');
            assert.equal(img.width, 1024, '预取应带回尺寸');
            assert.equal(img.height, 512);
        } finally {
            (globalThis as any).fetch = origFetch;
        }
    },
};

function acceptUnsafeCleanup(): void {
    // 占位：Image 静态状态在测试间可能残留，显式清理
    delete (Image as any).imageMap['img_hosted'];
    delete (Image as any).imageMap['img_big'];
    delete (Image as any).imageMap['img_small'];
    restoreHost();
}
