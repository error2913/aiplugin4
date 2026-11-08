// 纯海豹 API 的图片下载取字节（叶子，L2）：fetch(url) → text() → btoa() 一次成型。
//
// 为什么必须这么做（issue #162 / 设计 §2）：
//   goja 的 fetch 只能读文本；text() 返回的是 Go 侧 imported 字符串，
//   直接整体作为 btoa 的唯一实参时，goja 会走 Export() 拿到**原始字节**（无损）；
//   一旦参与任何字符串拼接/切片/JSON 化/split-join，就会被 unistring 扫描成 UTF-8 字符串，
//   高字节被替换成 U+FFFD，base64 随之损坏。所以本模块只允许 `btoa(<text 值>)` 这一种写法。
//
// 依赖纪律：只 import 同层/低层（logger、utils/*、resource/image_url）；
// 不 import config（不需要配置），不 import resource/image.ts（避免环），不 import utils/web.ts（会拉进 model 层）。
import { logger } from "../logger";
import { withDeadline } from "../utils/timeout";
import { decodeUrlHtmlEntities } from "../utils/url";

import { isPermanentHttpStatus } from "./image_url";

const log = logger.withTag('image');

/** 默认超时（含重定向总预算；不含并发排队时间） */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 单图字节上限（防合并转发几十张大图把 goja 堆打爆）；0 或负数 = 不限 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 最多**跟随**的重定向次数（总请求数 ≤ MAX_REDIRECTS + 1 = 4） */
export const MAX_REDIRECTS = 3;
/** 并发下载上限：与图床上传并发（image_host.ts）分开，互不挤占 */
const MAX_CONCURRENCY = 2;

export interface FetchedImage {
    base64: string;
    format: string;
    contentType: string;
    /** 解码后字节数（base64 长度反推） */
    bytes: number;
    /** 最终响应状态码 */
    status: number;
    /** 最终 URL（跟随重定向后） */
    finalUrl: string;
}

/** 失败类别：调用方据此决定「是否计数 / 是否判永久」，**不要靠匹配 error 文本** */
export type ImageFetchFailKind =
    | 'bad-url'        // 非 http(s) / 含非法字符 → permanent
    | 'no-btoa'        // 运行时缺 btoa → **不计数、不判永久**
    | 'network'        // fetch reject / 超时
    | 'http'           // 非 2xx
    | 'redirect'       // 3xx 异常（缺 Location / 超跳数）
    | 'oversize'       // 超过 maxBytes → **不计数**
    | 'empty'          // 响应体为空
    | 'format'         // 非图片 / 格式无法识别
    | 'internal';      // btoa 抛错等兜底

export type ImageFetchResult =
    | { ok: true; data: FetchedImage }
    | { ok: false; error: string; permanent: boolean; kind: ImageFetchFailKind; status?: number };

// ---- 并发闸门（照 image_host.ts 的形态，模块级） ----
let activeFetches = 0;
const fetchWaiters: Array<() => void> = [];

async function withGlobalSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (activeFetches < MAX_CONCURRENCY) {
        activeFetches++;
    } else {
        // ★ 唤醒后必须自己占槽（image_host.ts 同款）；漏写会让并发上限被突破
        await new Promise<void>(resolve => fetchWaiters.push(resolve));
        activeFetches++;
    }
    try {
        return await fn();
    } finally {
        activeFetches = Math.max(0, activeFetches - 1);
        const next = fetchWaiters.shift();
        if (next) next();
    }
}

/** 测试用：清空并发计数 */
export function resetFetchSlotsForTest(): void {
    activeFetches = 0;
    fetchWaiters.length = 0;
}

/** base64 解出的字节数（含 padding 修正） */
function base64Bytes(b64: string): number {
    const len = b64.length;
    if (!len) return 0;
    const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(len * 3 / 4) - padding);
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 本地解出 base64 头部字节（不 import utils/web，避免把 model 层拉进依赖链） */
function decodeBase64Head(b64: string, maxBytes = 32): number[] {
    const charsNeeded = Math.ceil(maxBytes / 3) * 4;
    const slice = b64.length > charsNeeded ? b64.slice(0, charsNeeded) : b64;
    const out: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < slice.length; i++) {
        const ch = slice.charAt(i);
        const v = B64_ALPHABET.indexOf(ch);
        if (v < 0) break;    // btoa 输出不可能含非法字符（含 '=' padding），遇到即停止
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
            if (out.length >= maxBytes) return out;
        }
    }
    return out;
}

const KNOWN_FORMATS = ['png', 'jpeg', 'gif', 'webp', 'bmp'];

