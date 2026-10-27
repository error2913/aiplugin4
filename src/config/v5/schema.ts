// v5 模型配置：类型定义 + 解析 + 校验（带 JSON 路径报错）。
//
// 规范见 docs/05 模型配置。本模块是**纯逻辑**：不依赖 seal / Config，
// 便于单元测试（与 catalog.ts / request_rules.ts 同一约定）。
//
// 设计要点：
//   - 单个 JSON 文本承载整份模型配置（v4 的两个 TOML 框已废弃）
//   - provider（vendor）可选：留空由 baseURL 的 host 反查（见 vendor.ts）
//   - 模型**嵌套**在 provider 内，故不存在"模型引用了不存在的连接"这类错误
//   - 校验**一次报出全部问题**，每条带 $.a.b[0].c 形式的路径

import { ModelUse } from "../../model/types";

/** 配置版本。不匹配则拒绝（迁移在 migrate.ts） */
export const V5_VERSION = 5;

/** 全部合法用途（顺序即 UI 展示顺序） */
export const MODEL_USES: ModelUse[] = [
    'chat', 'compression', 'summarization', 'judge',
    'image-understanding', 'text-embedding', 'tts', 'image-generation',
];

/**
 * 协议方言（v5 的 providers[].api）。
 * 取代 v4 里靠 provider 字符串猜协议（provider.ts / adapter.ts / list.ts / model.ts 的 7 处硬编码）。
 */
export type ApiDialect = 'openai-completions' | 'anthropic-messages' | 'openai-responses';

export const API_DIALECTS: ApiDialect[] = ['openai-completions', 'anthropic-messages', 'openai-responses'];

/** 模型类型标签（取代 v4「api连接」的 [types] 表） */
export type ModelKind = 'text' | 'vision' | 'embed' | 'gen' | 'tts';

export const MODEL_KINDS: ModelKind[] = ['text', 'vision', 'embed', 'gen', 'tts'];

/** 媒体请求体与预设的合并方式：merge=逐键深合并；replace=整体替换（v4 靠"是否媒体用途"隐式决定） */
export type BodyMode = 'merge' | 'replace';

export interface V5Model {
    id: string;
    name: string;
    kind?: ModelKind;
    contextWindow?: number;
    maxTokens?: number;
    request?: Record<string, unknown>;
    bodyMode?: BodyMode;
    /**
     * 视觉输入覆盖（可选）：不同 provider 的图片限制不同。
     * maxSide = 单边接受上限（px）；targetSide = 交给模型前缩放到的长边（px）。
     * 缺省时用「图片」页签的全局配置。
     */
    image?: { maxSide?: number; targetSide?: number };
}

export interface V5Provider {
    /** vendor 标识；留空由 baseURL 反查 */
    provider?: string;
    api: ApiDialect;
    baseURL: string;
    apiKey: string;
    models?: V5Model[];
    enabled?: boolean;
    displayName?: string;
    timeout?: number;
    request?: Record<string, unknown>;
}

export interface V5Group {
    purposes: ModelUse[];
    body?: Record<string, unknown>;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    params?: Record<string, unknown>;
    prompt?: Record<string, unknown>;
}

export interface V5Config {
    version: number;
    providers: V5Provider[];
    /**
     * 用途 → 模型 id 的**有序**候选列表（下标越小越优先）。
     *
     * 语义是"**优先用这些，按此顺序**"，不是"只允许这些"：
     * 未列出的同类型模型仍在候选池里，排在列出的之后（插件按顺序取用：
     * 首选正常用，失败时顺着这个顺序往后切 —— 见 agent.ts 的 pickFallbackModel）。
     *
     * 单字符串也接受（校验时归一为单元素数组）—— 手写配置里"就绑一个"是常见情况，
     * 不该被迫写成 `["x"]`。
     */
    purposes?: Partial<Record<ModelUse, string[] | string>>;
    groups?: V5Group[];
}

/** 把 purposes 的一项归一成有序数组（去重、去空）。校验与消费两侧共用，避免各写一份。 */
export function normalizePurposeList(v: string[] | string | undefined | null): string[] {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : [v];
    const out: string[] = [];
    for (const x of arr) {
        if (typeof x !== 'string') continue;
        const t = x.trim();
        if (t && !out.includes(t)) out.push(t);   // 去重：同一模型绑两次没有意义
    }
    return out;
}

/** 一条校验问题；path 用 $.providers[0].baseURL 形式 */
export interface V5Issue {
    path: string;
    msg: string;
}

export interface V5ParseResult {
    config: V5Config | null;
    issues: V5Issue[];
}

const ID_CHARS = /^[\x21-\x7E]+$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 用途是否接受某种模型类型。
 * **必须与 model.ts 的 isEligible 保持一致**（那边按用途筛候选，这边在配置期就拦住）。
 * chat/压缩/总结/评判 排除 embed/gen/tts；四个终值用途各只接受自己的类型。
 */
