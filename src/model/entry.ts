// ModelEntry：单个模型实例（来自某条 api 连接，带能力标签/请求构造/嵌入缓存）。
// 从 model.ts 拆出——模型注册表（Model 静态）与实例能力（ModelEntry）解耦；
// model.ts 保留 re-export，外部 import 零改动。
import Logger from "../logger";

import { buildProviderBody, parseProviderResponse } from "./adapter";
import { isAnthropicMessages } from "./api_dialect";
import { resolveBaiduToken } from "./baidu_token";
import { ModelTag } from "./catalog";
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
import { bodyDefaultsFor } from "./request_rules";

const log = Logger.withTag('model');

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
    /** v5 视觉输入覆盖：图片单边接受上限 / 目标长边（缺省用「图片」全局配置） */
    imageLimits?: { maxSide?: number; targetSide?: number };

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
