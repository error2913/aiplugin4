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
    'chat', 'summarization', 'judge',
    'image-understanding', 'text-embedding', 'tts', 'image-generation',
];

/**
 * 协议方言（v5 的 providers[].api）。
 * 取代 v4 里靠 provider 字符串猜协议（provider.ts / adapter.ts / list.ts / model.ts 的 7 处硬编码）。
 */
export type ApiDialect = 'openai-completions' | 'anthropic-messages' | 'openai-responses';

export const API_DIALECTS: ApiDialect[] = ['openai-completions', 'anthropic-messages', 'openai-responses'];

/** 模型类型标签（取代 v4「api连接」的 [types] 表） */
export type ModelKind = 'text' | 'vision' | 'embed' | 'gen' | 'tts' | 'decision';

export const MODEL_KINDS: ModelKind[] = ['text', 'vision', 'embed', 'gen', 'tts', 'decision'];

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
    /** 解析期自动清洗产生的提示（如旧配置里已移除的用途被忽略）；不影响合法性 */
    warnings?: string[];
}

const ID_CHARS = /^[\x21-\x7E]+$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 用途是否接受某种模型类型。
 * **必须与 model.ts 的 isEligible 保持一致**（那边按用途筛候选，这边在配置期就拦住）。
 * chat/总结/评判 排除 embed/gen/tts；四个终值用途各只接受自己的类型。
 */
export function isEligibleKind(use: ModelUse, kind: ModelKind | undefined): boolean {
    const k = kind || 'text';
    // 决策模型是 System One 专用后端：只允许 judge 用途。
    if (k === 'decision') return use === 'judge';
    if (use === 'text-embedding') return k === 'embed';
    if (use === 'image-understanding') return k === 'vision';
    if (use === 'image-generation') return k === 'gen';
    if (use === 'tts') return k === 'tts';
    // judge 接受普通对话模型（text/vision）；chat/summarization 不接受 decision（上面已拦）
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
                        const req = m.request as Record<string, unknown>;
                        const reqBodyIssue = checkThinkingField(`${mp}.request.body`, req.body);
                        if (reqBodyIssue) push(reqBodyIssue.path, reqBodyIssue.msg);

                        // 逐模型「用途 → 请求体」覆盖：键必须是已知用途，值必须是对象
                        const bbu = req.bodyByUse;
                        if (bbu !== undefined && mid && modelKinds.get(mid) === 'decision') {
                            push(`${mp}.request.bodyByUse`, '决策模型不支持 bodyByUse（请求体由内置 System One 适配器生成）');
                        } else if (bbu !== undefined) {
                            if (!isPlainObject(bbu)) {
                                push(`${mp}.request.bodyByUse`, 'bodyByUse 需为对象（用途 → 请求体）');
                            } else {
                                const kind = mid ? modelKinds.get(mid) : undefined;
                                for (const [use, body] of Object.entries(bbu)) {
                                    const upath = `${mp}.request.bodyByUse.${use}`;
                                    if (!MODEL_USES.includes(use as ModelUse)) {
                                        push(upath, `未知用途（可选：${MODEL_USES.join(' / ')}）`);
                                        continue;
                                    }
                                    if (!isPlainObject(body)) {
                                        push(upath, '请求体需为对象');
                                        continue;
                                    }
                                    const bodyIssue = checkThinkingField(upath, body);
                                    if (bodyIssue) push(bodyIssue.path, bodyIssue.msg);
                                    if (kind && !isEligibleKind(use as ModelUse, kind)) {
                                        push(upath, `模型类型是 ${kind}，不适用于「${use}」用途`);
                                    }
                                }
                            }
                        }
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

    return issues;
}

/** 把问题列表渲染成一段可读文本（供日志与 .ai model 展示） */
export function formatIssues(issues: V5Issue[]): string {
    return issues.map(i => `  ${i.path}：${i.msg}`).join('\n');
}

/** 已彻底移除的用途键：旧配置里有的话在解析期自动忽略（见 stripRemovedPurposes） */
const REMOVED_PURPOSE_KEYS = ['compression'] as const;

/**
 * 解析期清洗：剔除已移除用途（`purposes`），返回是否有改动。
 *
 * 为什么需要：`compression` 用途已从 `ChatModelUse`/`MODEL_USES` 中彻底移除，而 v5 校验对
 * 未知用途是**整份拒绝**。老用户存储里的模型配置一定带着 `purposes.compression`，若直接校验
 * 会让他们的模型配置整份失效。这里只在内存 raw 对象上剔除（不写回，海豹也没有配置写入 API），
 * 属于"输入容错"而非迁移；`configs/model.ts` 会把 warnings 打到日志。
 */
export function stripRemovedPurposes(raw: unknown): boolean {
    if (!isPlainObject(raw)) return false;
    let touched = false;
    const purposes = raw.purposes;
    if (isPlainObject(purposes)) {
        for (const key of REMOVED_PURPOSE_KEYS) {
            if (Object.prototype.hasOwnProperty.call(purposes, key)) {
                delete (purposes as Record<string, unknown>)[key];
                touched = true;
            }
        }
    }
    return touched;
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

    const warnings: string[] = [];
    // 旧配置兼容：已移除用途（compression）在校验前清洗，避免整份配置被判非法
    if (stripRemovedPurposes(data)) {
        warnings.push('旧配置中的「压缩」用途（compression）已移除，已自动忽略；其余用途不受影响。');
    }
    // 旧配置里的用途组请求体（groups）已停用：忽略并提示，请求体覆盖改走 models[].request.bodyByUse
    if (isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, 'groups')) {
        delete (data as Record<string, unknown>).groups;
        warnings.push('旧配置中的「用途组请求体」（groups）已移除，已自动忽略；请改用 models[].request.bodyByUse。');
    }

    const issues = validateV5Config(data);
    if (issues.length > 0) return { config: null, issues, ...(warnings.length > 0 ? { warnings } : {}) };
    return { config: data as V5Config, issues: [], ...(warnings.length > 0 ? { warnings } : {}) };
}