export function isEligibleKind(use: ModelUse, kind: ModelKind | undefined): boolean {
    const k = kind || 'text';
    if (use === 'text-embedding') return k === 'embed';
    if (use === 'image-understanding') return k === 'vision';
    if (use === 'image-generation') return k === 'gen';
    if (use === 'tts') return k === 'tts';
    return k !== 'embed' && k !== 'gen' && k !== 'tts';
}

/** 校验请求体模板里的 thinking 字段：只接受结构化对象（字符串会被 provider 422 拒绝） */
function checkThinkingField(path: string, body: unknown): V5Issue | null {
    if (!isPlainObject(body)) return null;
    if (!Object.prototype.hasOwnProperty.call(body, 'thinking')) return null;
    const value = (body as Record<string, unknown>).thinking;
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) {
        return { path: `${path}.thinking`, msg: `thinking 需为结构化对象（如 {"type":"enabled"}），不能是 ${JSON.stringify(value)}` };
    }
    return null;
}

/** 校验一份已解析的 v5 配置对象；返回全部问题（空数组 = 通过） */
export function validateV5Config(raw: unknown): V5Issue[] {
    const issues: V5Issue[] = [];
    const push = (path: string, msg: string) => issues.push({ path, msg });

    if (!isPlainObject(raw)) {
        push('$', '配置必须是一个 JSON 对象');
        return issues;
    }

    if (raw.version !== V5_VERSION) {
        push('$.version', `版本必须是 ${V5_VERSION}（当前 ${JSON.stringify(raw.version)}）`);
    }

    if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
        push('$.providers', '至少需要一个连接');
        // providers 不合法时后续检查无意义
        return issues;
    }

    // 模型 id 需全局唯一（purposes 靠它引用）
    const modelIds = new Map<string, string>();
    const modelKinds = new Map<string, ModelKind>();

    raw.providers.forEach((p: unknown, i: number) => {
        const pp = `$.providers[${i}]`;
        if (!isPlainObject(p)) {
            push(pp, '连接必须是对象');
            return;
        }

        // provider 可选：只在"写了"时校验（留空 = 按 baseURL 反查）
        if (p.provider !== undefined && p.provider !== null && p.provider !== '') {
            if (typeof p.provider !== 'string' || !p.provider.trim()) {
                push(`${pp}.provider`, 'provider 需为非空字符串（留空则按 baseURL 自动识别）');
            }
        }

        if (typeof p.api !== 'string' || !API_DIALECTS.includes(p.api as ApiDialect)) {
            push(`${pp}.api`, `api ${JSON.stringify(p.api)} 非法（可选：${API_DIALECTS.join(' / ')}）`);
        }

        const url = typeof p.baseURL === 'string' ? p.baseURL.trim() : '';
        if (!url) {
            push(`${pp}.baseURL`, '缺少 baseURL（v5 不再兜默认值）');
        } else if (!/^https?:\/\//i.test(url)) {
            push(`${pp}.baseURL`, `baseURL 需以 http:// 或 https:// 开头（当前 ${JSON.stringify(p.baseURL)}）`);
        }

        const key = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
        if (!key) {
            push(`${pp}.apiKey`, '缺少 API Key');
        } else if (!ID_CHARS.test(key)) {
            push(`${pp}.apiKey`, 'API Key 含不可打印字符（HTTP 头只能携带 \\x21-\\x7E）');
        }

        if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
            push(`${pp}.enabled`, 'enabled 需为布尔值');
        }

        const models = p.models;
        if (models !== undefined) {
            if (!Array.isArray(models)) {
                push(`${pp}.models`, 'models 需为数组（留空/省略 = 启动时自动拉取）');
            } else {
                models.forEach((m: unknown, j: number) => {
                    const mp = `${pp}.models[${j}]`;
                    if (!isPlainObject(m)) {
                        push(mp, '模型必须是对象');
                        return;
                    }
                    const mid = typeof m.id === 'string' ? m.id.trim() : '';
                    if (!mid) {
                        push(`${mp}.id`, '缺少模型 id');
                    } else if (modelIds.has(mid)) {
                        push(`${mp}.id`, `模型 id "${mid}" 与 ${modelIds.get(mid)} 重复（需全局唯一）`);
                    } else {
                        modelIds.set(mid, mp);
                    }

                    if (typeof m.name !== 'string' || !m.name.trim()) {
                        push(`${mp}.name`, '缺少模型名 name');
                    }

                    if (m.kind !== undefined && !MODEL_KINDS.includes(m.kind as ModelKind)) {
                        push(`${mp}.kind`, `kind ${JSON.stringify(m.kind)} 非法（可选：${MODEL_KINDS.join(' / ')}）`);
                    } else if (mid) {
                        modelKinds.set(mid, (m.kind as ModelKind) || 'text');
                    }

                    if (m.bodyMode !== undefined && m.bodyMode !== 'merge' && m.bodyMode !== 'replace') {
                        push(`${mp}.bodyMode`, `bodyMode ${JSON.stringify(m.bodyMode)} 非法（可选：merge / replace）`);
                    }

                    if (m.image !== undefined) {
                        if (!isPlainObject(m.image)) {
                            push(`${mp}.image`, 'image 需为对象（如 {"maxSide":8192,"targetSide":2048}）');
                        } else {
                            for (const field of ['maxSide', 'targetSide'] as const) {
                                const value = (m.image as Record<string, unknown>)[field];
                                if (value === undefined || value === null) continue;
                                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000 || Math.floor(value) !== value) {
                                    push(`${mp}.image.${field}`, `${field} 需为 0~100000 的整数（0=交由全局配置/不检查）`);
                                }
                            }
                        }
                    }
                    if (m.request && isPlainObject(m.request)) {
                        const reqBodyIssue = checkThinkingField(`${mp}.request.body`, (m.request as Record<string, unknown>).body);
                        if (reqBodyIssue) push(reqBodyIssue.path, reqBodyIssue.msg);
                    }
                });
            }
        }
    });

    // purposes
    const purposes = raw.purposes;
    if (purposes !== undefined) {
        if (!isPlainObject(purposes)) {
            push('$.purposes', 'purposes 需为对象');
        } else {
            for (const [k, v] of Object.entries(purposes)) {
                if (!MODEL_USES.includes(k as ModelUse)) {
                    push(`$.purposes.${k}`, `未知用途（可选：${MODEL_USES.join(' / ')}）`);
                    continue;
                }
                // 允许单字符串（等价于单元素数组），但数组里必须都是字符串
                if (Array.isArray(v) && v.some((x) => typeof x !== 'string')) {
                    push(`$.purposes.${k}`, '用途绑定数组里只能放模型 id 字符串');
                    continue;
                }
                if (!Array.isArray(v) && v !== null && v !== undefined && v !== '' && typeof v !== 'string') {
                    push(`$.purposes.${k}`, '用途绑定需为模型 id 字符串，或模型 id 的有序数组');
                    continue;
                }
                const list = normalizePurposeList(v as string[] | string);
                list.forEach((id, j) => {
                    // 单字符串时路径不带下标，与旧写法保持一致（用户改起来更直观）
                    const p = Array.isArray(v) ? `$.purposes.${k}[${j}]` : `$.purposes.${k}`;
                    if (!modelIds.has(id)) {
                        push(p, `引用的模型 "${id}" 不存在`);
                        return;
                    }
                    const kind = modelKinds.get(id);
                    if (!isEligibleKind(k as ModelUse, kind)) {
                        push(p, `模型 "${id}" 的类型是 ${kind}，不适用于「${k}」用途（插件会忽略该绑定）`);
                    }
                });
            }
        }
    }

    // groups
    const groups = raw.groups;
    if (groups !== undefined) {
        if (!Array.isArray(groups)) {
            push('$.groups', 'groups 需为数组');
        } else {
            groups.forEach((g: unknown, i: number) => {
                const gp = `$.groups[${i}]`;
                if (!isPlainObject(g)) {
                    push(gp, '用途组必须是对象');
                    return;
                }
                const uses = g.purposes;
                if (!Array.isArray(uses) || uses.length === 0) {
                    push(`${gp}.purposes`, '用途组需要非空的 purposes 数组');
                } else {
                    uses.forEach((u: unknown, j: number) => {
                        if (!MODEL_USES.includes(u as ModelUse)) {
                            push(`${gp}.purposes[${j}]`, `未知用途 ${JSON.stringify(u)}`);
                        }
                    });
                }
                // thinking 只接受结构化对象；字符串（如 "enabled"）会被 provider 422 拒绝
                const gBodyIssue = checkThinkingField(`${gp}.body`, g.body);
                if (gBodyIssue) push(gBodyIssue.path, gBodyIssue.msg);
                if (isPlainObject(g.request)) {
                    const gReqIssue = checkThinkingField(`${gp}.request.body`, (g.request as Record<string, unknown>).body);
                    if (gReqIssue) push(gReqIssue.path, gReqIssue.msg);
                }
            });
        }
    }

    return issues;
}

/** 把问题列表渲染成一段可读文本（供日志与 .ai model 展示） */
export function formatIssues(issues: V5Issue[]): string {
    return issues.map(i => `  ${i.path}：${i.msg}`).join('\n');
}

/**
 * 解析「模型配置」的 JSON 文本。
 * 不抛异常：JSON 语法错误与校验错误都通过 issues 返回。
 */
export function parseV5Config(text: string): V5ParseResult {
    const raw = String(text ?? '').trim();
    if (!raw) {
        return { config: null, issues: [{ path: '$', msg: '配置为空' }] };
    }

    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { config: null, issues: [{ path: '$', msg: `JSON 语法错误：${msg}` }] };
    }

    const issues = validateV5Config(data);
    if (issues.length > 0) return { config: null, issues };
    return { config: data as V5Config, issues: [] };
}