/** 归一化 Content-Type / 格式名：小写、去 image/ 前缀与参数、jpg→jpeg、白名单外返回空串 */
function normalizeFormat(raw: string): string {
    let value = String(raw || '').trim().toLowerCase();
    const semi = value.indexOf(';');
    if (semi !== -1) value = value.slice(0, semi);
    value = value.trim();
    if (value.indexOf('image/') === 0) value = value.slice('image/'.length);
    value = value.trim();
    if (value === 'jpg' || value === 'pjpeg') value = 'jpeg';
    if (value === 'x-png') value = 'png';
    if (value === 'x-ms-bmp') value = 'bmp';
    return KNOWN_FORMATS.indexOf(value) !== -1 ? value : '';
}

/** 按 magic 优先、Content-Type 兜底识别格式；都认不出返回空串 */
function detectFormat(head: number[], contentType: string): string {
    const at = (i: number) => (i < head.length ? head[i] : -1);
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png';
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif';
    if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
        && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp';
    if (at(0) === 0x42 && at(1) === 0x4d) return 'bmp';
    return normalizeFormat(contentType);
}

function formatMB(n: number): string {
    const bytes = Number(n) || 0;
    if (bytes <= 0) return '0KB';
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
    return `${(bytes / 1024).toFixed(1)}KB`;
}

/** 取 authority（含端口，去 userinfo）；纯正则，**禁止 new URL**（goja 无 URL 全局） */
function hostOf(url: string): string {
    const m = String(url || '').match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i);
    if (!m) return '';
    let authority = m[1] || '';
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1);
    return authority;
}

/** 日志脱敏：只留 scheme://authority/path，丢弃 query 与 userinfo，超长截断 */
function redactImageUrl(url: string): string {
    const text = String(url || '');
    const m = text.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)/i);
    let out = text;
    if (m) {
        let authority = m[2] || '';
        const at = authority.lastIndexOf('@');
        if (at !== -1) authority = authority.slice(at + 1);
        out = `${m[1]}${authority}${m[3] || ''}`;
    } else {
        const q = out.search(/[?#]/);
        if (q !== -1) out = out.slice(0, q);
    }
    if (out.length > 120) out = `${out.slice(0, 120)}…`;
    return out;
}

function errText(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function splitUrl(url: string): { origin: string; pathname: string } | null {
    const m = String(url || '').match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)/i);
    if (!m) return null;
    return { origin: m[1], pathname: m[2] || '/' };
}

/** 按 RFC 3986 相对解析把 Location 变成绝对地址；解析不出返回空串 */
function resolveRedirect(base: string, location: string): string {
    const loc = String(location || '').trim();
    if (!loc) return '';
    // 任意绝对 scheme（含 http/https、也含 ftp:/data: —— 后者原样返回交给上层判 permanent）
    if (/^[a-z][a-z0-9+.-]*:/i.test(loc)) return loc;
    const parts = splitUrl(base);
    if (!parts) return '';
    if (loc.indexOf('//') === 0) {
        const scheme = parts.origin.match(/^([a-z][a-z0-9+.-]*:)/i);
        return scheme ? `${scheme[1]}${loc}` : '';
    }
    if (loc.charAt(0) === '/') return `${parts.origin}${loc}`;
    const pathname = parts.pathname || '/';
    if (loc.charAt(0) === '?') return `${parts.origin}${pathname}${loc}`;
    const slash = pathname.lastIndexOf('/');
    const dir = slash === -1 ? '/' : pathname.slice(0, slash + 1);
    return `${parts.origin}${dir}${loc}`;
}

/** URL 是否含空白/控制字符/引号尖括号（gojax 的 urlEncode 遇到这些可能 panic，必须在入口拒绝） */
function hasIllegalUrlChar(url: string): boolean {
    for (let i = 0; i < url.length; i++) {
        const code = url.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return true;   // 空白 + C0 控制字符 + DEL
        if (code === 0x3c || code === 0x3e || code === 0x22) return true;  // < > "
    }
    return false;
}

