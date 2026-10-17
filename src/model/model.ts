// 模型管理器（v4：api连接 + 模型规则）：
// - 模型实例由「api连接」产出（pinned 钉住清单 / 启动自动拉取），只存内存、不做持久化，按 (连接序号, 模型名) 组织；
// - 能力标签（text/vision/embed/gen）决定用途候选；默认模型取该用途候选中的第一个（首个可用同类型模型）；
// - .ai model 写入的全局分用途覆盖（modelPurposeOverrides）优先级最高，失效回退默认。
import Logger from "../logger";

import { buildProviderBody, parseProviderResponse } from "./adapter";
import { isAnthropicMessages } from "./api_dialect";
import { resolveBaiduToken } from "./baidu_token";
import { classifyModel, DeclarableModelTag, ModelTag } from "./catalog";
import { describeListError, fetchModelList, ListFetchFn, ModelCapabilityHints, normalizeModelListResult } from "./list";
import { MediaRequestSpec, MediaResult, requestMedia } from "./media";
import {
    composeMediaTemplate,
    normalizeMediaParams,
    NormalizeOptions,
    renderMediaBody,
    renderMediaText,
    resolveMediaUrl,
    templateParamKeys,
} from "./media_template";
import { overridesFromRule, requestModel } from "./provider";
import {
    bodyDefaultsFor,
    ModelRuleTemplate,
    requestOverridesFor,
    setRuleRows,
} from "./request_rules";
import { ChatModelUse, EmbeddingModelUse, ModelUse, MultimodalModelUse } from "./types";

const log = Logger.withTag('model');

/** 参考图 → [body] 可用的内置占位符（image / image_url / image_base64） */
function buildImageBuiltins(image?: string): Record<string, unknown> {
    const raw = String(image ?? '').trim();
    if (!raw) return { image: '', image_url: '', image_base64: '' };
    const isDataUrl = /^data:/i.test(raw);
    const isUrl = /^https?:\/\//i.test(raw);
    const base64 = isDataUrl && raw.indexOf(',') >= 0
        ? raw.slice(raw.indexOf(',') + 1)
        : (isUrl ? '' : raw);
    const url = (isUrl || isDataUrl) ? raw : (base64 ? `data:image/png;base64,${base64}` : '');
    return { image: raw, image_url: url, image_base64: base64 };
}

/** 连接产出模型的来源（只存内存，不持久化） */
export type ListSource = 'pinned' | 'auto';
export type ConnStatus = 'ok' | 'pending' | 'error' | 'ignored';

/** 「api连接」配置解析结果的运行时视图（一条连接；不含 api_key，密钥只在请求时从配置取） */
export interface ConnState {
    connIndex: number;
    provider: string;
    baseUrl: string;
    source: ListSource | 'none';
    status: ConnStatus;
    errorKind?: string;
    errorText?: string;
    updatedAt: number;
    /** 该连接当前可用模型名（pinned 钉住/启动拉取结果），按列表顺序 */
    modelNames: string[];
    /** 供应商自报的能力位（仅自动拉取会填；只存内存、不持久化） */
    hints: Record<string, ModelCapabilityHints>;
}

/** 连接配置原始形态（configs/model.ts 解析配置后传入） */
export interface ConnConfigLike {
    /** 模板框序号（稳定标识；省略时按数组位置） */
    connIndex?: number;
    /**
     * 服务商标识（vendor）。v5 里通常由 baseURL 的 host 反查得到（见 config/v5/vendor.ts），
     * 供 media_presets（媒体请求结构）与 balance（内置余额端点）按 vendor 索引。
     */
    provider: string;
    /**
     * 协议方言（v5 新增）：openai-completions / anthropic-messages / openai-responses。
     * 取代 v4 里"按 provider 字符串猜协议"的做法（provider.ts / adapter.ts / list.ts / model.ts）。
     * 缺省按 openai-completions 处理，保证 v4 迁移期与旧用例仍可运行。
     */
    api?: string;
    apiKey: string;
    baseUrl: string;
    ignore: boolean;
    /** models 钉住清单：null=不钉住（启动自动拉取） */
    models: string[] | null;
    /** 「api连接」[types]：模型名 → 手动声明的类型（优先级最高），默认 {} */
    modelTypes?: Record<string, DeclarableModelTag>;
    /** v5：模型名 → 模型 id。ModelEntry.ref 用它取代 v4 的 `[连接序号]:模型名` */
    modelIds?: Record<string, string>;
    /** 连接配置 [request]（列表拉取覆盖），默认 {} */
    request?: Record<string, any>;
}

