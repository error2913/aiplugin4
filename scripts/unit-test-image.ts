// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：image 域，14 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Image, Logger, PNG_MAGIC, assert,
    buildMultimodalContent, collectImageUrls, ext, imageResponse,
    isImageDownloadFailure, restoreImageTestConfig, revive, setupImageTestConfig,
    textToMultimodalContent,
} from './unit-test-helpers';
import { resetBtoaWarnForTest } from '../src/resource/image';

export const tests: Record<string, () => void | Promise<void>> = {
/** Image.urlToBase64 成功（纯海豹直连）：写入 base64/format 并复位失败标记 */
    async testImageUrlToBase64Success(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => {
            fetchCount++;
            return imageResponse(PNG_MAGIC);
        };
        try {
            const img = new Image();
            img.imageId = 'img_success';
            img.url = 'https://example.com/a.png';
            await img.urlToBase64();
            assert.equal(fetchCount, 1, '成功应请求一次图片地址');
            assert.equal(img.base64, Buffer.from(PNG_MAGIC).toString('base64'), '直连应拿到原始字节（无损）');
            assert.equal(img.format, 'png');
            assert.equal(img.base64Failed, false, '成功后失败标记应为 false');
            assert.equal(img.base64FailedAt, 0, '成功后失败时间戳应清空');
            assert.equal(img.base64FailedCount, 0, '成功后失败次数应清零');
            assert.equal(img.type, 'base64');
        } finally {
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** Image.urlToBase64 失败（可重试类，如 500）：落失败标记，1 小时冷却期内不再重复请求。
     *  注：4xx 属永久失效，见 testImageUrlToBase64ExpiredIsPermanent */
    async testImageUrlToBase64FailureMarksAndSkips(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => {
            fetchCount++;
            return {
                ok: false,
                status: 500,
                headers: { get: () => null },
                text: async () => 'backend unreachable'
            };
        };
        try {
            const img = new Image();
            img.imageId = 'img_fail';
            img.url = 'https://expired.qq.com/x.png';
            await img.urlToBase64();
            assert.equal(fetchCount, 1, '首次失败应请求一次图片地址');
            assert.equal(img.base64Failed, true, '失败后应落标记');
            assert.ok(img.base64FailedAt > 0, '失败后应记录时间戳');
            assert.equal(img.base64FailedCount, 1, '失败后连续失败次数应为 1');
            assert.equal(img.base64, '');
            assert.equal(img.type, 'url');
            // 冷却期内再次请求：不再发请求，也不再报错
            await img.urlToBase64();
            assert.equal(fetchCount, 1, '冷却期内不应再次请求');
            assert.equal(img.base64Failed, true);
            assert.equal(img.isBase64RetryBlocked(), true, '冷却期内应判定为 blocked');
        } finally {
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** Image.urlToBase64 TTL：1 小时后允许重试，重试成功清空标记 */
    async testImageUrlToBase64RetryAfterTTL(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        const origNow = Date.now;
        let fakeNow = 1000000;
        Date.now = () => fakeNow;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => {
            fetchCount++;
            if (fetchCount === 1) {
                return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'expired' };
            }
            return imageResponse(PNG_MAGIC);
        };
        try {
            const img = new Image();
            img.imageId = 'img_ttl';
            img.url = 'https://expired.qq.com/y.png';
            await img.urlToBase64();
            assert.equal(fetchCount, 1);
            assert.equal(img.base64Failed, true);
            assert.equal(img.base64FailedAt, fakeNow);
            // 59 分钟后：仍在冷却期内，不重试
            fakeNow += 59 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 1, '1 小时冷却期内不应重试');
            // 满 1 小时后：允许重试，且成功清空标记
            fakeNow += 2 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 2, '冷却期结束后应重试一次');
            assert.equal(img.base64, Buffer.from(PNG_MAGIC).toString('base64'));
            assert.equal(img.base64Failed, false);
            assert.equal(img.base64FailedAt, 0);
            assert.equal(img.base64FailedCount, 0, '重试成功后失败次数应清零');
            assert.equal(img.isBase64RetryBlocked(), false);
        } finally {
            Date.now = origNow;
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** Image.urlToBase64 并发去重：同一实例并发调用只发一次请求，请求结束释放槽位 */
    async testImageUrlToBase64ConcurrentDedupe(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        let fetchCount = 0;
        let release = () => { };
        const gate = new Promise<void>(resolve => { release = resolve; });
        (globalThis as any).fetch = async () => {
            fetchCount++;
            await gate;
            return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'expired' };
        };
        try {
            const img = new Image();
            img.imageId = 'img_dedupe';
            img.url = 'https://example.com/b.png';
            const p1 = img.urlToBase64();
            const p2 = img.urlToBase64();
            assert.equal(fetchCount, 1, '并发调用应共享同一次请求');
            release();
            await Promise.all([p1, p2]);
            assert.equal(fetchCount, 1, '去重后只请求一次');
            assert.equal(img.base64Failed, true);
            assert.equal(img.base64FailedCount, 1, '失败后连续失败次数应为 1');
            // 请求结束后去重槽位应释放：手动清除失败标记（模拟冷却期结束）后应重新请求
            img.base64Failed = false;
            img.base64FailedAt = 0;
            await img.urlToBase64();
            assert.equal(fetchCount, 2, '请求结束后去重槽位应释放并重新请求');
        } finally {
            release();
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** 多模态构建：转换失败（可重试类，如 5xx）后保留原 URL（方案 A），冷却期内不再重复请求 */
    async testBuildMultimodalContentKeepsFailedUrl(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => {
            fetchCount++;
            return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'unavailable' };
        };
        const img = new Image();
        img.imageId = 'img_mm1';
        img.url = 'https://expired.qq.com/mm.png';
        (Image as any).imageMap['img_mm1'] = img;
        try {
            const message = { role: 'user', text: '看看这张图[img:img_mm1]' } as any;
            const parts: any[] = await buildMultimodalContent(message);
            assert.equal(fetchCount, 1, '首次构建应请求一次转换');
            assert.equal(img.base64Failed, true);
            const imagePart = parts.find((p: any) => p.type === 'image_url');
            assert.ok(imagePart, '失败后应保留 image_url 内容块（方案 A）');
            assert.equal(imagePart.image_url.url, 'https://expired.qq.com/mm.png', '失败后应保留原 URL');
            // 冷却期内再次构建：不再请求转换，仍保留原 URL
            const parts2: any[] = await buildMultimodalContent(message);
            assert.equal(fetchCount, 1, '冷却期内再次构建不应请求转换');
            const imagePart2 = parts2.find((p: any) => p.type === 'image_url');
            assert.equal(imagePart2.image_url.url, 'https://expired.qq.com/mm.png');
        } finally {
            delete (Image as any).imageMap['img_mm1'];
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** Image 新字段持久化：revive 恢复 base64Failed/base64FailedAt，缺字段回退默认值 */
    testImageReviveKeepsFailMarker(): void {
        const failedAt = Date.now() - 1000;
        const img = revive(Image, { imageId: 'x1', url: 'https://example.com/c.png', base64Failed: true, base64FailedAt: failedAt, base64FailedCount: 2 });
        assert.equal(img.base64Failed, true);
        assert.equal(img.base64FailedAt, failedAt);
        assert.equal(img.isBase64RetryBlocked(), true, '持久化的失败标记应让冷却期生效');
        assert.equal(img.base64FailedCount, 2, '持久化的失败次数应恢复');
        const img2 = revive(Image, { imageId: 'x2', url: 'https://example.com/d.png' });
        assert.equal(img2.base64Failed, false, '缺字段应回退默认 false');
        assert.equal(img2.base64FailedAt, 0, '缺字段应回退默认 0');
        assert.equal(img2.base64FailedCount, 0, '缺字段应回退默认 0');
        assert.equal(img2.isBase64RetryBlocked(), false);
        const img3 = revive(Image, { imageId: 'x3', url: 'https://example.com/e.png', base64Failed: true, base64FailedAt: 1, base64FailedCount: 3 });
        assert.equal(img3.base64FailedCount, 3, '持久化的永久阻断次数应恢复');
        assert.equal(img3.isBase64RetryBlocked(), true, '持久化的永久阻断应生效（即使时间戳早已超过冷却期）');
    }
,

    /** Image.urlToBase64 永久阻断：连续失败达上限后，即使冷却期已过也不再重试 */
    async testImageUrlToBase64PermanentBlockAfterMax(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        const origNow = Date.now;
        let fakeNow = 1000000;
        Date.now = () => fakeNow;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => {
            fetchCount++;
            return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'expired' };
        };
        try {
            const img = new Image();
            img.imageId = 'img_perm';
            img.url = 'https://expired.qq.com/perm.png';
            // 第 1 次失败：计数 1，进入 1 小时冷却
            await img.urlToBase64();
            assert.equal(fetchCount, 1);
            assert.equal(img.base64FailedCount, 1);
            // 冷却期内不重试
            fakeNow += 59 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 1, '冷却期内不应重试');
            // 1 小时后重试：第 2 次失败
            fakeNow += 2 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 2);
            assert.equal(img.base64FailedCount, 2);
            // 再过 1 小时重试：第 3 次失败 → 达到上限，永久阻断
            fakeNow += 2 * 60 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 3);
            assert.equal(img.base64FailedCount, 3);
            assert.equal(img.isBase64RetryBlocked(), true, '达到上限后应永久阻断');
            // 即使时间远超冷却期（100 天后），也不再请求
            fakeNow += 100 * 24 * 60 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 3, '永久阻断后不应再请求后端');
            assert.equal(img.isBase64RetryBlocked(), true);
            // 手动清掉冷却标记也不能恢复（计数仍达上限）
            img.base64Failed = false;
            img.base64FailedAt = 0;
            assert.equal(img.isBase64RetryBlocked(), true, '永久阻断与冷却时间无关');
            await img.urlToBase64();
            assert.equal(fetchCount, 3, '永久阻断后手动清标记也不应请求');
        } finally {
            Date.now = origNow;
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** QQ 图床临时直链识别：NT 多媒体链接/带 rkey/各图床域名命中，头像与普通公网 URL 不命中 */
    testImageTemporaryUrlDetection(): void {
        assert.equal(Image.isTemporaryUrl('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=x&spec=0&rkey=y'), true, 'NT 多媒体直链应命中');
        assert.equal(Image.isTemporaryUrl('https://gchat.qpic.cn/gchatpic_new/1/2-3-4/0'), true, '群图床应命中');
        assert.equal(Image.isTemporaryUrl('https://c2cpicdw.qpic.cn/offpic_new/1//2-3/0'), true, '私聊图床应命中');
        assert.equal(Image.isTemporaryUrl('https://example.com/a.png?rkey=abc'), true, '带 rkey 的链接应命中');
        assert.equal(Image.isTemporaryUrl('https://q1.qlogo.cn/g?b=qq&nk=12345&s=640'), false, '头像域名不应命中');
        assert.equal(Image.isTemporaryUrl('https://example.com/a.png'), false, '普通公网图片不应命中');
        assert.equal(Image.isTemporaryUrl(''), false, '空 URL 不应命中');
        assert.equal(Image.isTemporaryUrl('not a url'), false, '非法 URL 不应崩溃');
    }
,

    /** 过期直链（直连返回 4xx）→ 直接永久失效：不再重试、不再交给模型、识图跳过 */
    async testImageUrlToBase64ExpiredIsPermanent(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        const origNow = Date.now;
        let fakeNow = 1000000;
        Date.now = () => fakeNow;
        let fetchCount = 0;
        const qqUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&spec=0&rkey=dead';
        (globalThis as any).fetch = async () => {
            fetchCount++;
            // 直连自己看到的就是真 4xx（不再依赖后端把上游状态写进正文）
            return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'Bad Request' };
        };
        try {
            const img = new Image();
            img.imageId = 'img_expired';
            img.url = qqUrl;
            await img.urlToBase64();
            assert.equal(fetchCount, 1);
            assert.equal(img.urlBroken, true, '4xx 应判定为 URL 已不可用');
            assert.equal(img.base64FailedCount, 3, '永久性失败应直接按达上限处理');
            assert.equal(img.isBase64RetryBlocked(), true, '永久性失败应立即阻断重试');
            assert.equal(img.isUrlUnusable(), true, '死链不应再作为 image_url 交给模型');
            // 冷却期早已过去也不再重试（无意义的 3 次重试被省掉）
            fakeNow += 100 * 24 * 60 * 60 * 1000;
            await img.urlToBase64();
            assert.equal(fetchCount, 1, '永久失效后不应再请求');
            // 429/5xx 属可重试类：不应被误判为永久失效
            const rate = new Image();
            rate.imageId = 'img_rate';
            rate.url = 'https://example.com/rate.png';
            (globalThis as any).fetch = async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'Too Many Requests' });
            await rate.urlToBase64();
            assert.equal(rate.urlBroken, false, '429 限速不应判定为永久失效');
            assert.equal(rate.base64FailedCount, 1, '限速失败应按可重试计数');
        } finally {
            Date.now = origNow;
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** 失败路径不烧配额：404→3 次判永久；200-非图片→只计数 1（非永久）；缺 btoa→计数 0（仅冷却） */
    async testImageFailurePathsDoNotBurnQuota(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        const origBtoa = (globalThis as any).btoa;
        const logs: string[] = [];
        // 「缺 btoa 只提示一次」是 src 里的模块级标志：不复位的话（其它用例/其它文件先触发过）
        // 这里就永远等不到那条日志，断言表现为莫名其妙的 0 !== 1
        resetBtoaWarnForTest();
        // 必须拦截 emit（withTag() 返回的 logger 直接调用 emit，绕过静态 warning）
        const origEmit = (Logger as any).emit;
        (Logger as any).emit = (level: string, ...data: any[]) => { logs.push(data.map(String).join(' ')); };
        try {
            // ① 直连 404：判永久，直接按达上限
            (globalThis as any).fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => 'Not Found' });
            const dead = new Image();
            dead.imageId = 'img_q1';
            dead.url = 'https://example.com/dead.png';
            await dead.urlToBase64();
            assert.equal(dead.base64FailedCount, 3, '404 应直接按达上限处理');
            assert.equal(dead.urlBroken, true);

            // ② 200 但不是图片（WAF/登录页）：可重试，只计数 1，不判死链
            (globalThis as any).fetch = async () => ({
                ok: true, status: 200,
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
                text: async () => '<html>blocked</html>',
            });
            const waf = new Image();
            waf.imageId = 'img_q2';
            waf.url = 'https://example.com/waf.png';
            await waf.urlToBase64();
            assert.equal(waf.base64FailedCount, 1, '200-非图片只应计数 1（非永久）');
            assert.equal(waf.urlBroken, false, '200-非图片不得判死链');

            // ③ 运行时缺 btoa：计数 0、仅 1h 冷却，且日志只出现一次
            delete (globalThis as any).btoa;
            logs.length = 0;
            for (const id of ['img_q3', 'img_q4']) {
                (globalThis as any).fetch = async () => imageResponse(PNG_MAGIC);
                const nb = new Image();
                nb.imageId = id;
                nb.url = `https://example.com/${id}.png`;
                await nb.urlToBase64();
                assert.equal(nb.base64FailedCount, 0, '缺 btoa 不得消耗 3 次配额');
                assert.equal(nb.urlBroken, false);
                assert.equal(nb.base64Failed, true, '仍应进 1h 冷却（避免每轮重试）');
            }
            assert.equal(logs.filter(l => l.includes('btoa')).length, 1, '缺 btoa 的提示只应出现一次');

            // ④ 错误文案不得泄露后端细节或 base64 原文
            for (const line of logs) {
                assert.equal(line.includes('backends.'), false, `日志不得含 backends.：${line}`);
                assert.equal(line.includes('base64;'), false, `日志不得含 base64 原文标记：${line}`);
            }
        } finally {
            (Logger as any).emit = origEmit;
            (globalThis as any).btoa = origBtoa;
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
            resetBtoaWarnForTest();
        }
    }
