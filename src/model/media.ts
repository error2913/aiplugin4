// 媒体生成（tts / image-generation）的请求编排与响应解析。
// 职责：
//   - 由「模型规则」[response] 决定取数路径（data_path）、返回类型（data_type）与是否整响应即数据；
//   - 兼容 url / base64 / hex 三种返回，统一归一出 { data, dataType }；
//   - 支持异步任务轮询（task_id_path + poll_url）；
//   - 复用 requestModel 的超时/重试/ApiError 分类，不另造网络层。
//
// 纯逻辑 + provider 调用；不依赖 seal / Config（只引用 requestModel 与类型），便于单元测试。
import { FetchDataType } from "../utils/web";

import { requestModel, RequestOverrides } from "./provider";
import { MediaModelUse } from "./types";

export interface MediaResult {
    ok: boolean;
    kind: 'tts' | 'tti';
    /** url 或 base64（按 data_type 归一后的字符串） */
    data: string;
    dataType: 'url' | 'base64';
    error?: string;
}

export interface MediaRequestSpec {
    use: MediaModelUse;
    provider: string;
    /** 模型名（用于 requestModel 的规则匹配与日志） */
    modelName: string;
    apiKey: string;
    /** 最终请求地址（已应用 [request].url 覆盖） */
    url: string;
    /** 已渲染的请求体 */
    body: Record<string, unknown>;
    /** 已合成（内置预设 ← 「模型规则」[request]）的请求覆盖：headers / auth_header_name / content_type / timeout / method */
    overrides?: RequestOverrides | null;
    /** 「模型规则」[response]（已与内置预设合并） */
    responseRule: Record<string, any>;
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

/** hex → base64 */
export function hexToBase64(hex: string): string {
    const clean = hex.replace(/\s+/g, '');
    if (clean.length === 0 || clean.length % 2 !== 0 || !HEX_RE.test(clean)) return '';
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += CHARS[b0 >> 2];
        out += CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? CHARS[b2 & 63] : '=';
    }
    return out;
}

/** 按路径取值（支持 a.b.0.c 形式） */
export function getByPath(data: any, path?: string): any {
    if (!path) return undefined;
    let cur = data;
    for (const seg of String(path).split('.')) {
        if (seg === '') continue;
        if (cur === null || cur === undefined) return undefined;
        if (Array.isArray(cur)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx)) return undefined;
            cur = cur[idx];
            continue;
        }
        if (typeof cur !== 'object') return undefined;
        cur = (cur as any)[seg];
    }
    return cur;
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/**
 * 归一媒体数据：url 原样；data: 前缀剥离；hex 转 base64；其余当 base64。
 * @param dataType 规则声明：auto / url / base64 / hex
 */
export function normalizeMediaData(value: unknown, dataType?: string): { data: string; dataType: 'url' | 'base64' } | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    if (isHttpUrl(text)) return { data: text, dataType: 'url' };
    const declared = String(dataType || 'auto').toLowerCase();
    if (declared === 'url') return { data: text, dataType: 'url' };
    if (text.toLowerCase().startsWith('data:')) {
        const comma = text.indexOf(',');
        return comma >= 0 ? { data: text.slice(comma + 1), dataType: 'base64' } : null;
    }
    if (declared === 'hex' || (declared === 'auto' && HEX_RE.test(text) && text.length % 2 === 0 && text.length >= 16)) {
        const converted = hexToBase64(text);
        if (converted) return { data: converted, dataType: 'base64' };
    }
    if (declared === 'base64' || BASE64_RE.test(text)) return { data: text, dataType: 'base64' };
    return null;
}

/** 规则声明的返回类型 → HTTP 取数方式 */
export function responseDataType(rule: Record<string, any>): FetchDataType {
    const path = typeof rule?.data_path === 'string' ? rule.data_path.trim() : '';
    if (path) return 'json';
    const declared = String(rule?.data_type || 'auto').toLowerCase();
    // 未写 data_path：base64/hex 表示"整个响应体即媒体"（如 TTS 音频流），url 表示整响应即 URL 文本
    if (declared === 'base64' || declared === 'hex') return 'binary';
    if (declared === 'url') return 'text';
    return 'json';
}