function isIgnoredValue(v: any): boolean {
    return v === 1 || v === true || v === '1';
}

/** 一个模型实例：来自某条连接，带能力标签 */
export class ModelEntry {
    connIndex: number;
    name: string;
    provider: string;
    /** v5：协议方言（缺省按 provider 推断，见 api_dialect.ts） */
    api?: string;
    baseUrl: string;
    apiKey: string;
    tags: ModelTag[];
    source: ListSource | 'none';
    /** 标识：v5 用配置里的模型 id；无 id 时退回 裸名 / [连接序号]:模型名 */
    ref: string = '';

    constructor(
        connIndex: number, name: string, provider: string, baseUrl: string, apiKey: string,
        tags: ModelTag[], source: ListSource | 'none', api?: string,
    ) {
        this.connIndex = connIndex;
        this.name = name;
        this.provider = provider;
        this.api = api;
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.tags = tags;
        this.source = source;
    }

    get isMultimodal(): boolean {
        return this.tags.includes('vision');
    }

    /** 对话/识图类请求地址（Messages 协议走 /messages，其余 /chat/completions） */
    get url(): string {
        return isAnthropicMessages(this.api, this.provider)
            ? `${this.baseUrl}/messages`
            : `${this.baseUrl}/chat/completions`;
    }

    /** 嵌入请求地址（OpenAI 兼容 /embeddings） */
    get embeddingUrl(): string {
        return `${this.baseUrl}/embeddings`;
    }

    // ---- 媒体生成（tts / image-generation）----

    /**
     * 校验 + 渲染语音请求（不发起合成请求；但双密钥鉴权（如百度）需要先换 access_token，故为异步）。
     * 校验失败返回 { error }，调用方应据此中止（不建任务）。
     */
    async prepareTTS(text: string, params: Record<string, unknown> = {}, normOpts?: NormalizeOptions): Promise<{ error: string } | { spec: MediaRequestSpec }> {
        return this.prepareMedia('tts', { text }, params, normOpts);
    }

    /** 校验 + 渲染文生图请求（不发起生成请求，理由同 prepareTTS） */
    async prepareTTI(
        prompt: string,
        opts: { negativePrompt?: string; image?: string; params?: Record<string, unknown>; normOpts?: NormalizeOptions } = {},
    ): Promise<{ error: string } | { spec: MediaRequestSpec }> {
        return this.prepareMedia('image-generation', {
            prompt,
            negative_prompt: opts.negativePrompt ?? '',
            ...buildImageBuiltins(opts.image),
        }, opts.params ?? {}, opts.normOpts);
    }

    /**
     * 媒体请求的公共准备：合成模板（内置预设 ← 规则）→ 参数归一/校验 → 渲染请求体 → 组装 spec。
     * 只允许模板里真实存在的 {占位符} 接收传参（模型不支持的参数会被忽略，不报错）。
     */
    private async prepareMedia(
        use: 'tts' | 'image-generation',
        builtin: Record<string, unknown>,
        rawParams: Record<string, unknown>,
        normOpts?: NormalizeOptions,
    ): Promise<{ error: string } | { spec: MediaRequestSpec }> {
        const composed = composeMediaTemplate(use, this.provider, this.name, this.ref);
        const allowed = templateParamKeys(composed);
        const meta = composed.params;
        const norm = normalizeMediaParams(rawParams, allowed, meta, normOpts);
        if (norm.errors.length > 0) return { error: norm.errors.join('；') };

        const overrides = overridesFromRule(composed.request);
        // {api_key} 占位符与鉴权头要用**真正生效的令牌**：双密钥写法（APIKey:SecretKey）时
        // 先换成 access_token，否则模板里放进 body 的会是那串密钥本身（百度短文本合成就是这种）。
        // 换好后把 authToken 标记去掉：spec.apiKey 已是可用令牌，请求期不必再换一次。
        let authKey = this.apiKey;
        if (overrides?.authToken) {
            try {
                authKey = await resolveBaiduToken(`conn${this.connIndex}`, this.apiKey);
            } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
            }
            delete overrides.authToken;
            delete overrides.authTokenScope;
        }

