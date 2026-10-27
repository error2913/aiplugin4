// 模型管理器（v4：api连接 + 模型规则）：
// - 模型实例由「api连接」产出（pinned 钉住清单 / 启动自动拉取），只存内存、不做持久化，按 (连接序号, 模型名) 组织；
// - 能力标签（text/vision/embed/gen）决定用途候选；默认模型取该用途候选中的第一个（首个可用同类型模型）；
// - .ai model 写入的全局分用途覆盖（modelPurposeOverrides）优先级最高，失效回退默认。
import Logger from "../logger";

import { classifyModel, DeclarableModelTag } from "./catalog";
import { ModelEntry } from "./entry";
import type { ConnStatus, ListSource } from "./entry";
import { describeListError, fetchModelList, ListFetchFn, ModelCapabilityHints, normalizeModelListResult } from "./list";
import { findModelByRef, listModelsForUse, resolveForUse, resolveSourceForUse } from "./registry_ops";
import {
    bodyDefaultsFor,
    ModelRuleTemplate,
    requestOverridesFor,
    setRuleRows,
} from "./request_rules";
import { ChatModelUse, EmbeddingModelUse, ModelUse, MultimodalModelUse } from "./types";

// 兼容旧引用：ModelEntry / ListSource / ConnStatus 已拆到 ./entry（外部 import 零改动）
export { ModelEntry } from "./entry";
export type { ConnStatus, ListSource } from "./entry";

const log = Logger.withTag('model');

/** 参考图 → [body] 可用的内置占位符（image / image_url / image_base64） */

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
    /** v5：模型名 → 视觉输入覆盖（图片单边上限/目标长边；缺省用「图片」全局配置） */
    imageLimits?: Record<string, { maxSide?: number; targetSide?: number }>;
    /** 连接配置 [request]（列表拉取覆盖），默认 {} */
    request?: Record<string, any>;
}

function isIgnoredValue(v: any): boolean {
    return v === 1 || v === true || v === '1';
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
            const limits = conn?.imageLimits?.[name];
            if (limits) entry.imageLimits = limits;
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

    // ---- 用途候选 / 默认解析（实现见 ./registry_ops，Model 静态方法保留委派） ----

    static listModelsForUse(use: ModelUse): ModelEntry[] {
        return listModelsForUse(Model, use);
    }

    static resolveSourceForUse(use: ModelUse): 'override' | 'config' | 'auto' | 'none' {
        return resolveSourceForUse(Model, use);
    }

    static getChatModel(use: ChatModelUse): ModelEntry | null {
        return resolveForUse(Model, use);
    }

    static getMultimodalModel(use: MultimodalModelUse): ModelEntry | null {
        return resolveForUse(Model, use);
    }

    static getEmbeddingModel(use: EmbeddingModelUse): ModelEntry | null {
        return resolveForUse(Model, use);
    }

    /** 语音合成用途当前生效模型 */
    static getTTSModel(): ModelEntry | null {
        return resolveForUse(Model, 'tts');
    }

    /** 文生图用途当前生效模型 */
    static getImageModel(): ModelEntry | null {
        return resolveForUse(Model, 'image-generation');
    }

    /** 某用途的全部候选（对外只读透出，供工具描述生成） */
    static listForUse(use: ModelUse): ModelEntry[] {
        return listModelsForUse(Model, use);
    }

    /** 按 ref 查找模型实例（可选 use 时校验用途资格），供 .ai model / 自动切换复用 */
    static findModelByRef(ref: string, use?: ModelUse): ModelEntry | null {
        return findModelByRef(Model, ref, use);
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