/** 未配置 data_path 时的兜底候选路径（按用途区分，覆盖常见厂商返回结构） */
const TTS_CANDIDATE_PATHS = [
    'data.audio', 'data.audio_url', 'data.url', 'data.b64_json', 'data.data',
    'output.audio', 'output.audio_url', 'output.audio.data', 'output.url',
    'output.results.0.url', 'output.results.0.audio', 'audio', 'url', 'audio_url', 'b64_json',
];
const TTI_CANDIDATE_PATHS = [
    'data.0.url', 'data.0.b64_json', 'data.0.image_url.url', 'data.url', 'data.b64_json',
    'images.0.url', 'images.0.b64_json', 'images.0', 'artifacts.0.base64',
    'output.results.0.url', 'output.results.0.b64_json', 'image', 'img_urls.0', 'url', 'b64_json',
];

/** 从响应里提取媒体数据字符串（优先 data_path，其次候选路径，最后整响应） */
export function extractMediaData(raw: any, rule: Record<string, any>, use: MediaModelUse): string | null {
    const declared = String(rule?.data_type || 'auto').toLowerCase();

    // 整响应即数据（未写 data_path 且按二进制/文本读回）
    const dataPath = typeof rule?.data_path === 'string' ? rule.data_path.trim() : '';
    if (!dataPath) {
        if (typeof raw === 'string') {
            const normalized = normalizeMediaData(raw, declared);
            return normalized ? normalized.data : null;
        }
        // 兜底：虽然没写 data_path，但响应是 JSON，仍尝试候选路径 / 单字段对象
        const candidates = use === 'tts' ? TTS_CANDIDATE_PATHS : TTI_CANDIDATE_PATHS;
        for (const path of candidates) {
            const found = normalizeMediaData(getByPath(raw, path), declared === 'auto' ? 'auto' : declared);
            if (found) return found.data;
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const values = Object.values(raw);
            if (values.length === 1) {
                const found = normalizeMediaData(values[0], declared === 'auto' ? 'auto' : declared);
                if (found) return found.data;
            }
        }
        return null;
    }

    const explicit = normalizeMediaData(getByPath(raw, dataPath), declared);
    if (explicit) return explicit.data;

    const candidates = use === 'tts' ? TTS_CANDIDATE_PATHS : TTI_CANDIDATE_PATHS;
    for (const path of candidates) {
        const found = normalizeMediaData(getByPath(raw, path), declared);
        if (found) return found.data;
    }
    return null;
}