        // 注意：**不在 builtin 里放 origin** —— `{origin}` 由 resolveMediaUrl 自己
        // 从 baseUrl 替换（它本来就拿着 baseUrl，且漏了会渲染成空串）。
        // 单一来源，避免两处各写一份。
        const ctx = {
            builtin: { ...builtin, model: this.name, api_key: authKey },
            params: norm.params,
            meta,
        };
        const { body } = renderMediaBody(composed.body, ctx);
        // baseURL 的归一化在 resolveMediaUrl 内部**按预设**决定（见那里的说明）——
        // 它需要知道预设期望"基址"还是"端点"，在这里做会丢掉那个信息。
        const url = resolveMediaUrl(use, composed, this.baseUrl, text => renderMediaText(text, ctx));

        return {
            spec: {
                use,
                provider: this.provider,
                modelName: this.name,
                apiKey: authKey,
                url,
                body,
                overrides,
                responseRule: composed.response,
            },
        };
    }

    /** 执行语音合成（准备 + 请求；准备失败直接返回可读错误） */
    async callTTS(text: string, params: Record<string, unknown> = {}, normOpts?: NormalizeOptions): Promise<MediaResult> {
        const prepared = await this.prepareTTS(text, params, normOpts);
        if ('error' in prepared) {
            return { ok: false, kind: 'tts', data: '', dataType: 'base64', error: prepared.error };
        }
        return requestMedia(prepared.spec);
    }

    /** 执行文生图（准备 + 请求） */
    async callTTI(
        prompt: string,
        opts: { negativePrompt?: string; image?: string; params?: Record<string, unknown>; normOpts?: NormalizeOptions } = {},
    ): Promise<MediaResult> {
        const prepared = await this.prepareTTI(prompt, opts);
        if ('error' in prepared) {
            return { ok: false, kind: 'tti', data: '', dataType: 'base64', error: prepared.error };
        }
        return requestMedia(prepared.spec);
    }

    /**
     * 文本向量化（带按实例隔离的最近一次缓存）：失败返回 []（调用方降级）。
     * 请求体与 getEmbeddingDimension 同源（text-embedding 用途模板默认），保证维度一致。
     */
    async callEmbedding(text: string): Promise<number[]> {
        if (!text) {
            log.warning('callEmbedding: 文本为空');
            return [];
        }
        const defaults = bodyDefaultsFor('text-embedding') as any;
        const dimension = typeof defaults.dimensions === 'number' && defaults.dimensions > 0 ? defaults.dimensions : 0;
        const cacheKey = this.ref;
        const cache = ModelEntry.vectorCache[cacheKey];
        if (dimension > 0 && cache && cache.text === text && cache.vector.length === dimension) {
            return cache.vector;
        }
        try {
            const body = { ...defaults, model: this.name, input: text };
            const time = Date.now();
            const data = await requestModel(this.embeddingUrl, this.apiKey, body, {
                provider: this.provider,
                use: 'text-embedding',
                modelName: this.name,
            });
            if (data.data && data.data.length > 0) {
                const embedding = data.data[0].embedding;
                log.info(`文本:`, text.length > 200 ? text.slice(0, 200) + `…(+${text.length - 200})` : text, `\n响应embedding长度:`, embedding.length, '\nlatency:', Date.now() - time, 'ms');
                if (!Array.isArray(embedding)) {
                    throw new Error('响应 data[0].embedding 不是数组');
                }
                if (dimension > 0 && embedding.length === dimension) {
                    ModelEntry.vectorCache[cacheKey] = { text, vector: embedding };
                }
                return embedding;
            }
            throw new Error(`服务器响应中没有data或data为空\n响应体:${JSON.stringify(data, null, 2)}`);
        } catch (e) {
            log.error(`在调用嵌入模型${this.name}中出错:`, e instanceof Error ? e.message : String(e));
            return [];
        }
    }

    /** 图片理解（image-understanding）：图片转文字。经 provider 适配（anthropic 走 /messages 转换）。 */
    async callITT(src: string, prompt = ''): Promise<string> {
        try {
            const defaults = bodyDefaultsFor('image-understanding') as any;
            const body = {
                ...defaults,
                model: this.name,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: src } },
                        { type: 'text', text: prompt },
                    ],
                }],
            };
            const time = Date.now();
            const data = await requestModel(this.url, this.apiKey, buildProviderBody(this.provider, body, this.api), {
                provider: this.provider,
                api: this.api,
                use: 'image-understanding',
                modelName: this.name,
            });
            const response = parseProviderResponse(this.provider, data, this.api);
            if (response.choices && response.choices.length > 0) {
                const message = response.choices[0].message;
                const content = message.content || '';
                log.info(`识图响应(${Date.now() - time}ms): ${content.length > 300 ? content.slice(0, 300) + `…(+${content.length - 300})` : content}`);
                return content;
            }
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        } catch (e) {
            log.exception('在调用识图模型' + this.name + '中出错', e);
            return '';
        }
    }

    /** 按实例（ref）隔离的最近一次嵌入缓存，避免不同嵌入模型（同维度）互相串向量 */
    static vectorCache: { [ref: string]: { text: string, vector: number[] } } = {};
}

