// 网络请求封装（fetch）
import { ApiError, parseRetryAfterSeconds } from "../model/api_error";

import { backendAuthHeaders, backendAuthHint } from "./backend";

/** request 覆盖（由「模型规则」[request] 模板解析而来；未命中时为空） */
export interface FetchDataOverrides {
    headers?: Record<string, string>;
    authHeaderName?: string;
    contentType?: string;
    /** HTTP 方法覆盖（默认 POST） */
    method?: string;
}

/**
 * 响应读取方式：
 *   json   —— 默认，JSON.parse（对话/嵌入/识图/绝大多数生图接口）
 *   binary —— 响应体即二进制（如 TTS 音频流），读 arrayBuffer 后转 base64
 *   text   —— 响应体即纯文本
 * 由「模型规则」[response].data_type = "base64" 且未写 data_path 时判定为 binary（见 model/media.ts）。
 * binary 取数在配置了 media-fetch 后端时**直接由后端代发**（goja 读不了二进制体；不先直连，
 * 避免同一上游被打两次）；后端 url 留空 = 禁用中转，退回直连（有 arrayBuffer 的运行时可用）。
 */
export type FetchDataType = 'json' | 'binary' | 'text';

export interface FetchDataOptions extends FetchDataOverrides {
    dataType?: FetchDataType;
}

/** arrayBuffer → base64（不依赖 Buffer/btoa，兼容海豹 goja 运行时） */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        result += BASE64_CHARS[b0 >> 2];
        result += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        result += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        result += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '=';
    }
    return result;
}

/** 构造请求头：给了 auth_header_name 就原样放 key（不拼 Bearer），否则走 Authorization: Bearer */
function buildHeaders(apiKey: string, overrides?: FetchDataOverrides): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(overrides?.headers ?? {})
    };
    if (overrides?.authHeaderName) {
        // 自定义鉴权头（如 x-goog-api-key）：原样放 key，不拼 Bearer
        headers[overrides.authHeaderName] = apiKey;
    } else if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (overrides?.contentType) headers["Content-Type"] = overrides.contentType;
    return headers;
}

