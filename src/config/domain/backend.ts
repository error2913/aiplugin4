// 后端配置（JSON v1）：用户在 aiplugin4-backends 的 WebUI 点「复制后端配置」后整段粘贴。
//
// 纯逻辑，不依赖 seal / Config，便于单元测试。
// 设计：**不迁移、不兼容**。旧的 8 个独立键不再读取；空的「后端配置」= 全部出厂默认。
// 每个后端可带 `token`（对应 AIPLUGIN4_BACKEND_TOKEN）：所有后端都支持，插件请求时发 Bearer。
// 校验失败整份拒绝，调用方回退出厂默认地址；一次报全部问题，路径形如 $.backends.image-host.url。
import { parseJSONWithTrailingCommas } from '../../utils/json';
import { isLoopbackUrl } from '../../utils/url';

import { DomainIssue, DomainParseResult } from './types';

export const BACKEND_CONFIG_VERSION = 1;

export type BackendName =
    | 'stream-output'
    | 'image-url-to-base64'
    | 'image-host'
    | 'media-fetch'
    | 'usage-chart'
    | 'ob11-core-bridge';

export interface BackendEndpoint {
    /** 插件访问后端的地址（图床可填回环：插件自身可达即可） */
    url: string;
    /** 访问 token（对应后端环境变量 AIPLUGIN4_BACKEND_TOKEN）；空 = 后端未启用鉴权。
     *  所有 HTTP/WS 后端都支持：插件请求时发 `Authorization: Bearer <token>`。 */
    token: string;
    /** 图床专用：对外地址（协议端与模型都能访问的 IP/域名）；空 = 不配置（回环时自动降级） */
    publicUrl?: string;
}

export interface BackendConfig {
    version: number;
    backends: Partial<Record<BackendName, BackendEndpoint>>;
}

/** 固定顺序：与 aiplugin4-backends 注册表一致，保证生成的 JSON 顺序稳定 */
export const BACKEND_NAMES: BackendName[] = [
    'image-url-to-base64',
    'media-fetch',
    'stream-output',
    'usage-chart',
    'ob11-core-bridge',
    'image-host',
];

/** 允许空 URL（留空 = 禁用）的后端 */
const OPTIONAL_URL_BACKENDS = new Set<BackendName>(['image-host', 'media-fetch']);
/** WebSocket 后端 */
const WS_BACKENDS = new Set<BackendName>(['ob11-core-bridge']);

/** 出厂默认地址（与旧版 8 个配置项的默认值一致） */
export const DEFAULT_BACKENDS: Record<BackendName, BackendEndpoint> = {
    'image-url-to-base64': { url: 'http://127.0.0.1:46678', token: '' },
    'media-fetch': { url: 'http://127.0.0.1:46679', token: '' },
    'stream-output': { url: 'http://localhost:3010', token: '' },
    'usage-chart': { url: 'http://127.0.0.1:3009', token: '' },
    'ob11-core-bridge': { url: 'ws://127.0.0.1:46880/plugin', token: '' },
    'image-host': { url: '', token: '', publicUrl: '' },
};

/** 支持「对外地址」的后端（目前只有图床：协议端与模型都要访问它的 /i/<id>） */
const PUBLIC_URL_BACKENDS = new Set<BackendName>(['image-host']);

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function issue(path: string, msg: string): DomainIssue {
    return { path, msg };
}