/** 模型全局注册表 */
export default class Model {
    static states: ConnState[] = [];
    static entries: ModelEntry[] = [];
    /** **运行时覆盖层**：`.ai model` 命令写入，存在 storage（key = modelPurposeOverrides） */
    static purposeModelOverrides: Partial<Record<ModelUse, string>> = {};
    /**
     * **配置默认层**（v5）：配置里 `purposes` 的绑定。
     * 优先级低于 purposeModelOverrides —— 因为 `seal.ext` 没有配置写入 API（见方案 1.1），
     * `.ai model` 只能写 storage，若 storage 不优先则该命令会失效。
     */
    static configPurposes: Partial<Record<ModelUse, string[]>> = {};

    /** 连接序号 → 原始配置（含 api_key 与列表覆盖），供拉取与请求时取用；不放入展示用 states */
    private static connByIndex = new Map<number, ConnConfigLike>();
    private static fetcher: ListFetchFn = fetchModelList;
    private static activeLoad: Promise<void> | null = null;
    /** 已提示过的「[types] 声明未命中模型列表」键（连接序号:模型名），避免同一声明重复刷屏 */
    private static warnedMissingTypes = new Set<string>();

    /** 重置注册表（测试/重载用；规则模板由 configs/model 负责重置） */
    static reset() {
        Model.states = [];
        Model.entries = [];
        Model.purposeModelOverrides = {};
        Model.configPurposes = {};
        Model.connByIndex = new Map();
        Model.activeLoad = null;
        Model.fetcher = fetchModelList;
        Model.warnedMissingTypes.clear();
        ModelEntry.vectorCache = {};
    }

    /**
     * 由 configs/model 在解析 TOML 后调用：
     * 1) 写入规则模板；2) 建连接状态机（pinned 立即有模型）；3) 对未钉住连接异步拉取列表（结果只存内存）。
     */
    static bootstrap(conns: ConnConfigLike[], rules: ModelRuleTemplate[], opts?: { fetch?: ListFetchFn }) {
        setRuleRows(rules);
        if (opts?.fetch) Model.fetcher = opts.fetch;

        Model.connByIndex = new Map();
        const connStates: ConnState[] = [];
        conns.forEach((c, arrayIndex) => {
            const rawIndex = typeof c.connIndex === 'number' ? c.connIndex : arrayIndex;
            if (!c.ignore) Model.connByIndex.set(rawIndex, c);
            if (c.ignore) {
                connStates.push({ connIndex: rawIndex, provider: c.provider, baseUrl: c.baseUrl, source: 'none' as const, status: 'ignored' as const, updatedAt: Date.now(), modelNames: [], hints: {} });
            } else if (c.models && c.models.length > 0) {
                connStates.push({ connIndex: rawIndex, provider: c.provider, baseUrl: c.baseUrl, source: 'pinned' as const, status: 'ok' as const, updatedAt: Date.now(), modelNames: [...c.models], hints: {} });
            } else {
                connStates.push({ connIndex: rawIndex, provider: c.provider, baseUrl: c.baseUrl, source: 'none' as const, status: 'pending' as const, updatedAt: 0, modelNames: [], hints: {} });
            }
        });
        Model.states = connStates;

        Model.rebuildEntries();
        Model.activeLoad = Model.runLoad();
        void Model.activeLoad.catch(e => log.error('模型列表异步拉取出错', e));
    }

