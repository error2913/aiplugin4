// @ts-nocheck
// 纯海豹 API 图片下载单测：重点验证「text() → btoa() 字节无损」，这是 issue #162 的核心。
//
// 为什么能在这里测出真机问题：Node 的 btoa 与海豹（Go 的 base64.StdEncoding）同为 latin1 语义，
// 只要实现里对 text() 做过任何字符串加工，高位字节就会在往返中损坏/被替换，下面的字节比对必然失败。
import assert from 'node:assert/strict';

import { fetchImageAsBase64, resetFetchSlotsForTest } from '../src/resource/image_fetch';
import { isPermanentUrlError } from '../src/resource/image_url';

const NODE_BTOA = (globalThis as any).btoa;   // Node 的 latin1 btoa，与海豹同语义
const NODE_FETCH = (globalThis as any).fetch;

/** 1x1 PNG 的 magic 头（8 字节），用于「合法图片」用例，避免被判格式无法识别 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 用字节数组造一个「Latin-1 文本」响应体，模拟 goja 的 text() 返回值 */
function bytesToBody(bytes: number[]): string {
    return bytes.map(b => String.fromCharCode(b)).join('');
}
function makeResponse(status: number, body: string, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
        text: async () => body,
    };
}

// ---- 计数器：很多断言依赖「fetch 调了几次 / text() 调了几次」 ----
let fetchCalls = 0;
let textCalls = 0;
function resetCounters(): void {
    fetchCalls = 0;
    textCalls = 0;
}
function mockFetch(handler: (url: string, init: any) => any): void {
    (globalThis as any).fetch = async (url: string, init: any) => {
        fetchCalls++;
        const res = await handler(String(url), init || {});
        if (res && typeof res.text === 'function' && !res.__counted) {
            const orig = res.text.bind(res);
            res.text = async () => { textCalls++; return orig(); };
            res.__counted = true;
        }
        return res;
    };
}
function restoreAll(): void {
    (globalThis as any).fetch = NODE_FETCH;
    (globalThis as any).btoa = NODE_BTOA;
    resetFetchSlotsForTest();
    resetCounters();
}
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/** 常用：PNG magic + 少量 payload 的合法响应 */
function pngResponse(extra: number[] = [0x00], headers: Record<string, string> = {}) {
    return makeResponse(200, bytesToBody(PNG_MAGIC.concat(extra)), { 'content-type': 'image/png', ...headers });
}