function parseText(text: string): { value: any; issues: DomainIssue[]; empty: boolean } {
    const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
    if (!raw) return { value: null, issues: [], empty: true };
    try {
        return { value: parseJSONWithTrailingCommas(raw), issues: [], empty: false };
    } catch (e) {
        return {
            value: null,
            issues: [issue('$', `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)],
            empty: false,
        };
    }
}

/** 解析「后端配置」；空文本返回 config: null（调用方使用出厂默认，不报错） */
export function parseBackendConfig(text: string): DomainParseResult<BackendConfig> {
    const { value, issues, empty } = parseText(text);
    if (empty) return { config: null, issues: [], warnings: [] };
    if (issues.length > 0) return { config: null, issues, warnings: [] };
    if (!isPlainObject(value)) {
        return { config: null, issues: [issue('$', '后端配置必须是一个 JSON 对象')], warnings: [] };
    }

    const warnings: DomainIssue[] = [];
    for (const key of Object.keys(value)) {
        if (key !== 'version' && key !== 'backends') {
            warnings.push(issue(`$.${key}`, '未知字段，已忽略'));
        }
    }
    if (value.version !== BACKEND_CONFIG_VERSION) {
        issues.push(issue('$.version', `版本必须是 ${BACKEND_CONFIG_VERSION}（当前 ${JSON.stringify(value.version)}）`));
    }

    const backends: Partial<Record<BackendName, BackendEndpoint>> = {};
    if (value.backends === undefined) {
        warnings.push(issue('$.backends', '缺省：全部使用出厂默认地址'));
    } else if (!isPlainObject(value.backends)) {
        issues.push(issue('$.backends', 'backends 必须是对象'));
    } else {
        for (const [rawName, rawCfg] of Object.entries(value.backends)) {
            const name = rawName.trim() as BackendName;
            const path = `$.backends.${rawName}`;
            if (!BACKEND_NAMES.includes(name)) {
                warnings.push(issue(path, `未知后端名 ${JSON.stringify(rawName)}，已忽略`));
                continue;
            }
            if (!isPlainObject(rawCfg)) {
                issues.push(issue(path, '后端配置必须是对象'));
                continue;
            }
            for (const key of Object.keys(rawCfg)) {
                // publicUrl 只对图床有意义；其它后端出现同样视为未知字段
                const allowed = key === 'url' || key === 'token'
                    || (key === 'publicUrl' && PUBLIC_URL_BACKENDS.has(name));
                if (!allowed) {
                    warnings.push(issue(`${path}.${key}`, '未知字段，已忽略'));
                }
            }

            let url = '';
            if (rawCfg.url === undefined || rawCfg.url === null) {
                // 可选项允许整个省略（= 禁用）；必填项省略报错
                if (!OPTIONAL_URL_BACKENDS.has(name)) issues.push(issue(`${path}.url`, 'url 必填（字符串）'));
            } else if (typeof rawCfg.url !== 'string') {
                issues.push(issue(`${path}.url`, 'url 必须是字符串'));
            } else {
                url = rawCfg.url.trim();
                if (!url) {
                    if (!OPTIONAL_URL_BACKENDS.has(name)) issues.push(issue(`${path}.url`, 'url 必填（字符串）'));
                } else {
                    const ok = WS_BACKENDS.has(name)
                        ? /^wss?:\/\/\S+$/i.test(url)
                        : /^https?:\/\/\S+$/i.test(url);
                    if (!ok) {
                        issues.push(issue(
                            `${path}.url`,
                            WS_BACKENDS.has(name) ? 'url 必须是 ws:// 或 wss:// 地址' : 'url 必须是 http:// 或 https:// 地址',
                        ));
                    } else if (!WS_BACKENDS.has(name)) {
                        // 消费方会拼 `${url}/start` 等路径，去掉尾部 / 避免双斜杠
                        url = url.replace(/\/+$/, '');
                    }
                }
            }

            let token = '';
            if (rawCfg.token !== undefined && rawCfg.token !== null) {
                if (typeof rawCfg.token !== 'string') {
                    issues.push(issue(`${path}.token`, 'token 必须是字符串'));
                } else {
                    // 所有后端都读取 AIPLUGIN4_BACKEND_TOKEN，token 是通用字段，不再按后端白名单过滤
                    token = rawCfg.token.trim();
                }
            }

            let publicUrl = '';
            if (PUBLIC_URL_BACKENDS.has(name) && rawCfg.publicUrl !== undefined && rawCfg.publicUrl !== null) {
                if (typeof rawCfg.publicUrl !== 'string') {
                    issues.push(issue(`${path}.publicUrl`, 'publicUrl 必须是字符串'));
                } else {
                    publicUrl = rawCfg.publicUrl.trim().replace(/\/+$/, '');
                    if (publicUrl) {
                        if (!/^https?:\/\/\S+$/i.test(publicUrl)) {
                            issues.push(issue(`${path}.publicUrl`, 'publicUrl 必须是 http:// 或 https:// 地址'));
                        } else if (isLoopbackUrl(publicUrl)) {
                            warnings.push(issue(
                                `${path}.publicUrl`,
                                '对外地址是回环地址（协议端与模型都访问不到），将按未配置处理；请填 IP 或域名',
                            ));
                            publicUrl = '';
                        }
                    }
                }
            }

            backends[name] = {
                url,
                token,
                // 图床固定带 publicUrl 字段（空串 = 未配置），其余后端不出现
                ...(PUBLIC_URL_BACKENDS.has(name) ? { publicUrl } : {}),
            };
        }
    }

    if (issues.length > 0) return { config: null, issues, warnings };
    return { config: { version: BACKEND_CONFIG_VERSION, backends }, issues: [], warnings };
}

/** 合并出厂默认：缺省项用默认值，显式空 URL（可选项）保持禁用 */
export function resolveBackendEndpoints(config: BackendConfig | null): Record<BackendName, BackendEndpoint> {
    const out = {} as Record<BackendName, BackendEndpoint>;
    for (const name of BACKEND_NAMES) {
        const fallback = DEFAULT_BACKENDS[name];
        const merged = config?.backends?.[name] ?? fallback;
        out[name] = {
            url: merged.url,
            token: merged.token,
            ...(merged.publicUrl !== undefined ? { publicUrl: merged.publicUrl } : {}),
        };
    }
    return out;
}