    /** 启动拉取是否已就绪：首条消息/命令可 await 此门闩 */
    static ensureLoaded(): Promise<void> {
        return Model.activeLoad ?? Promise.resolve();
    }

    /**
     * 立即重拉全部连接（.ai model pull 用）：无论连接配置是否写了 models 钉住清单，
     * 一律向网络请求模型列表并用结果覆盖（pinned/auto/error 都会被刷新）；失败则按连接降级为 error。
     */
    static pull(): Promise<void> {
        Model.activeLoad = Model.runPull();
        void Model.activeLoad.catch(e => log.error('模型列表拉取出错', e));
        return Model.activeLoad;
    }

    /** 余额查询（.ai balance）用：非忽略连接的只读快照（apiKey 仅供请求时取用，不进展示态） */
    static balanceConns(): Array<{ connIndex: number, provider: string, baseUrl: string, apiKey: string, request: Record<string, any> }> {
        const out: Array<{ connIndex: number, provider: string, baseUrl: string, apiKey: string, request: Record<string, any> }> = [];
        Model.connByIndex.forEach((c, connIndex) => {
            out.push({ connIndex, provider: c.provider, baseUrl: c.baseUrl, apiKey: c.apiKey, request: c.request ?? {} });
        });
        out.sort((a, b) => a.connIndex - b.connIndex);
        return out;
    }

    /** 单连接拉取并更新 state（成功 → auto；失败 → error，只存内存） */
    private static async fetchConnState(state: ConnState, conn: ConnConfigLike): Promise<void> {
        try {
            const raw = await Model.fetcher({
                provider: conn.provider,
                api: conn.api,
                baseUrl: conn.baseUrl,
                apiKey: conn.apiKey,
                listOverride: conn.request ?? {},
            });
            const { names, hints } = normalizeModelListResult(raw);
            state.status = 'ok';
            state.source = 'auto';
            state.modelNames = names;
            state.hints = hints;
            state.updatedAt = Date.now();
            delete state.errorKind;
            delete state.errorText;
        } catch (e) {
            const d = describeListError(e);
            state.status = 'error';
            state.modelNames = [];
            state.hints = {};
            state.errorKind = d.kind;
            state.errorText = d.text;
        }
    }

    private static async runLoad(): Promise<void> {
        // pending：启动预热未拉取；error：已降级失败（pull/重试时再次拉取）
        const targets = Model.states.filter(s => s.status === 'pending' || s.status === 'error');
        await Promise.all(targets.map(async state => {
            const conn = Model.connByIndex.get(state.connIndex);
            if (!conn) {
                state.status = 'error';
                state.errorKind = 'unknown';
                state.errorText = '连接配置缺失';
                return;
            }
            await Model.fetchConnState(state, conn);
        }));
        Model.rebuildEntries();
    }

    /** pull：全部非忽略连接都强制拉取，无视配置里的 models 钉住字段 */
    private static async runPull(): Promise<void> {
        const targets = Model.states.filter(s => s.status !== 'ignored');
        await Promise.all(targets.map(async state => {
            const conn = Model.connByIndex.get(state.connIndex);
            if (!conn) {
                state.status = 'error';
                state.errorKind = 'unknown';
                state.errorText = '连接配置缺失';
                return;
            }
            await Model.fetchConnState(state, conn);
        }));
        Model.rebuildEntries();
    }

    /** 由 states 重建 entries，并分配 ref（唯一名裸名；重名 [连接序号]:模型名） */
    static rebuildEntries() {
        const counts = new Map<string, number>();
        const pairs: Array<{ st: ConnState, name: string }> = [];
        for (const st of Model.states) {
            if (st.status !== 'ok' || st.modelNames.length === 0) continue;
            for (const name of st.modelNames) {
                counts.set(name, (counts.get(name) || 0) + 1);
                pairs.push({ st, name });
            }
        }
        const entries = pairs.map(({ st, name }) => {
            const conn = Model.connByIndex.get(st.connIndex);
            const manual = conn?.modelTypes?.[name];
            const hints = st.hints?.[name];
            const entry = new ModelEntry(
                st.connIndex,
                name,
                st.provider,
                st.baseUrl,
                conn?.apiKey ?? '',
                classifyModel(st.provider, name, { manual, ...(hints ?? {}) }),
                st.source,
                conn?.api,
            );
            // ref 优先用配置里的模型 id（v5）：它是稳定标识，不受连接顺序/重名影响。
            // 无 id 时退回 v4 规则（唯一名用裸名，重名用 [连接序号]:模型名）。
            const idFromConfig = conn?.modelIds?.[name];
            entry.ref = idFromConfig
                ? idFromConfig
                : ((counts.get(name) || 0) > 1 ? `[${st.connIndex}]:${name}` : name);
            return entry;
        });
        Model.entries = entries;
        Model.warnUnusedModelTypes();
    }