/** 下载图片并转成 base64（永不 reject；失败以 `{ ok:false }` 返回） */
export async function fetchImageAsBase64(
    rawUrl: string,
    opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<ImageFetchResult> {
    const timeoutMs = Math.max(1, Math.floor(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const maxBytes = Math.max(0, Math.floor(opts?.maxBytes ?? DEFAULT_MAX_BYTES));

    // ① URL 预处理与合法性（不含网络）
    const url = decodeUrlHtmlEntities(String(rawUrl ?? '')).trim();
    if (!/^https?:\/\//i.test(url)) {
        return { ok: false, kind: 'bad-url', permanent: true, error: `图片地址不是 http(s)：${redactImageUrl(url) || '(空)'}` };
    }
    if (hasIllegalUrlChar(url)) {
        return { ok: false, kind: 'bad-url', permanent: true, error: `图片地址含非法字符：${redactImageUrl(url)}` };
    }

    // ② 运行时能力（不含网络，且在任何请求之前）
    //    btoa 自海豹 v1.2 起提供，正常不会有；这里只是兜住「极老内核 / 非官方 fork」
    if (typeof btoa !== 'function') {
        return { ok: false, kind: 'no-btoa', permanent: false, error: '当前海豹运行时缺少 btoa，无法把图片转成 base64（请升级海豹）' };
    }

    // ③ 并发闸门：排队时间不计入超时预算
    const run = () => withGlobalSlot(async (): Promise<ImageFetchResult> => {
        const deadline = Date.now() + timeoutMs;
        let hop = url;
        let status = 0;
        let contentType = '';
        let base64 = '';
        let text = '';

        for (let redirects = 0; ; redirects++) {
            const remain = deadline - Date.now();
            if (remain <= 0) return { ok: false, kind: 'network', permanent: false, error: `图片下载超时（${timeoutMs}ms）` };
            let response: any;
            // ④ fetch 与 btoa 必须分两段：btoa 在 try 之外
            try {
                response = await withDeadline(
                    () => fetch(hop, { method: 'GET', headers: { 'Accept': 'image/*,*/*;q=0.8' } }),
                    remain,
                );
            } catch (e) {
                const msg = errText(e);
                const timedOut = (e as any)?.code === 'TIMEOUT';
                return {
                    ok: false,
                    kind: 'network',
                    permanent: false,
                    error: timedOut
                        ? `图片下载超时（${timeoutMs}ms）`
                        : `图片下载失败（网络错误）：${msg}（${hostOf(hop)}）`,
                };
            }

            status = Number(response.status) || 0;
            const headers = response.headers;
            const location = headers && typeof headers.get === 'function' ? String(headers.get('location') || '') : '';
            contentType = headers && typeof headers.get === 'function' ? String(headers.get('content-type') || '') : '';

            // ⑤ 重定向：只读 Location，不读 body
            if (status >= 300 && status < 400) {
                if (!location || location.charAt(0) === '#') {
                    return { ok: false, kind: 'redirect', permanent: false, status, error: `图片重定向缺少 Location（HTTP ${status}）` };
                }
                const next = resolveRedirect(hop, location);
                if (!next) return { ok: false, kind: 'redirect', permanent: false, status, error: `图片重定向地址无法解析（${redactImageUrl(location)}）` };
                if (!/^https?:\/\//i.test(next)) return { ok: false, kind: 'redirect', permanent: true, status, error: `图片重定向到非 http(s) 地址：${redactImageUrl(next)}` };
                if (redirects >= MAX_REDIRECTS) return { ok: false, kind: 'redirect', permanent: false, status, error: `图片重定向次数过多（>${MAX_REDIRECTS}）` };
                hop = next;
                continue;
            }

            // ⑥ 非 2xx：不读 body
            if (!(status >= 200 && status < 300)) {
                const permanent = isPermanentHttpStatus(status);
                return { ok: false, kind: 'http', permanent, status, error: `图片下载失败：HTTP ${status}（${hostOf(hop)}）` };
            }

            // ⑦ Content-Length 预检：maxBytes=0 表示「不限」，必须先判断 maxBytes > 0
            const rawLen = headers && typeof headers.get === 'function' ? String(headers.get('content-length') || '') : '';
            const declared = rawLen ? Number(rawLen) : NaN;
            if (maxBytes > 0 && Number.isFinite(declared) && declared > maxBytes) {
                return {
                    ok: false, kind: 'oversize', permanent: false, status,
                    error: `图片过大（${formatMB(declared)} > 上限 ${formatMB(maxBytes)}）`,
                };
            }

            try {
                text = await response.text();
            } catch (_e) {
                return { ok: false, kind: 'network', permanent: false, status, error: `图片下载读取响应失败（HTTP ${status}）` };
            }
            // ★ 注意：btoa 这一行必须单独写、且**不在任何 try 块内**（上面这个 try 只包 text()）；
            //   若包进 try，海豹里 btoa 抛错会被当成网络失败吞掉，单测护栏也会假绿。
            base64 = btoa(text);
            break;
        }

        // ⑧ 后置校验
        if (!base64) return { ok: false, kind: 'empty', permanent: false, status, error: `图片下载响应体为空（HTTP ${status}）` };
        const bytes = base64Bytes(base64);
        if (maxBytes > 0 && bytes > maxBytes) {
            return { ok: false, kind: 'oversize', permanent: false, status, error: `图片过大（${formatMB(bytes)} > 上限 ${formatMB(maxBytes)}）` };
        }
        const head = decodeBase64Head(base64, 32);
        const format = detectFormat(head, contentType);
        if (!format) {
            return { ok: false, kind: 'format', permanent: false, status, error: `图片格式无法识别（Content-Type=${contentType || '缺失'}）` };
        }
        log.debug(`图片下载成功：${redactImageUrl(url)} → ${format} ${formatMB(bytes)}`);
        return { ok: true, data: { base64, format, contentType, bytes, status, finalUrl: hop } };
    });

    try {
        return await run();
    } catch (e) {
        // 唯一可能到这的是 btoa 抛错（内存不足等）；按可重试失败处理，不判永久
        return { ok: false, kind: 'internal', permanent: false, error: `图片转 base64 失败：${errText(e)}` };
    }
}