export const tests: Record<string, () => Promise<void>> = {
    // ① 唯一能证明「字节无损」的用例：0x00–0xFF 全值往返
    async testImageFetchRoundTripAllByteValues() {
        try {
            const payload: number[] = [];
            for (let i = 0; i < 256; i++) payload.push(i);
            const body = PNG_MAGIC.concat(payload);
            assert.equal(body.length, 264);
            mockFetch(() => makeResponse(200, bytesToBody(body), { 'content-type': 'image/png' }));
            const r = await fetchImageAsBase64('https://example.com/a.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.deepEqual(Array.from(Buffer.from(r.data.base64, 'base64')), body);
            assert.equal(r.data.bytes, 264);
            assert.equal(r.data.format, 'png');
            assert.equal(textCalls, 1);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchUtf8LookingBodyStaysLossless() {
        try {
            const body = PNG_MAGIC.concat([0xe4, 0xb8, 0xad, 0xff, 0xfe, 0x41]);
            mockFetch(() => makeResponse(200, bytesToBody(body), { 'content-type': 'image/png' }));
            const r = await fetchImageAsBase64('https://example.com/b.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.deepEqual(Array.from(Buffer.from(r.data.base64, 'base64')), body);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchFormatDetectByMagic() {
        const cases: Array<[string, number[]]> = [
            ['png', PNG_MAGIC],
            ['jpeg', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]],
            ['gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]],
            ['webp', [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
            ['bmp', [0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00]],
        ];
        try {
            for (const [format, head] of cases) {
                resetCounters();
                // Content-Type 故意给错：magic 必须优先
                mockFetch(() => makeResponse(200, bytesToBody(head.concat([0x00, 0x00])), { 'content-type': 'text/plain' }));
                const r = await fetchImageAsBase64('https://example.com/x', { timeoutMs: 2000 });
                assert.equal(r.ok, true, `${format}: ${r.ok ? '' : r.error}`);
                assert.equal(r.data.format, format);
            }
        } finally {
            restoreAll();
        }
    },

    async testImageFetchFormatFallbackToContentType() {
        try {
            // 无已知 magic，CT 是 jpg（需归一化成 jpeg）
            mockFetch(() => makeResponse(200, bytesToBody([0x01, 0x02, 0x03, 0x04]), { 'content-type': 'image/jpg; charset=binary' }));
            const r = await fetchImageAsBase64('https://example.com/y', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(r.data.format, 'jpeg');

            // avif / svg 白名单外 → 失败（避免把模型不支持的格式塞进 data: URL）
            for (const ct of ['image/avif', 'image/svg+xml']) {
                resetCounters();
                mockFetch(() => makeResponse(200, bytesToBody([0x01, 0x02, 0x03, 0x04]), { 'content-type': ct }));
                const bad = await fetchImageAsBase64('https://example.com/z', { timeoutMs: 2000 });
                assert.equal(bad.ok, false, ct);
                assert.equal(bad.kind, 'format', ct);
                assert.equal(bad.permanent, false, ct);
            }
        } finally {
            restoreAll();
        }
    },

    async testImageFetchNonImageContentTypeIsNonPermanent() {
        try {
            mockFetch(() => makeResponse(200, '<html>login</html>', { 'content-type': 'text/html' }));
            const r = await fetchImageAsBase64('https://example.com/login', { timeoutMs: 2000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'format');
            assert.equal(r.permanent, false);
            assert.ok(r.error.includes('格式无法识别'), r.error);
        } finally {
            restoreAll();
        }
    },

    // ⑥ 非 2xx 不读 body；4xx（非 408/425/429）判永久
    async testImageFetchPermanentHttpStatuses() {
        try {
            for (const status of [400, 403, 404, 410]) {
                resetCounters();
                mockFetch(() => makeResponse(status, 'should not be read', { 'content-type': 'text/plain' }));
                const r = await fetchImageAsBase64('https://example.com/p.png', { timeoutMs: 2000 });
                assert.equal(r.ok, false, `status ${status}`);
                assert.equal(r.kind, 'http', `status ${status}`);
                assert.equal(r.permanent, true, `status ${status} 应判永久`);
                assert.equal(r.status, status);
                assert.equal(fetchCalls, 1);
                assert.equal(textCalls, 0, `status ${status} 不应读 body`);
            }
        } finally {
            restoreAll();
        }
    },

    async testImageFetchTransientHttpStatuses() {
        try {
            for (const status of [408, 425, 429, 500, 502, 503]) {
                resetCounters();
                mockFetch(() => makeResponse(status, 'nope', { 'content-type': 'text/plain' }));
                const r = await fetchImageAsBase64('https://example.com/t.png', { timeoutMs: 2000 });
                assert.equal(r.ok, false, `status ${status}`);
                assert.equal(r.kind, 'http', `status ${status}`);
                assert.equal(r.permanent, false, `status ${status} 应为非永久`);
                assert.equal(textCalls, 0, `status ${status} 不应读 body`);
            }
        } finally {
            restoreAll();
        }
    },

    async testImageFetchEmptyBodyIsNonPermanent() {
        try {
            mockFetch(() => makeResponse(200, '', { 'content-type': 'image/png' }));
            const r = await fetchImageAsBase64('https://example.com/empty.png', { timeoutMs: 2000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'empty');
            assert.equal(r.permanent, false);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectAbsolute() {
        try {
            mockFetch((url: string) => url === 'https://a.test/1.png'
                ? makeResponse(302, '', { location: 'https://cdn.test/2.png' })
                : pngResponse());
            const r = await fetchImageAsBase64('https://a.test/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(r.data.finalUrl, 'https://cdn.test/2.png');
            assert.equal(fetchCalls, 2);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectProtocolRelative() {
        try {
            mockFetch((url: string) => url === 'https://a.test/1.png'
                ? makeResponse(301, '', { location: '//cdn.test/2.png' })
                : pngResponse());
            const r = await fetchImageAsBase64('https://a.test/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(r.data.finalUrl, 'https://cdn.test/2.png');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectAbsolutePath() {
        try {
            mockFetch((url: string) => url === 'https://a.test/dir/1.png'
                ? makeResponse(302, '', { location: '/other/2.png' })
                : pngResponse());
            const r = await fetchImageAsBase64('https://a.test/dir/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(r.data.finalUrl, 'https://a.test/other/2.png');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectQueryOnly() {
        try {
            mockFetch((url: string) => url === 'https://a.test/1.png?x=1'
                ? makeResponse(302, '', { location: '?y=2' })
                : pngResponse());
            const r = await fetchImageAsBase64('https://a.test/1.png?x=1', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(r.data.finalUrl, 'https://a.test/1.png?y=2');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectRelative() {
        try {
            const seen: string[] = [];
            mockFetch((url: string) => {
                seen.push(url);
                return url === 'https://a.test/dir/1.png'
                    ? makeResponse(302, '', { location: '2.png' })
                    : pngResponse();
            });
            const r = await fetchImageAsBase64('https://a.test/dir/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(seen[1], 'https://a.test/dir/2.png');
            assert.equal(r.data.finalUrl, 'https://a.test/dir/2.png');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectLimit() {
        try {
            mockFetch((url: string) => {
                const m = url.match(/n=(\d+)/);
                const n = m ? Number(m[1]) : 0;
                return makeResponse(302, '', { location: `https://a.test/loop/n=${n + 1}` });
            });
            const r = await fetchImageAsBase64('https://a.test/loop/n=0', { timeoutMs: 5000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'redirect');
            assert.equal(r.permanent, false);
            assert.ok(r.error.includes('重定向次数过多'), r.error);
            // 首个 + 3 次跟随 = 4 次请求
            assert.equal(fetchCalls, 4);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectWithoutLocation() {
        try {
            mockFetch(() => makeResponse(302, '', {}));
            const r = await fetchImageAsBase64('https://a.test/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'redirect');
            assert.equal(r.permanent, false);
            assert.equal(textCalls, 0);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchRedirectToNonHttpIsPermanent() {
        try {
            mockFetch(() => makeResponse(302, '', { location: 'ftp://x/y.png' }));
            const r = await fetchImageAsBase64('https://a.test/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'redirect');
            assert.equal(r.permanent, true);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchNonHttpUrlIsPermanentAndNoFetch() {
        try {
            mockFetch(() => pngResponse());
            for (const bad of ['ftp://x/a.png', 'not a url', 'https://a.test/a b.png']) {
                resetCounters();
                const r = await fetchImageAsBase64(bad, { timeoutMs: 2000 });
                assert.equal(r.ok, false, bad);
                assert.equal(r.permanent, true, bad);
                assert.equal(r.kind, 'bad-url', bad);
                assert.equal(fetchCalls, 0, bad);
            }
        } finally {
            restoreAll();
        }
    },

    async testImageFetchNoBtoaIsNonPermanentAndNoFetch() {
        try {
            mockFetch(() => pngResponse());
            delete (globalThis as any).btoa;
            const r = await fetchImageAsBase64('https://a.test/1.png', { timeoutMs: 2000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'no-btoa');
            assert.equal(r.permanent, false);
            assert.ok(r.error.includes('btoa'), r.error);
            assert.equal(fetchCalls, 0, '缺 btoa 时不应发起任何请求');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchTimeoutWhenSlow() {
        try {
            mockFetch(() => new Promise(() => { /* 永不 settle */ }));
            const r = await fetchImageAsBase64('https://a.test/slow.png', { timeoutMs: 30 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'network');
            assert.equal(r.permanent, false);
            assert.ok(r.error.includes('超时'), r.error);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchMaxBytesByContentLength() {
        try {
            mockFetch(() => makeResponse(200, bytesToBody(PNG_MAGIC), {
                'content-type': 'image/png',
                'content-length': '999999',
            }));
            const r = await fetchImageAsBase64('https://a.test/big.png', { timeoutMs: 2000, maxBytes: 1000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'oversize');
            assert.equal(r.permanent, false);
            assert.equal(textCalls, 0, 'Content-Length 预检失败时不应读 body');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchMaxBytesByBase64Length() {
        try {
            // 不声明 content-length，body 实际 2000+ 字节
            const body = PNG_MAGIC.concat(new Array(2000).fill(0x41));
            mockFetch(() => makeResponse(200, bytesToBody(body), { 'content-type': 'image/png' }));
            const r = await fetchImageAsBase64('https://a.test/big2.png', { timeoutMs: 2000, maxBytes: 1000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'oversize');
            assert.equal(r.permanent, false);
            assert.equal(textCalls, 1);
        } finally {
            restoreAll();
        }
    },

    // 锁住「maxBytes=0 表示不限」语义（v1.0 的 Content-Length 预检漏了 maxBytes > 0 会让此例失败）
    async testImageFetchMaxBytesZeroMeansUnlimited() {
        try {
            mockFetch(() => makeResponse(200, bytesToBody(PNG_MAGIC), {
                'content-type': 'image/png',
                'content-length': '5000000',
            }));
            const r = await fetchImageAsBase64('https://a.test/any.png', { timeoutMs: 2000, maxBytes: 0 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchMaxBytesZeroWithNoContentLength() {
        try {
            const body = PNG_MAGIC.concat(new Array(5 * 1024 * 1024).fill(0x41));
            mockFetch(() => makeResponse(200, bytesToBody(body), { 'content-type': 'image/png' }));
            const r = await fetchImageAsBase64('https://a.test/huge.png', { timeoutMs: 20000, maxBytes: 0 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(r.data.bytes, body.length);
        } finally {
            restoreAll();
        }
    },

    // INV-2 护栏：btoa 收到的必须是 text() 返回的**同一个对象**。
    // 任何 trim()/slice()/split().join('')/String(text)/模板串都会产生新字符串 → 身份断言失败。
    async testImageFetchBtoaReceivesRawTextOnly() {
        try {
            const boxed = new String(bytesToBody(PNG_MAGIC.concat([0xff, 0x00, 0x41]))) as any;
            let btoaCalled = 0;
            let seenArg: any = null;
            (globalThis as any).btoa = (s: any) => {
                btoaCalled++;
                seenArg = s;
                return NODE_BTOA(String(s));
            };
            mockFetch(() => ({
                ok: true,
                status: 200,
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
                text: async () => boxed,
            }));
            const r = await fetchImageAsBase64('https://a.test/raw.png', { timeoutMs: 2000 });
            assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(btoaCalled, 1, 'btoa 应恰好被调用一次');
            assert.equal(seenArg, boxed, 'btoa 收到的实参必须与 text() 返回的是同一个对象（不得被加工）');
        } finally {
            restoreAll();
        }
    },

    async testImageFetchLatin1HighBytes() {
        try {
            for (const tail of [0xff, 0x00]) {
                resetCounters();
                const body = PNG_MAGIC.concat([tail]);
                mockFetch(() => makeResponse(200, bytesToBody(body), { 'content-type': 'image/png' }));
                const r = await fetchImageAsBase64('https://a.test/latin1.png', { timeoutMs: 2000 });
                assert.equal(r.ok, true, r.ok ? '' : r.error);
                const expected = Buffer.from(body).toString('base64');
                assert.equal(r.data.base64, expected);
            }
        } finally {
            restoreAll();
        }
    },

    async testImageFetchConcurrencyCappedAtTwo() {
        try {
            let inflight = 0;
            let peak = 0;
            mockFetch(async () => {
                inflight++;
                peak = Math.max(peak, inflight);
                await sleep(20);
                inflight--;
                return pngResponse();
            });
            const jobs = [];
            for (let i = 0; i < 5; i++) jobs.push(fetchImageAsBase64(`https://a.test/c${i}.png`, { timeoutMs: 5000 }));
            const results = await Promise.all(jobs);
            for (const r of results) assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(peak, 2, `并发峰值应为 2，实际 ${peak}`);
        } finally {
            restoreAll();
        }
    },

    // 错峰场景：专抓 withGlobalSlot 漏写「唤醒后 activeFetches++」的实现
    async testImageFetchConcurrencyCappedWhenStaggered() {
        try {
            let inflight = 0;
            let peak = 0;
            let releaseFirst: () => void = () => {};
            let firstHold = true;
            mockFetch(async () => {
                inflight++;
                peak = Math.max(peak, inflight);
                if (firstHold) {
                    firstHold = false;
                    await new Promise<void>(resolve => { releaseFirst = resolve; });
                } else {
                    await sleep(20);
                }
                inflight--;
                return pngResponse();
            });
            const p1 = fetchImageAsBase64('https://a.test/s1.png', { timeoutMs: 5000 });
            const p2 = fetchImageAsBase64('https://a.test/s2.png', { timeoutMs: 5000 });
            await sleep(10);                     // 让 p1 占住槽位
            const p3 = fetchImageAsBase64('https://a.test/s3.png', { timeoutMs: 5000 });
            await sleep(10);
            releaseFirst();                       // 释放第一个
            const results = await Promise.all([p1, p2, p3]);
            for (const r of results) assert.equal(r.ok, true, r.ok ? '' : r.error);
            assert.equal(peak, 2, `错峰并发峰值应为 2，实际 ${peak}`);
        } finally {
            restoreAll();
        }
    },

    async testImageFetchNetworkErrorNonPermanent() {
        try {
            mockFetch(() => { throw new Error('dial tcp: connection refused'); });
            const r = await fetchImageAsBase64('https://a.test/refused.png', { timeoutMs: 2000 });
            assert.equal(r.ok, false);
            assert.equal(r.kind, 'network');
            assert.equal(r.permanent, false);
            assert.ok(r.error.includes('网络错误'), r.error);
        } finally {
            restoreAll();
        }
    },

    // 原 image.ts 里的「错误正文是否永久」判定搬到这里（image_url 仍是唯一来源）
    async testImageFetchIsPermanentUrlErrorText() {
        const cases: Array<[string, boolean]> = [
            ['400 Client Error: Bad Request for url: https://x/y', true],
            ['429 Client Error: Too Many Requests', false],
            ['408 Client Error: Request Timeout', false],
            ['425 Client Error: Too Early', false],
            ['{"error":"fetch_failed","upstream_status":400}', true],
            ['{"error":"fetch_failed","upstream_status":429}', false],
            ['download url has expired', true],
            ['retcode: -5503007', true],
            ['random text without status', false],
        ];
        for (const [text, expected] of cases) {
            assert.equal(isPermanentUrlError(text), expected, text);
        }
    },
};