    /**
     * 「api连接」[types] 的手动声明未命中当前模型列表时提示一次（warning）：
     * 模型名拼写错误/大小写不符/已从清单移除时，声明不再静默失效。
     * 只在连接列表就绪（status=ok）时判定，避免拉取失败/未完成时误报；同一声明每进程只提示一次。
     */
    private static warnUnusedModelTypes() {
        for (const st of Model.states) {
            if (st.status !== 'ok') continue;
            const declared = Model.connByIndex.get(st.connIndex)?.modelTypes;
            if (!declared) continue;
            const names = new Set(st.modelNames);
            for (const name of Object.keys(declared)) {
                if (names.has(name)) continue;
                const key = `${st.connIndex}:${name}`;
                if (Model.warnedMissingTypes.has(key)) continue;
                Model.warnedMissingTypes.add(key);
                log.warning(`api连接[${st.connIndex}] 的 [types] 声明 "${name}" = "${declared[name]}" 未命中当前模型列表（请检查模型名拼写；该连接当前 ${st.modelNames.length} 个模型）`);
            }
        }
    }


    // ---- 用途候选 / 默认解析 ----

    private static isEligible(e: ModelEntry, use: ModelUse): boolean {
        if (use === 'text-embedding') return e.tags.includes('embed');
        if (use === 'image-understanding') return e.tags.includes('vision');
        if (use === 'image-generation') return e.tags.includes('gen');
        if (use === 'tts') return e.tags.includes('tts');
        // chat / compression / summarization / judge：排除嵌入、生图与语音
        return !e.tags.includes('embed') && !e.tags.includes('gen') && !e.tags.includes('tts');
    }

    /**
     * 某用途的候选列表，**按用户的优先顺序排**（purposes 里列出的在前，下标越小越优先；
     * 未列出的排在其后，保持连接顺序 + 列表顺序）。
     *
     * 这是"按顺序取用"的唯一实现点：`resolveForUse` 取 pool[0]，
     * `pickFallbackModel` 顺着 pool 往后切 —— 两处都自动服从用户排序，不必各自改。
     * sort 是稳定的，所以未列出那批的相对顺序不变。
     */
    static listModelsForUse(use: ModelUse): ModelEntry[] {
        const pool = Model.entries.filter(e => Model.isEligible(e, use));
        const pref = Model.configPurposes[use];
        if (!pref || pref.length === 0) return pool;
        const rank = new Map<string, number>();
        pref.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
        const unlisted = pref.length;
        return pool.slice().sort((a, b) => {
            const ra = rank.has(a.ref) ? rank.get(a.ref)! : unlisted;
            const rb = rank.has(b.ref) ? rank.get(b.ref)! : unlisted;
            return ra - rb;
        });
    }

    /**
     * 解析 use 当前生效模型，分三层（方案 6.3）：
     *   1. storage 运行时覆盖（.ai model 写的）—— 优先级最高，**单个** ref
     *   2. 配置里的 purposes —— **有序数组**，取第一个有效的
     *   3. 该用途候选中的第一个（已按用户顺序排过）
     * 任一层引用失效（模型退役/改名/用途不符）时**保留现场并记日志**，回退下一层。
     */
    private static resolveForUse(use: ModelUse): ModelEntry | null {
        const overrideRef = Model.purposeModelOverrides[use];
        if (overrideRef) {
            const e = Model.findModelByRef(overrideRef, use);
            if (e) return e;
            log.warning(`运行时覆盖 ${overrideRef}（${use}）已失效，回退配置默认`);
        }

        const configList = Model.configPurposes[use];
        if (configList && configList.length > 0) {
            // 依次试用户排的顺序，取第一个**仍然有效**的（前面几个可能已退役/改名）
            for (const id of configList) {
                const e = Model.findModelByRef(id, use);
                if (e) return e;
            }
            log.warning(`配置绑定的 ${configList.join(' / ')}（${use}）均已失效，回退首个可用模型`);
        }

        const pool = Model.listModelsForUse(use);
        return pool.length > 0 ? pool[0] : null;
    }