/** 从响应里提取业务错误信息（无则 null） */
export function extractMediaError(raw: any, rule: Record<string, any>): string | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') return null;
    const rulePath = typeof rule?.error_message_path === 'string' ? rule.error_message_path.trim() : '';
    if (rulePath) {
        const v = getByPath(raw, rulePath);
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    if (typeof raw.error === 'string' && raw.error.trim()) return raw.error.trim();
    if (raw.error && typeof raw.error === 'object') {
        const m = raw.error.message;
        if (typeof m === 'string' && m.trim()) return m.trim();
    }
    const code = raw.error_code ?? raw.err_no ?? raw.status_code ?? raw.code;
    if (code !== undefined && code !== null && String(code) !== '0' && String(code) !== '200') {
        const message = raw.message ?? raw.err_msg ?? raw.error_description ?? raw.msg;
        return message ? String(message) : `接口返回错误（${code}）`;
    }
    const baseResp = raw.base_resp;
    if (baseResp && Number(baseResp.status_code) !== 0) {
        return String(baseResp.status_msg || baseResp.status_code);
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function replaceTaskId(template: string, taskId: string): string {
    return String(template).split('{task_id}').join(encodeURIComponent(taskId));
}

function toUppercaseValues(v: unknown, fallback: string[]): string[] {
    if (!Array.isArray(v)) return fallback;
    const out = v.map(x => String(x).toUpperCase()).filter(x => x !== '');
    return out.length > 0 ? out : fallback;
}

/**
 * 从配置里取数值，**"没写"一律回退默认值**。
 *
 * 为什么不能直接 `Number(v)`：`Number(null)`、`Number('')`、`Number(false)` **都是 0**，
 * 连 `Number([])` 也是 0。而 `poll_interval = 0` 的语义是"不等待就轮询"——
 * 配置里一个 null（或空数组）就能把对方接口打爆。
 * 旧写法 `Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 15` 正好中招：
 * null → 0 → isFinite(0) 为真 → 0 >= 0 为真 → 间隔 0。
 *
 * 所以这里**只接受 number 与数字字符串**，其余类型（含 null/布尔/数组/对象）一律当没写。
 *
 * @param exclusive true 时要求严格大于 min（poll_max 用：0 次轮询无意义）
 *
 * 导出供单测：这个陷阱（null → 0）不看代码是发现不了的，必须有测试钉住。
 */
export function numOrDefault(v: unknown, def: number, min: number, exclusive = false): number {
    let n: number;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
    else return def;                      // null / undefined / boolean / 数组 / 对象 / 空串
    if (!Number.isFinite(n)) return def;
    return exclusive ? (n > min ? n : def) : (n >= min ? n : def);
}

/**
 * 轮询异步任务直到完成/失败/超时。
 * 仅在规则声明了 task_id_path（且响应里能取到 task_id）时启用。
 */
async function pollForMedia(spec: MediaRequestSpec, taskId: string): Promise<string | null> {
    const rule = spec.responseRule || {};
    const pollUrl = typeof rule.poll_url === 'string' ? rule.poll_url.trim() : '';
    if (!pollUrl) return null;
    const pollMax = numOrDefault(rule.poll_max, 20, 0, true);
    const intervalSec = numOrDefault(rule.poll_interval, 15, 0);
    const success = toUppercaseValues(rule.success_values, ['SUCCEEDED', 'SUCCESS', 'COMPLETED']);
    const failure = toUppercaseValues(rule.failure_values, ['FAILED', 'ERROR', 'CANCELED']);
    const statusPath = typeof rule.task_status_path === 'string' ? rule.task_status_path.trim() : '';

    for (let i = 0; i < pollMax; i++) {
        if (i > 0 && intervalSec > 0) await sleep(intervalSec * 1000);
        const url = replaceTaskId(pollUrl, taskId);
        const raw = await requestModel(url, spec.apiKey, {}, {
            provider: spec.provider,
            use: spec.use,
            modelName: spec.modelName,
            dataType: 'json',
            overrides: spec.overrides ?? undefined,
        });
        const businessError = extractMediaError(raw, rule);
        if (businessError) throw new Error(businessError);
        const status = String(getByPath(raw, statusPath) ?? getByPath(raw, 'output.task_status') ?? getByPath(raw, 'task_status') ?? getByPath(raw, 'status') ?? '').toUpperCase();
        if (failure.indexOf(status) !== -1) throw new Error(`任务失败，状态：${status}`);
        const data = extractMediaData(raw, rule, spec.use);
        if (success.indexOf(status) !== -1) {
            if (data) return data;
            throw new Error('任务已完成，但响应中未找到媒体数据');
        }
        if (data && status === '') return data;
    }
    throw new Error(`轮询超时：${pollMax} 次仍未完成`);
}

function ok(kind: 'tts' | 'tti', data: string): MediaResult {
    const normalized = normalizeMediaData(data, 'auto');
    if (normalized) return { ok: true, kind, data: normalized.data, dataType: normalized.dataType };
    // 二进制音频通常不是合法 base64 文本形态判断的强项，这里直接按 base64 收下
    return { ok: true, kind, data, dataType: 'base64' };
}

/**
 * 媒体请求失败时补一段可诊断的信息。
 *
 * 为什么需要：媒体接口 404 时**响应体常常是空的**，用户只看到一个状态码，
 * 分不清是"基址拼错了"还是"对方压根没这个接口"。实测踩过两次：
 *   · provider=dashscope + 兼容模式基址 → 拼出 .../compatible-mode/v1/api/v1/... → 404
 *   · Qwen-TTS 被当成 cosyvoice → 打到 /audio/speech → 404
 * 两次都得靠翻代码才算出来。所以这里把**最终请求地址**和**生效的 provider** 打出来 ——
 * 有这两样，拼错一眼可见。
 *
 * 只在"像是地址/接口不对"的状态码上补（404/405/501），不给业务错误（400/401/429）加噪音。
 */
export function mediaErrorHint(message: string, spec: MediaRequestSpec): string {
    const status = /状态码[:：]\s*(\d+)/.exec(message)?.[1] ?? '';

    // 400 且**响应体为空** —— 最容易让人卡住的一类：地址是对的（不是 404），
    // 但对方拒绝了请求，且一个字的解释都不给。
    // 实测：百炼在「模型与端点/请求不匹配」时常这样返回；`qwen3-tts-flash`
    // 在该部署上两个端点都只回 `{}`（模型列表里却有它 —— **列出来 ≠ 能调**）。
    //
    // 只有"空响应体"这一种 400 才补提示；**有**响应体的 400 原样返回 ——
    // 对方已经说明了原因，再叠一段我们的话只会盖过它。
    if (status === '400' && /响应体[:：]\s*\{\}\s*$/.test(message)) {
        return `${message}\n请求地址：${spec.url || ''}\n`
            + '⚠ 响应体为空：对方受理了这个地址（不是 404），但拒绝了请求，且没给原因。'
            + '百炼在「模型与端点/请求不匹配」时常常这样返回 —— **模型列表里有它不代表能这样调**。'
            + '请换同族的其他模型试（实测 `qwen-audio-3.1-tts-flash` 走原生 SpeechSynthesizer 可用，'
            + '而 `qwen3-tts-flash` 在本部署上各端点均不可用）。';
    }

    // 其余状态码只在"像是地址/接口不对"时才补，不给业务错误（400/401/429）加噪音
    if (!/^(404|405|501)$/.test(status)) return message;

    const url = spec.url || '';
    const lower = url.toLowerCase();
    const lines = [
        `请求地址：${url}`,
        `生效 provider：${spec.provider || '(空 —— 按通用 OpenAI 兼容结构拼)'}`,
    ];

    if (/qwen-audio/i.test(spec.modelName || '') && lower.includes('/compatible-mode')) {
        // 官方文档：**Qwen-Audio 不支持 OpenAI 兼容协议，仅支持 DashScope 协议**
        // （见「OpenAI Chat接口兼容」）。所以基址填得再对也没用 —— 兼容模式没有这个模型的接口。
        lines.push('⚠ 该模型属 **Qwen-Audio 系列，不支持 OpenAI 兼容协议**（官方文档：仅支持 DashScope 协议），'
            + '放在兼容模式基址下必然 404。请**另开一条原生连接**：'
            + '基址填 host 根（不带 /compatible-mode/v1），provider 填 dashscope。');
    } else if (spec.provider === 'dashscope' && lower.includes('/compatible-mode')) {
        lines.push('⚠ 基址是**兼容模式**，但 dashscope 拼的是**原生**端点 —— 两者叠加得到的是不存在的路径。'
            + '把基址改成 host 根（去掉 /compatible-mode/v1），或把 provider 改成 alibaba。');
    } else if (spec.provider === 'alibaba' && /\/api\/v1\/services\//.test(lower)) {
        lines.push('⚠ 基址是**原生**端点，但 alibaba 拼的是**兼容模式**路径 —— 这里应填 dashscope。');
    } else {
        lines.push('基址要填到**版本前缀**为止（如 https://host/api/v1 或 https://host/compatible-mode/v1）；'
            + '填成"完整接口地址"会让插件再拼一段路径上去。');
    }
    return `${message}\n${lines.join('\n')}`;
}

/** 发起一次媒体生成请求（含轮询），返回归一后的结果 */
export async function requestMedia(spec: MediaRequestSpec): Promise<MediaResult> {
    const kind: 'tts' | 'tti' = spec.use === 'tts' ? 'tts' : 'tti';
    const rule = spec.responseRule || {};
    const dataType = responseDataType(rule);
    try {
        const raw = await requestModel(spec.url, spec.apiKey, spec.body, {
            provider: spec.provider,
            use: spec.use,
            modelName: spec.modelName,
            dataType,
            overrides: spec.overrides ?? undefined,
        });

        const businessError = extractMediaError(raw, rule);
        if (businessError) return { ok: false, kind, data: '', dataType: 'base64', error: businessError };

        const data = extractMediaData(raw, rule, spec.use);
        if (data) return ok(kind, data);

        // 异步任务：取 task_id 后轮询
        const taskIdPath = typeof rule.task_id_path === 'string' ? rule.task_id_path.trim() : '';
        const taskId = taskIdPath
            ? getByPath(raw, taskIdPath)
            : (getByPath(raw, 'output.task_id') ?? getByPath(raw, 'task_id') ?? getByPath(raw, 'taskId'));
        if (taskId !== undefined && taskId !== null && String(taskId).trim() !== '' && typeof rule.poll_url === 'string' && rule.poll_url.trim()) {
            const polled = await pollForMedia(spec, String(taskId).trim());
            if (polled) return ok(kind, polled);
        }

        return {
            ok: false, kind, data: '', dataType: 'base64',
            error: `响应中未找到音频/图片数据（请检查「模型规则」的 [response].data_path 与 data_type；当前 data_path=${rule.data_path ?? '(空)'}，data_type=${rule.data_type ?? 'auto'}）`,
        };
    } catch (e) {
        return {
            ok: false, kind, data: '', dataType: 'base64',
            error: mediaErrorHint(e instanceof Error ? e.message : String(e), spec),
        };
    }
}
