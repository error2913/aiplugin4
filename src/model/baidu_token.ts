// 百度 AI 开放平台 access_token 的获取与缓存。
//
// 为什么需要它：百度语音/生图的接口不吃「API Key」本身，而是吃 access_token
// （用 API Key + Secret Key 去 oauth/2.0/token 换，有效期 30 天）。而本插件的「api连接」
// 只有 api_key 一个密钥字段（不为个别服务商新增字段），所以约定：
//   api_key = "APIKey:SecretKey"    → 插件自动换取并缓存 access_token，骰主只填这两个密钥即可
//   api_key = "<access_token>"      → 原样当令牌用（老写法/手头已有令牌时）
//
// 缓存按「连接 + 密钥」为键，只存内存（token 不落盘），过期前 5 分钟视为失效重新换取；
// 同一连接的并发请求共享同一次换取（in-flight 去重），避免重复打鉴权接口。
import { logger } from "../logger";

const log = logger.withTag('model');

/** 百度 OAuth 换取 access_token 的端点是固定的，与业务接口 host 无关 */
export const BAIDU_TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token';

/** 提前量：剩余有效期少于该值就重新换取（避免边界上刚好过期） */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** 换取失败时的缓存时长：避免每次请求都去撞鉴权接口 */
const FAILURE_TTL_MS = 60 * 1000;

interface TokenEntry {
    token: string;
    /** 绝对过期时间戳（毫秒） */
    expiresAt: number;
}

const cache = new Map<string, TokenEntry>();
const inflight = new Map<string, Promise<string>>();

/** 仅供单元测试：清空缓存与 in-flight */
export function resetBaiduTokenCacheForTest(): void {
    cache.clear();
    inflight.clear();
}

/**
 * api_key 是否是百度双密钥写法（`APIKey:SecretKey`）。
 * access_token 与 bce-v3 格式的 API Key 都不含冒号，故以冒号作为双密钥的判据；
 * 用反斜杠转义（如 `APIKey\:x:SecretKey`）或 `|` 分隔可表达含冒号的密钥，避免误判。
 */
export function isBaiduDoubleKey(apiKey: string): boolean {
    const raw = String(apiKey ?? '').trim();
    if (!raw || raw.indexOf(':') === -1) return false;
    return splitBaiduDoubleKey(raw) !== null;
}

/**
 * 拆分双密钥：`APIKey:SecretKey`（也接受 `APIKey|SecretKey`）。
 * 密钥本身含冒号时用 `\:` 转义；出现 2 个以上未转义的冒号视为写法非法（返回 null），
 * 此时调用方应回退到「整个字符串就是令牌」，而不是猜着拆。
 */
export function splitBaiduDoubleKey(apiKey: string): { apiKey: string; secretKey: string } | null {
    const raw = String(apiKey ?? '').trim();
    if (!raw) return null;

    // 先把转义的冒号替换成占位符，再按未转义冒号切分
    const PLACEHOLDER = '\u0000';
    const protectedRaw = raw.replace(/\\:/g, PLACEHOLDER);
    const separator = protectedRaw.indexOf(':') !== -1 ? ':' : (protectedRaw.indexOf('|') !== -1 ? '|' : '');
    if (!separator) return null;

    const parts = protectedRaw.split(separator);
    if (parts.length !== 2) return null;

    const restore = (s: string): string => s.split(PLACEHOLDER).join(':').trim();
    const id = restore(parts[0]);
    const secret = restore(parts[1]);
    if (!id || !secret) return null;
    return { apiKey: id, secretKey: secret };
}

function describeAuthError(raw: string): string {
    const text = String(raw ?? '').trim();
    if (!text) return '响应为空';
    try {
        const data = JSON.parse(text);
        const code = data?.error ? String(data.error) : '';
        const desc = data?.error_description ? String(data.error_description) : '';
        if (code || desc) return [code, desc].filter(Boolean).join(': ');
    } catch (_e) { /* 非 JSON，按原文给出 */ }
    return text.slice(0, 200);
}

/** 真正去换 token（不带缓存）；失败抛可读错误 */
async function requestBaiduToken(apiKey: string, secretKey: string): Promise<{ token: string; expiresInSec: number }> {
    const url = `${BAIDU_TOKEN_URL}?grant_type=client_credentials`
        + `&client_id=${encodeURIComponent(apiKey)}`
        + `&client_secret=${encodeURIComponent(secretKey)}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: '',
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`获取百度 access_token 失败（HTTP ${response.status}）：${describeAuthError(text)}`);
    }
    let data: any = null;
    try {
        data = JSON.parse(text);
    } catch (_e) {
        throw new Error(`获取百度 access_token 失败：响应不是合法 JSON（${text.slice(0, 200)}）`);
    }
    const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
    if (!token) {
        throw new Error(`获取百度 access_token 失败：${describeAuthError(text)}`);
    }
    const expires = Number(data?.expires_in);
    return { token, expiresInSec: Number.isFinite(expires) && expires > 0 ? expires : 30 * 24 * 3600 };
}

/**
 * 把「api连接」的 api_key 解析成可直接进请求体的令牌：
 *   - 双密钥写法 → 换取 access_token（按连接 + 密钥缓存复用）
 *   - 其他写法   → 原样返回（access_token 或 bce-v3 API Key）
 * @param scope 缓存作用域（用连接序号 + 密钥摘要，避免不同连接互相覆盖）
 */
export async function resolveBaiduToken(scope: string, apiKey: string): Promise<string> {
    const raw = String(apiKey ?? '').trim();
    if (!isBaiduDoubleKey(raw)) return raw;

    const parts = splitBaiduDoubleKey(raw);
    if (!parts) return raw;

    const cacheKey = `${scope}|${parts.apiKey}`;
    const now = Date.now();
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.token;

    const running = inflight.get(cacheKey);
    if (running) return running;

    const task = (async () => {
        const { token, expiresInSec } = await requestBaiduToken(parts.apiKey, parts.secretKey);
        cache.set(cacheKey, { token, expiresAt: Date.now() + expiresInSec * 1000 - REFRESH_MARGIN_MS });
        log.info(`已换取百度 access_token（有效期 ${expiresInSec}s，按连接缓存复用）`);
        return token;
    })();

    inflight.set(cacheKey, task);
    try {
        return await task;
    } catch (e) {
        // 失败也短暂缓存，避免同一连接连续请求时反复撞鉴权接口
        cache.set(cacheKey, { token: '', expiresAt: Date.now() + FAILURE_TTL_MS });
        throw e;
    } finally {
        inflight.delete(cacheKey);
    }
}