    /** 当前 use 的解析来源（供 .ai model 标注"这个绑定来自哪一层"） */
    static resolveSourceForUse(use: ModelUse): 'override' | 'config' | 'auto' | 'none' {
        const ov = Model.purposeModelOverrides[use];
        if (ov && Model.findModelByRef(ov, use)) return 'override';
        const cf = Model.configPurposes[use];
        if (cf && cf.some(id => Model.findModelByRef(id, use))) return 'config';
        return Model.listModelsForUse(use).length > 0 ? 'auto' : 'none';
    }

    static getChatModel(use: ChatModelUse): ModelEntry | null {
        return Model.resolveForUse(use);
    }

    static getMultimodalModel(use: MultimodalModelUse): ModelEntry | null {
        return Model.resolveForUse(use);
    }

    static getEmbeddingModel(use: EmbeddingModelUse): ModelEntry | null {
        return Model.resolveForUse(use);
    }

    /** 语音合成用途当前生效模型 */
    static getTTSModel(): ModelEntry | null {
        return Model.resolveForUse('tts');
    }

    /** 文生图用途当前生效模型 */
    static getImageModel(): ModelEntry | null {
        return Model.resolveForUse('image-generation');
    }

    /** 某用途的全部候选（对外只读透出，供工具描述生成） */
    static listForUse(use: ModelUse): ModelEntry[] {
        return Model.listModelsForUse(use);
    }

    /** 按 ref 查找模型实例（可选 use 时校验用途资格），供 .ai model / 自动切换复用 */
    static findModelByRef(ref: string, use?: ModelUse): ModelEntry | null {
        if (!ref) return null;
        let entry: ModelEntry | null = null;
        const idxMatch = ref.match(/^\[(\d+)\]:\s*(.+)$/);
        if (idxMatch) {
            const connIndex = parseInt(idxMatch[1], 10);
            const name = idxMatch[2].trim();
            entry = Model.entries.find(e => e.connIndex === connIndex && e.name === name) || null;
        } else {
            // 1) 精确匹配 ref：v5 是配置里的**模型 id**；v4/唯一名时 ref 就等于模型名
            entry = Model.entries.find(e => e.ref === ref) || null;
            // 2) 退回按模型名匹配，但**仅当唯一** —— 重名时必须判为歧义，
            //    交由上层提示用户使用完整标识（保持 v4 既有语义）
            if (!entry) {
                const byName = Model.entries.filter(e => e.name === ref);
                if (byName.length === 1) entry = byName[0];
            }
        }
        if (!entry) return null;
        if (use && !Model.isEligible(entry, use)) return null;
        return entry;
    }

    /** 嵌入模型输出维度：text-embedding 用途模板 body.dimensions（默认 1024），非法返回 0（调用方降级关键词检索） */
    static getEmbeddingDimension(): number {
        const body = bodyDefaultsFor('text-embedding') as any;
        const dim = body?.dimensions;
        return typeof dim === 'number' && dim > 0 ? dim : 0;
    }

    /** 为某用途构建完整请求体：代码兜底默认 < 规则模板 body < 显式参数 */
    static buildRequestBody(use: ModelUse, args: { [key: string]: any }): any {
        return { ...bodyDefaultsFor(use), ...(args ?? {}) };
    }

    /** 某用途合并后的 body 默认（不含调用方显式参数）；供流式判定等读取 stream 等字段 */
    static getBodyDefaultsFor(use: ModelUse): any {
        return bodyDefaultsFor(use);
    }

    /** 请求期覆盖（[request] 模板，默认无）：headers / auth_header_name / content_type / timeout */
    static requestOverridesFor(use: ModelUse): Record<string, any> | null {
        return requestOverridesFor(use);
    }
}

/** 旧 ignore 语义判断辅助（连接配置 ignore=1/true/'1'） */
export function isIgnoredConfig(v: any): boolean {
    return isIgnoredValue(v);
}
