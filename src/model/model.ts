// 模型管理器（v4：api连接 + 模型规则）：
// - 模型实例由「api连接」产出（pinned 钉住清单 / 启动自动拉取），只存内存、不做持久化，按 (连接序号, 模型名) 组织；
// - 能力标签（text/vision/embed/gen）决定用途候选；默认模型只在该用途候选「恰好唯一」时自动生效；
// - .ai model 写入的全局分用途覆盖（modelPurposeOverrides）优先级最高，失效自动回退默认。
import Logger from "../logger";

import { buildProviderBody, parseProviderResponse } from "./adapter";
import { classifyModel, ModelTag } from "./catalog";
import { describeListError, fetchModelList, ListFetchFn } from "./list";
import { requestModel } from "./provider";
import { bodyDefaultsFor, ModelRuleTemplate, requestOverridesFor, setRuleRows } from "./request_rules";
import { ChatModelUse, EmbeddingModelUse, ModelUse, MultimodalModelUse } from "./types";

const log = Logger.withTag('model');

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
}

/** 连接配置原始形态（configs/model.ts 解析 TOML 后传入） */
export interface ConnConfigLike {
    /** 模板行序号（稳定标识；省略时按数组位置） */
    connIndex?: number;
    provider: string;
    apiKey: string;
    baseUrl: string;
    ignore: boolean;
    /** models 钉住清单：null=不钉住（启动自动拉取） */
    models: string[] | null;
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
    baseUrl: string;
    apiKey: string;
    tags: ModelTag[];
    source: ListSource | 'none';
    /** 标识：全注册表唯一名 → 裸名；跨连接重名 → [连接序号]:模型名 */
    ref: string = '';

    constructor(connIndex: number, name: string, provider: string, baseUrl: string, apiKey: string, tags: ModelTag[], source: ListSource | 'none') {
        this.connIndex = connIndex;
        this.name = name;
        this.provider = provider;
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.tags = tags;
        this.source = source;
    }

    get isMultimodal(): boolean {
        return this.tags.includes('vision');
    }

    /** 对话/识图类请求地址（anthropic 走 /messages） */
    get url(): string {
        return this.provider === 'anthropic' ? `${this.baseUrl}/messages` : `${this.baseUrl}/chat/completions`;
    }

    /** 嵌入请求地址（OpenAI 兼容 /embeddings） */
    get embeddingUrl(): string {
        return `${this.baseUrl}/embeddings`;
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
            const data = await requestModel(this.url, this.apiKey, buildProviderBody(this.provider, body), {
                provider: this.provider,
                use: 'image-understanding',
                modelName: this.name,
            });
            const response = parseProviderResponse(this.provider, data);
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
    static purposeModelOverrides: Partial<Record<ModelUse, string>> = {};

    /** 连接序号 → 原始配置（含 api_key 与列表覆盖），供拉取与请求时取用；不放入展示用 states */
    private static connByIndex = new Map<number, ConnConfigLike>();
    private static fetcher: ListFetchFn = fetchModelList;
    private static activeLoad: Promise<void> | null = null;

    /** 重置注册表（测试/重载用；规则模板由 configs/model 负责重置） */
    static reset() {
        Model.states = [];
        Model.entries = [];
        Model.purposeModelOverrides = {};
        Model.connByIndex = new Map();
        Model.activeLoad = null;
        Model.fetcher = fetchModelList;
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
                connStates.push({ connIndex: rawIndex, provider: c.provider, baseUrl: c.baseUrl, source: 'none' as const, status: 'ignored' as const, updatedAt: Date.now(), modelNames: [] });
            } else if (c.models && c.models.length > 0) {
                connStates.push({ connIndex: rawIndex, provider: c.provider, baseUrl: c.baseUrl, source: 'pinned' as const, status: 'ok' as const, updatedAt: Date.now(), modelNames: [...c.models] });
            } else {
                connStates.push({ connIndex: rawIndex, provider: c.provider, baseUrl: c.baseUrl, source: 'none' as const, status: 'pending' as const, updatedAt: 0, modelNames: [] });
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

    /** 立即重拉全部非 pinned 连接（.ai model pull 用），完成时已重建注册表 */
    static pull(): Promise<void> {
        Model.activeLoad = Model.runLoad();
        void Model.activeLoad.catch(e => log.error('模型列表拉取出错', e));
        return Model.activeLoad;
    }

    private static async runLoad(): Promise<void> {
        // pending：启动预热未拉取；error：已降级失败（.ai model pull 重试时再次拉取）
        const pending = Model.states.filter(s => s.status === 'pending' || s.status === 'error');
        await Promise.all(pending.map(async state => {
            const conn = Model.connByIndex.get(state.connIndex);
            if (!conn) {
                state.status = 'error';
                state.errorKind = 'unknown';
                state.errorText = '连接配置缺失';
                return;
            }
            try {
                const names = await Model.fetcher({
                    provider: conn.provider,
                    baseUrl: conn.baseUrl,
                    apiKey: conn.apiKey,
                    listOverride: conn.request ?? {},
                });
                state.status = 'ok';
                state.source = 'auto';
                state.modelNames = names;
                state.updatedAt = Date.now();
                delete state.errorKind;
                delete state.errorText;
            } catch (e) {
                const d = describeListError(e);
                state.status = 'error';
                state.modelNames = [];
                state.errorKind = d.kind;
                state.errorText = d.text;
            }
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
            const entry = new ModelEntry(
                st.connIndex,
                name,
                st.provider,
                st.baseUrl,
                conn?.apiKey ?? '',
                classifyModel(st.provider, name),
                st.source,
            );
            entry.ref = (counts.get(name) || 0) > 1 ? `[${st.connIndex}]:${name}` : name;
            return entry;
        });
        Model.entries = entries;
    }

    // ---- 用途候选 / 默认解析 ----

    private static isEligible(e: ModelEntry, use: ModelUse): boolean {
        if (use === 'text-embedding') return e.tags.includes('embed');
        if (use === 'image-understanding') return e.tags.includes('vision');
        // chat / compression / summarization / judge：排除嵌入与生图
        return !e.tags.includes('embed') && !e.tags.includes('gen');
    }

    /** 某用途的全部候选（保持连接顺序 + 列表顺序） */
    static listModelsForUse(use: ModelUse): ModelEntry[] {
        return Model.entries.filter(e => Model.isEligible(e, use));
    }

    /** 解析 use 当前生效模型：全局覆盖 > 默认（候选恰好唯一时自动成为默认，否则无默认） */
    private static resolveForUse(use: ModelUse): ModelEntry | null {
        const ref = Model.purposeModelOverrides[use];
        if (ref) {
            const e = Model.findModelByRef(ref, use);
            if (e) return e;
            // 覆盖失效（模型退役/序号漂移/用途不符）：保留现场由 .ai model 标注，此处回退默认
            log.warning(`全局模型覆盖 ${ref}（${use}）已失效，回退默认`);
        }
        const pool = Model.listModelsForUse(use);
        return pool.length === 1 ? pool[0] : null;
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
            entry = Model.entries.find(e => e.ref === ref && e.name === ref) || null;
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