,

    /** 死链降级：URL 已确认不可用 / QQ 临时直链转换失败 → 只留文本标签，不再塞 image_url（毒消息不再毁整轮） */
    async testBuildMultimodalContentDegradesExpiredUrl(): Promise<void> {
        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => {
            fetchCount++;
            // 直连真 4xx：URL 已死
            return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'Bad Request' };
        };
        const expired = new Image();
        expired.imageId = 'img_deg1';
        expired.url = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=a&spec=0&rkey=x';
        (Image as any).imageMap['img_deg1'] = expired;
        // QQ 临时直链 + 可重试类失败（后端 5xx）：冷却期内同样按不可用降级，不再赌模型能下到
        const temp = new Image();
        temp.imageId = 'img_deg2';
        temp.url = 'https://gchat.qpic.cn/gchatpic_new/1/2-3-4/0';
        temp.base64Failed = true;
        temp.base64FailedAt = Date.now();
        temp.base64FailedCount = 1;
        (Image as any).imageMap['img_deg2'] = temp;
        try {
            const message = { role: 'user', text: '看看[img:img_deg1]和[img:img_deg2]' } as any;
            const parts: any[] = await buildMultimodalContent(message);
            assert.equal(fetchCount, 1, '只对可重试的临时直链尝试一次转换');
            assert.equal(parts.some((p: any) => p.type === 'image_url'), false, '不可用图片不应产生 image_url 内容块');
            const textOnly = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
            assert.ok(textOnly.includes('[img:img_deg1]'), '死链应保留文本标签');
            assert.ok(textOnly.includes('[img:img_deg2]'), '临时直链冷却中应保留文本标签');
            // 普通公网 URL 的失败仍保留原 URL（方案 A 不变）
            const plain = new Image();
            plain.imageId = 'img_deg3';
            plain.url = 'https://example.com/plain.png';
            plain.base64Failed = true;
            plain.base64FailedAt = Date.now();
            (Image as any).imageMap['img_deg3'] = plain;
            const parts2: any[] = await buildMultimodalContent({ role: 'user', text: '[img:img_deg3]' } as any);
            const kept = parts2.find((p: any) => p.type === 'image_url');
            assert.ok(kept, '普通公网 URL 失败后仍应保留 image_url');
            assert.equal(kept.image_url.url, 'https://example.com/plain.png');
            // imagesAsText（模型报下载失败后的重发）：URL 型图片一律降级，已转 base64 的仍可用
            const b64 = new Image();
            b64.imageId = 'img_deg4';
            b64.url = 'https://example.com/b64.png';
            b64.base64 = 'QUJD';
            b64.format = 'png';
            (Image as any).imageMap['img_deg4'] = b64;
            const parts3: any[] = await textToMultimodalContent('[img:img_deg3][img:img_deg4]', { imagesAsText: true }) as any[];
            assert.equal(parts3.filter((p: any) => p.type === 'image_url').length, 1, 'imagesAsText 下只保留 base64 图片');
            assert.ok(parts3.find((p: any) => p.type === 'image_url').image_url.url.startsWith('data:image/png;base64,'), '保留的应是 base64 图片');
        } finally {
            delete (Image as any).imageMap['img_deg1'];
            delete (Image as any).imageMap['img_deg2'];
            delete (Image as any).imageMap['img_deg3'];
            delete (Image as any).imageMap['img_deg4'];
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** 模型报「图片下载失败」后的补救：按 URL 标记对应图片为不可用并落盘，且不再请求转换 */
    async testImageMarkUrlBrokenByUrls(): Promise<void> {
        setupImageTestConfig();
        const origSet = (ext as any).storageSet;
        const writes = new Map<string, string>();
        (ext as any).storageSet = (k: string, v: string) => { writes.set(k, v); };
        const origFetch = (globalThis as any).fetch;
        let fetchCount = 0;
        (globalThis as any).fetch = async () => { fetchCount++; return { ok: false, status: 500, text: async () => '{"error":"x"}' }; };
        const img = new Image();
        img.imageId = 'img_mark';
        img.url = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=m&spec=0&rkey=m';
        (Image as any).imageMap['img_mark'] = img;
        const done = new Image();
        done.imageId = 'img_mark_done';
        done.url = 'https://example.com/done.png';
        done.base64 = 'QUJD';
        (Image as any).imageMap['img_mark_done'] = done;
        try {
            const marked = Image.markUrlBrokenByUrls([img.url, done.url, 'data:image/png;base64,AAA', '']);
            assert.equal(marked, 1, '只应标记未转 base64 且 URL 匹配的图片');
            assert.equal(img.urlBroken, true);
            assert.equal(done.urlBroken, false, '已有 base64 的图片不受影响');
            assert.equal(writes.has('image_img_mark'), true, '标记应落盘持久化');
            assert.equal(writes.has('image_img_mark_done'), false, '未标记的图片不应被写入');
            assert.equal(img.isUrlUnusable(), true);
            assert.equal(done.isUrlUnusable(), false);
            // 标记后不再请求后端（isBase64RetryBlocked 亦为 true）
            fetchCount = 0;
            await img.urlToBase64();
            assert.equal(fetchCount, 0, '已确认不可用的 URL 不应再请求后端');
            assert.equal(Image.markUrlBrokenByUrls([]), 0, '空列表直接返回 0');
        } finally {
            delete (Image as any).imageMap['img_mark'];
            delete (Image as any).imageMap['img_mark_done'];
            (ext as any).storageSet = origSet;
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** 收集请求体里的图片 URL：跳过纯文本内容与 data: 图片，供「模型下载失败」定位并降级 */
    testCollectImageUrls(): void {
        const messages: any[] = [
            { role: 'system', content: '你是骰娘' },
            { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'https://multimedia.nt.qq.com.cn/download?rkey=1' } }] },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
            { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'https://example.com/tool.png' } }] },
        ];
        assert.deepEqual(collectImageUrls(messages as any), [
            'https://multimedia.nt.qq.com.cn/download?rkey=1',
            'https://example.com/tool.png',
        ]);
        assert.deepEqual(collectImageUrls([]), []);
        assert.deepEqual(collectImageUrls([{ role: 'user', content: '纯文本' }] as any), []);
    }
,

    /** 图片下载失败识别：命中线上报错原文，不误伤普通 400/文本错误 */
    testIsImageDownloadFailure(): void {
        assert.equal(isImageDownloadFailure('.messages[28].image[0]: Failed to download image from https://multimedia.nt.qq.com.cn/download?rkey=x'), true, '应命中线上原文');
        assert.equal(isImageDownloadFailure('Error while downloading image'), true);
        assert.equal(isImageDownloadFailure('unable to download the image'), true);
        assert.equal(isImageDownloadFailure('图片下载失败'), true);
        assert.equal(isImageDownloadFailure('请求失败! 状态码: 400\n响应体:{"error":{"message":"messages[0]: invalid max_tokens"}}'), false, '普通参数错误不应命中');
        assert.equal(isImageDownloadFailure(''), false);
    }
};
