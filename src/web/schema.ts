// 联网配置（v1）解析与校验。纯函数，不依赖 seal / Config，便于单元测试。
//
// 规范见 docs/18-联网搜索与抓取接入方案.md §6.2 / §14。
// 校验失败返回全部问题（path 用 $.providers[0].baseURL 形式），调用方整体拒绝。

import { defaultBaseURL, DIALECT_IDS } from './presets';
import {
    GenericDescriptor, WebConfig, WebDefaults, WebDetail, WebIssue, WebProviderRuntime,
} from './types';

export const WEB_CONFIG_VERSION = 1;

const isPlainObject = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function toStringRecord(obj: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of Object.keys(obj)) out[k] = String(obj[k]);
    return out;
}

export function defaultWebDefaults(): WebDefaults {
    return { count: 5, detail: 'summary', timeout: 20, maxContentChars: 4000, fallback: true };
}

const DETAILS: WebDetail[] = ['snippet', 'summary', 'content'];

/**
 * 默认配置：内置 SearXNG（公共实例 https://searxng.fishwhite.top），保证开箱可用。
 * 「联网配置」留空或校验失败时使用。
 */
export function defaultWebConfig(): WebConfig {
    const provider: WebProviderRuntime = {
        id: 'default-searxng',
        dialect: 'searxng',
        baseURL: defaultBaseURL('searxng'),
        apiKey: '',
        enabled: true,
    };
    return {
        version: WEB_CONFIG_VERSION,
        defaults: defaultWebDefaults(),
        providers: [provider],
        routes: { search: [provider.id] },
    };
}

function readDefaults(raw: unknown, issues: WebIssue[]): WebDefaults {
    const d = isPlainObject(raw) ? raw : {};
    const out = defaultWebDefaults();
    if (d.count !== undefined) {
        const n = Number(d.count);
        if (!Number.isFinite(n) || n < 1 || n > 50) issues.push({ path: '$.defaults.count', msg: 'count 需在 1~50 之间' });
        else out.count = Math.floor(n);
    }
    if (d.detail !== undefined) {
        if (!DETAILS.includes(d.detail)) issues.push({ path: '$.defaults.detail', msg: `detail 只能是 ${DETAILS.join(' / ')}` });
        else out.detail = d.detail;
    }
    if (d.timeout !== undefined) {
        const n = Number(d.timeout);
        if (!Number.isFinite(n) || n <= 0) issues.push({ path: '$.defaults.timeout', msg: 'timeout 需为正数（秒）' });
        else out.timeout = n;
    }
    if (d.maxContentChars !== undefined) {
        const n = Number(d.maxContentChars);
        if (!Number.isFinite(n) || n <= 0) issues.push({ path: '$.defaults.maxContentChars', msg: 'maxContentChars 需为正数' });
        else out.maxContentChars = Math.floor(n);
    }
    if (d.fallback !== undefined) {
        if (typeof d.fallback !== 'boolean') issues.push({ path: '$.defaults.fallback', msg: 'fallback 需为布尔值' });
        else out.fallback = d.fallback;
    }
    return out;
}

function readGenericDescriptor(raw: unknown, path: string, issues: WebIssue[]): GenericDescriptor | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isPlainObject(raw)) {
        issues.push({ path, msg: 'generic 描述需为 JSON 对象' });
        return undefined;
    }
    const out: GenericDescriptor = {};
    if (raw.method !== undefined) {
        const m = String(raw.method).toUpperCase();
        if (m !== 'GET' && m !== 'POST') issues.push({ path: `${path}.method`, msg: 'method 只能是 GET / POST' });
        else out.method = m;
    }
    if (raw.path !== undefined) {
        if (typeof raw.path !== 'string') issues.push({ path: `${path}.path`, msg: 'path 需为字符串' });
        else out.path = raw.path;
    }
    if (raw.headers !== undefined) {
        if (!isPlainObject(raw.headers)) issues.push({ path: `${path}.headers`, msg: 'headers 需为 JSON 对象' });
        else out.headers = toStringRecord(raw.headers);
    }
    if (raw.query !== undefined) {
        if (!isPlainObject(raw.query)) issues.push({ path: `${path}.query`, msg: 'query 需为 JSON 对象' });
        else out.query = toStringRecord(raw.query);
    }
    if (raw.body !== undefined) out.body = raw.body;
    if (raw.results_path !== undefined) {
        if (typeof raw.results_path !== 'string') issues.push({ path: `${path}.results_path`, msg: 'results_path 需为字符串' });
        else out.results_path = raw.results_path;
    }
    if (raw.fields !== undefined) {
        if (!isPlainObject(raw.fields)) issues.push({ path: `${path}.fields`, msg: 'fields 需为 JSON 对象' });
        else out.fields = toStringRecord(raw.fields);
    }
    if (raw.response_type !== undefined) {
        const t = String(raw.response_type);
        if (t !== 'json' && t !== 'text') issues.push({ path: `${path}.response_type`, msg: 'response_type 只能是 json / text' });
        else out.response_type = t;
    }
    if (raw.title_path !== undefined) out.title_path = String(raw.title_path);
    if (raw.content_path !== undefined) out.content_path = String(raw.content_path);
    return out;
}