/** multipart/form-data 编码（goja 里没有 FormData，自行拼串；与旧 tts/tti 依赖同款实现） */
export function encodeMultipart(values: Record<string, unknown>, boundary: string): string {
    const parts: string[] = [];
    for (const key of Object.keys(values ?? {})) {
        const value = (values as Record<string, unknown>)[key];
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${text}\r\n`);
    }
    parts.push(`--${boundary}--\r\n`);
    return parts.join('');
}

/**
 * 按 content_type 编码请求体：
 *   application/json（默认）→ JSON.stringify
 *   multipart/form-data     → 自行拼串并回填带 boundary 的 Content-Type（Stability 等）
 *   x-www-form-urlencoded   → k=v&…（对象/数组值按 JSON 串后 URL 编码）
 * 调用方已给出字符串 body 时原样透传。
 */
export function encodeRequestBody(body: any, contentType: string): { body: string; contentType?: string } {
    if (typeof body === 'string') return { body };
    const type = String(contentType || '').toLowerCase();
    if (type.indexOf('multipart/form-data') !== -1) {
        const boundary = `seal-${Date.now().toString(36)}`;
        return { body: encodeMultipart(body ?? {}, boundary), contentType: `multipart/form-data; boundary=${boundary}` };
    }
    if (type.indexOf('x-www-form-urlencoded') !== -1) {
        const parts: string[] = [];
        for (const key of Object.keys(body ?? {})) {
            const value = (body as Record<string, unknown>)[key];
            const text = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
            parts.push(`${key}=${encodeURIComponent(text)}`);
        }
        return { body: parts.join('&') };
    }
    return { body: JSON.stringify(body) };
}

/** media-fetch 后端配置（url 为空 = 禁用中转） */
interface MediaFetchConfig {
    url: string;
    token: string;
}

/** 延迟读取配置：web.ts 处于底层，顶层 import Config 会形成循环依赖 */
async function mediaFetchConfig(): Promise<MediaFetchConfig> {
    const { default: Config } = await import('../config/config');
    return {
        url: String(Config.backend?.MEDIA_FETCH ?? '').trim(),
        token: String(Config.backend?.MEDIA_FETCH_TOKEN ?? '').trim(),
    };
}

/** 「没有可用的二进制读取能力」的可读错误：goja 没有 arrayBuffer，这类接口必须由后端代读 */
function mediaReadUnsupportedError(contentType: string): any {
    const hint = '可在 aiplugin4-backends 安装并启动 media-fetch 后端，并在「后端配置」里确认 backends.media-fetch.url'
        + '（不需要中转时把该 url 设为空字符串）';
    const err: any = new Error(
        `当前运行时无法读取二进制响应体（海豹 goja 的 fetch 没有 arrayBuffer），且未配置媒体中转后端；${hint}。`
        + `当前响应 Content-Type=${contentType || '(空)'}。`,
    );
    err.noRetry = true;
    return err;
}

/**
 * 经 media-fetch 后端取回二进制响应（转成 base64 返回）。
 *
 * 请求的 method/headers/body 原样透传，后端不掺和业务语义；上游若是 JSON（如带 url 字段）
 * 则原样交回，让上层的 data_path 取数逻辑照常工作 —— 与直连行为一致。
 *
 * 注意：配置了 media-fetch 时调用方应**直接**走这里；goja 读不了二进制体，
 * 若先直连一次再让后端重发，上游会被打两次（TTS 等于双倍合成/计费）。
 */
async function fetchBinaryViaBackend(
    url: string,
    headers: Record<string, string>,
    body: string,
    method: string,
    provider: string,
    cfg: MediaFetchConfig,
): Promise<any> {
    const hint = '可在 aiplugin4-backends 安装并启动 media-fetch 后端，并在「后端配置」里确认 backends.media-fetch.url';
    const endpoint = `${cfg.url.replace(/\/+$/, '')}/fetch-as-base64`;
    let proxyResp: any;
    try {
        proxyResp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...backendAuthHeaders(cfg.token),
            },
            // method 由调用方透传（模型规则可覆盖），不再硬编码 POST
            body: JSON.stringify({ url, method, headers, body }),
        });
    } catch (e) {
        const err: any = new Error(
            `无法连接媒体中转后端 ${cfg.url}：${e instanceof Error ? e.message : String(e)}；${hint}`,
        );
        err.noRetry = true;
        throw err;
    }
    const text = await proxyResp.text();
    if (proxyResp.status === 401) {
        const err: any = new Error(`媒体中转后端鉴权失败（401）：${backendAuthHint('media-fetch')}`);
        err.noRetry = true;
        throw err;
    }
    if (!proxyResp.ok) {
        // 后端 4xx/5xx：保留状态码交给上层的错误分类与重试逻辑
        throw ApiError.fromResponse(proxyResp.status, provider, String(text || '').slice(0, 500));
    }
    if (!text) throw new Error('媒体中转后端返回空响应');
    let data: any;
    try {
        data = JSON.parse(text);
    } catch (_e) {
        throw new Error(`媒体中转后端返回的不是 JSON：${String(text).slice(0, 300)}`);
    }
    if (data.error) throw new Error(`媒体中转后端出错：${data.error}`);

    // 上游本身是 JSON（例如失败时的 err_msg，或本来就返回 url 的接口）：原样交给上层按 data_path 取数
    if (data.json !== undefined && data.base64 === undefined) {
        const upstream = Number(data.upstreamStatus);
        if (Number.isFinite(upstream) && upstream >= 400) {
            // 以前由直连的 !response.ok 抛 ApiError；改为直接走后端后必须在这里补回，
            // 否则 401/402/429 不再走鉴权/余额/限流分类
            throw ApiError.fromResponse(upstream, provider, JSON.stringify(data.json));
        }
        return data.json;
    }

    if (typeof data.base64 !== 'string' || !data.base64) {
        throw new Error(`媒体中转后端未返回音频/图片数据（响应：${JSON.stringify(data).slice(0, 200)}）`);
    }
    // 上游 4xx/5xx 时后端也会带上状态码：交给上层的错误分类逻辑（鉴权/余额/限流）
    const upstream = Number(data.upstreamStatus);
    if (Number.isFinite(upstream) && upstream >= 400) {
        throw ApiError.fromResponse(upstream, provider, String(data.bodyText ?? ''), undefined);
    }
    // 与直连的 arrayBuffer 分支保持同一返回形态：**裸 base64 字符串**，
    // 这样上层的 extractMediaData / normalizeMediaData 无需为「走后端」单独分支。
    return data.base64;
}

/** 空鉴权头（api_key 为空时不要发 Authorization: Bearer，避免部分网关直接拒绝） */
export async function fetchData(
    url: string,
    apiKey: string,
    body: any,
    provider = '',
    overrides?: FetchDataOptions,
): Promise<any> {
    const headers = buildHeaders(apiKey, overrides);
    const dataType: FetchDataType = overrides?.dataType ?? 'json';
    const encoded = encodeRequestBody(body, String(overrides?.contentType || 'application/json'));
    // multipart 需要回填带 boundary 的 Content-Type
    if (encoded.contentType) headers['Content-Type'] = encoded.contentType;
    const method = overrides?.method || 'POST';

    if (dataType === 'binary') {
        // 配了 media-fetch：直接交给后端代发。goja 读不了二进制体，先直连一次再让后端重发
        // 会让上游被打两次（TTS 等于双倍合成/计费），所以这里不做「先探测 Content-Type 再重发」。
        const mediaCfg = await mediaFetchConfig();
        if (mediaCfg.url) {
            return fetchBinaryViaBackend(url, headers, encoded.body, method, provider, mediaCfg);
        }
        // 未配置 media-fetch（后端配置里 url 留空 = 禁用中转）：保留原直连逻辑——
        // 有 arrayBuffer 的运行时（Node/浏览器/测试）仍可用；goja 下会在下面给出可读报错。
    }

    const response = await fetch(url, {
        method,
        headers,
        body: encoded.body
    });

    if (!response.ok) {
        // 错误响应一律按文本读，便于分类与展示（即使期望的是二进制）
        const errText = await response.text();
        throw ApiError.fromResponse(response.status, provider, errText, parseRetryAfterSeconds(response.headers.get('Retry-After')));
    }

    if (dataType === 'binary') {
        // 服务端可能对同一端点按结果返回 JSON（成功带 URL / 失败带错误码）或二进制音频。
        // 按 content-type 自适应：JSON 交给上层按 data_path 取数，其余才当二进制转 base64。
        const ct = String(response.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') !== -1) {
            const jsonText = await response.text();
            if (!jsonText) throw new Error('响应体为空');
            try {
                return JSON.parse(jsonText);
            } catch {
                return jsonText;
            }
        }
        // 海豹 goja 的 fetch（gojax）只给 Response 实现了 text()/json()，**没有 arrayBuffer/bytes/blob**，
        // 且 text() 走 UTF-8 解码会破坏二进制字节。走到这里说明后端地址为空（显式禁用中转），
        // 只能给出可读报错。
        if (typeof (response as any).arrayBuffer !== 'function') {
            throw mediaReadUnsupportedError(ct);
        }
        const buffer = await response.arrayBuffer();
        return bytesToBase64(new Uint8Array(buffer));
    }

    const text = await response.text();
    if (!text) {
        throw new Error("响应体为空");
    }
    if (dataType === 'text') return text;

    try {
        const data = JSON.parse(text);
        if (data.error) {
            // 成功状态码但携带业务错误对象（部分网关行为）：同样走分类，便于上层按语义处理
            throw ApiError.fromResponse(response.status, provider, text);
        }
        return data;
    } catch (e) {
        if (e instanceof ApiError) throw e;
        // 期望 JSON 但拿到非 JSON（且非 ok 结构）：交给上层按 data_type 兜底
        throw new Error(`解析响应体时出错:${e instanceof Error ? e.message : String(e)}\n响应体:${text.slice(0, 500)}`);
    }
}