function readProvider(raw: unknown, index: number, issues: WebIssue[], usedIds: Set<string>): WebProviderRuntime | null {
    const pp = `$.providers[${index}]`;
    if (!isPlainObject(raw)) {
        issues.push({ path: pp, msg: 'provider 需为 JSON 对象' });
        return null;
    }
    const dialect = nonEmptyString(raw.dialect) ? raw.dialect.trim() : '';
    if (!DIALECT_IDS.includes(dialect)) {
        issues.push({ path: `${pp}.dialect`, msg: `未知方言 ${JSON.stringify(raw.dialect)}（可选：${DIALECT_IDS.join(' / ')}）` });
        return null;
    }
    const id = nonEmptyString(raw.id) ? raw.id.trim() : dialect;
    if (usedIds.has(id)) issues.push({ path: `${pp}.id`, msg: `id 重复：${id}` });
    usedIds.add(id);

    if (raw.baseURL !== undefined && raw.baseURL !== null && typeof raw.baseURL !== 'string') {
        issues.push({ path: `${pp}.baseURL`, msg: 'baseURL 需为字符串' });
    }
    const baseURL = typeof raw.baseURL === 'string' && raw.baseURL.trim()
        ? raw.baseURL.trim()
        : defaultBaseURL(dialect);
    if (!baseURL) issues.push({ path: `${pp}.baseURL`, msg: 'generic 必须提供 baseURL（方言无内置地址）' });

    if (raw.apiKey !== undefined && raw.apiKey !== null && typeof raw.apiKey !== 'string') {
        issues.push({ path: `${pp}.apiKey`, msg: 'apiKey 需为字符串' });
    }
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';

    let timeout: number | undefined;
    if (raw.timeout !== undefined) {
        const n = Number(raw.timeout);
        if (!Number.isFinite(n) || n <= 0) issues.push({ path: `${pp}.timeout`, msg: 'timeout 需为正数（秒）' });
        else timeout = n;
    }

    let headers: Record<string, string> | undefined;
    if (raw.headers !== undefined) {
        if (!isPlainObject(raw.headers)) issues.push({ path: `${pp}.headers`, msg: 'headers 需为 JSON 对象' });
        else headers = toStringRecord(raw.headers);
    }

    // 生成器输出的 generic 描述字段名是 search / fetch；运行时叫 genericSearch / genericFetch
    const genericSearch = dialect === 'generic'
        ? readGenericDescriptor(raw.search ?? raw.genericSearch, `${pp}.search`, issues)
        : undefined;
    const genericFetch = dialect === 'generic'
        ? readGenericDescriptor(raw.fetch ?? raw.genericFetch, `${pp}.fetch`, issues)
        : undefined;
    if (dialect === 'generic' && !genericSearch && !genericFetch) {
        issues.push({ path: `${pp}.search`, msg: 'generic 至少需要 search / fetch 之一' });
    }

    return {
        id,
        dialect,
        baseURL,
        apiKey,
        enabled: raw.enabled !== false,
        timeout,
        headers,
        genericSearch,
        genericFetch,
    };
}

function readRoutes(raw: unknown, providerIds: Set<string>, issues: WebIssue[]): { search?: string[]; fetch?: string[] } {
    if (raw === undefined || raw === null) return {};
    if (!isPlainObject(raw)) {
        issues.push({ path: '$.routes', msg: 'routes 需为 JSON 对象' });
        return {};
    }
    const out: { search?: string[]; fetch?: string[] } = {};
    for (const key of ['search', 'fetch'] as const) {
        const v = raw[key];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
            issues.push({ path: `$.routes.${key}`, msg: `${key} 需为字符串数组` });
            continue;
        }
        const ids = (v as string[]).map(s => s.trim()).filter(Boolean);
        for (const id of ids) {
            if (!providerIds.has(id)) issues.push({ path: `$.routes.${key}`, msg: `引用了不存在的 provider：${id}` });
        }
        out[key] = ids;
    }
    return out;
}

/**
 * 解析并校验联网配置文本。
 * - 空文本：返回 config=null（由调用方决定是否回退 legacy）
 * - 校验失败：issues 非空、config=null（整体拒绝）
 */
export function parseWebConfig(text: string): { config: WebConfig | null; issues: WebIssue[] } {
    const raw = String(text ?? '').trim();
    if (!raw) return { config: null, issues: [] };

    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        return { config: null, issues: [{ path: '$', msg: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }] };
    }
    if (!isPlainObject(obj)) {
        return { config: null, issues: [{ path: '$', msg: '联网配置必须是一个 JSON 对象' }] };
    }

    const issues: WebIssue[] = [];
    if (obj.version !== undefined && obj.version !== WEB_CONFIG_VERSION) {
        issues.push({ path: '$.version', msg: `版本必须是 ${WEB_CONFIG_VERSION}（当前 ${JSON.stringify(obj.version)}）` });
    }

    const providersRaw = obj.providers;
    if (providersRaw !== undefined && !Array.isArray(providersRaw)) {
        issues.push({ path: '$.providers', msg: 'providers 需为数组' });
    }
    const providers: WebProviderRuntime[] = [];
    const usedIds = new Set<string>();
    if (Array.isArray(providersRaw)) {
        providersRaw.forEach((p, i) => {
            const parsed = readProvider(p, i, issues, usedIds);
            if (parsed) providers.push(parsed);
        });
    }

    const defaults = readDefaults(obj.defaults, issues);
    const routes = readRoutes(obj.routes, usedIds, issues);

    if (issues.length > 0) return { config: null, issues };
    return {
        config: {
            version: WEB_CONFIG_VERSION,
            defaults,
            providers,
            routes,
        },
        issues,
    };
}

/**
 * 配置页取配置的纯逻辑：
 * - 文本为空 → 内置默认 SearXNG（fishwhite 公共实例）
 * - 校验失败 → 同样回退默认配置（不抛错），issues 供调用方记录日志
 */
export function resolveWebConfig(text: string): {
    config: WebConfig;
    issues: WebIssue[];
} {
    const raw = String(text ?? '').trim();
    if (!raw) return { config: defaultWebConfig(), issues: [] };
    const parsed = parseWebConfig(raw);
    if (parsed.config) return { config: parsed.config, issues: [] };
    return { config: defaultWebConfig(), issues: parsed.issues };
}
