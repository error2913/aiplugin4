// 媒体工具的共享逻辑：按「模型规则」生成 schema 与描述（不是硬编码超集）、解析目标模型。
//
// 为什么用惰性 getter：工具在 Plugin 启动早期注册，此时只有"钉住清单"的连接有模型，
// 自动拉取的连接还在异步加载中。把 description/parameters 做成 getter，读取时（构造提示词、
// search_tools、JSON Schema dump）都取当前真实状态，避免"注册时机决定提示词内容"的脆弱性。
// 模型规则本身的变更仍需重载 JS 生效（规则是模块级缓存），与既有复杂配置一致。
import {
    buildMediaParamHint,
    describeMediaParam as describeMediaParamBase,
    MediaModelDesc,
    useParamSummary,
} from "../../../model/media_template";
import Model, { ModelEntry } from "../../../model/model";
import { MediaParamMeta } from "../../../model/request_rules";
import { MediaModelUse } from "../../../model/types";
import { ToolInfo, ToolInfoObject } from "../../types";

export interface MediaToolSpec {
    name: string;
    /** 静态描述（不含动态参数清单） */
    description: string;
    /** 固定参数（正文/模型选择/资源路径等） */
    properties: Record<string, any>;
    required: string[];
}

/** 当前该用途可用的模型描述列表（供提示词与 schema 生成） */
export function listMediaModels(use: MediaModelUse): MediaModelDesc[] {
    return Model.listForUse(use).map(e => ({ ref: e.ref, name: e.name, provider: e.provider }));
}

/** 默认模型（该用途候选中的第一个，与 resolveForUse 语义一致） */
export function defaultMediaRef(use: MediaModelUse): string | undefined {
    const first = Model.listForUse(use)[0];
    return first ? first.ref : undefined;
}

/** 参数在 schema 里的类型：优先 [params].type，其次由 default 推断，无法判定则不写（不做校验） */
function inferType(meta: { type?: string; default?: unknown }): string | undefined {
    const declared = typeof meta.type === 'string' ? meta.type.trim().toLowerCase() : '';
    if (declared === 'number' || declared === 'boolean' || declared === 'string') return declared;
    const d = meta.default;
    if (typeof d === 'number') return 'number';
    if (typeof d === 'boolean') return 'boolean';
    if (typeof d === 'string') return 'string';
    return undefined;
}

/** 参数的一行说明（委托 media_template 的唯一实现，避免两处口径漂移） */
export function describeMediaParam(
    key: string,
    meta: MediaParamMeta,
    supports: string[],
    models: MediaModelDesc[],
): string {
    return describeMediaParamBase(key, meta, supports, models);
}

/** 组装完整的工具 description：静态部分 + 逐模型参数清单 + [prompt].extra */
export function composeMediaDescription(use: MediaModelUse, staticDescription: string): string {
    const models = listMediaModels(use);
    const hint = buildMediaParamHint(use, models, defaultMediaRef(use));
    return hint ? `${staticDescription}\n${hint}` : staticDescription;
}

/** 组装参数 JSON Schema：固定参数 + 该用途已配置模型声明的可覆写参数并集 */
export function composeMediaParameters(use: MediaModelUse, spec: Pick<MediaToolSpec, 'properties' | 'required'>): ToolInfoObject {
    const models = listMediaModels(use);
    const summary = useParamSummary(use, models);
    const properties: Record<string, any> = { ...spec.properties };

    for (const key of summary.keys) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
        const meta = summary.meta[key] ?? {};
        const prop: Record<string, any> = {
            description: describeMediaParam(key, meta, summary.supportedBy[key] ?? [], models),
        };
        const type = inferType(meta);
        if (type) prop.type = type;
        if (Array.isArray(meta.enum) && meta.enum.length > 0) prop.enum = meta.enum;
        properties[key] = prop;
    }

    return { type: 'object', properties, required: spec.required };
}

/**
 * 构造媒体工具的 ToolInfo：description 与 parameters 为惰性 getter（见文件头说明）。
 */
export function buildMediaToolInfo(spec: MediaToolSpec, use: MediaModelUse): ToolInfo {
    const fn: any = { name: spec.name };
    Object.defineProperty(fn, 'description', {
        enumerable: true,
        configurable: true,
        get: () => composeMediaDescription(use, spec.description),
    });
    Object.defineProperty(fn, 'parameters', {
        enumerable: true,
        configurable: true,
        get: () => composeMediaParameters(use, spec),
    });
    return { type: 'function', function: fn };
}

export interface MediaEntryResolution {
    entry?: ModelEntry;
    error?: string;
}

/**
 * 提交后同步等待窗口的文案生成（生图/语音共用）。
 *
 * 行为：等待 `Config.tool.MEDIA_SYNC_WAIT_SECONDS` 秒（默认 5，0=关闭）；
 *   - 窗口内已出结果 → 直接给 AI 可用的发送方式，**不再走异步通知**（也就不会撞上会话闸门）
 *   - 窗口内没出结果 → 照常返回任务号，生成完成后由通知+唤醒链路投递
 *
 * 为什么需要：生成响应过快时（本地模型/缓存命中/极短内容），任务可能在工具 solve() 还没返回
 * 时就已完成，此时完成通知会撞上"发起轮还在跑"的会话闸门。当场返回最快，也最省一轮模型调用。
 *
 * @param mode 'sync'  窗口内已完成（返回可执行结果）
 *             'async' 窗口内未完成（返回任务号，走异步）
 */
export function buildMediaSubmitReply(opts: {
    mode: 'sync' | 'async';
    taskId: string;
    kind: 'tts' | 'tti';
    modelLabel: string;
    queued: number;
    /** sync 模式：图片 imageId（据此给 [img:ID] 标签） */
    imageId?: string;
    /** sync 模式：语音可发送文件路径/URL */
    recordFile?: string;
    /** sync 模式：失败原因 */
    errorText?: string;
}): string {
    const { mode, taskId, kind, modelLabel, queued, imageId, recordFile, errorText } = opts;
    if (mode === 'sync') {
        if (errorText) return `生成任务 #${taskId} 失败：${errorText}`;
        if (kind === 'tti') {
            // 优先让 AI 用标签发（系统自动发送），避免为发当前会话的图去调 call_ob11_api
            return `生成任务 #${taskId} 已完成（模型：${modelLabel}）。`
                + `请**优先**在回复中直接写 [img:${imageId}] 把图发给用户（系统会自动发送），非必要不要为此调用 call_ob11_api。`;
        }
        return `生成任务 #${taskId} 已完成（模型：${modelLabel}）。`
            + `发送方式：调用 call_ob11_api，把 {"type":"record","data":{"file":"${recordFile}"}} 放进 message 段发送`
            + `（回复里的 [audio:…] 只接受「资源」页配置的本地语音资源名，不接受生成结果的路径/URL）。`;
    }
    const kindLabel = kind === 'tts' ? '语音生成' : '生图';
    return `已提交${kindLabel}任务 #${taskId}（模型：${modelLabel}）`
        + (queued > 0 ? `，当前有 ${queued} 个任务在排队/进行中` : '')
        + `。生成完成后会自动通知你：`
        + (kind === 'tts'
            ? '届时把 record 段交给 call_ob11_api 发送；'
            : '届时**优先**在回复里直接写 [img:图片ID]（系统会自动发送），非必要不要为此调用 call_ob11_api；')
        + `也可用 media_tasks 查看队列。`;
}

/**
 * 解析媒体工具/命令要用的模型：显式指定优先，否则取该用途默认。
 * 返回可读错误而非抛异常，便于工具直接回给 AI。
 */
export function resolveMediaEntry(use: MediaModelUse, modelArg?: unknown): MediaEntryResolution {
    const explicit = typeof modelArg === 'string' ? modelArg.trim() : '';
    if (explicit) {
        const found = Model.findModelByRef(explicit, use);
        if (found) return { entry: found };
        const available = listMediaModels(use).map(m => m.name);
        const kindLabel = use === 'tts' ? '语音' : '生图';
        if (available.length === 0) {
            return { error: `未找到${kindLabel}模型 ${explicit}；当前没有可用的${kindLabel}模型（请在「api连接」添加并在 [types] 声明为 ${use === 'tts' ? 'tts' : 'gen'}）` };
        }
        return { error: `未找到${kindLabel}模型 ${explicit}；可用：${available.join('、')}` };
    }
    const fallback = use === 'tts' ? Model.getTTSModel() : Model.getImageModel();
    if (fallback) return { entry: fallback };
    const kindLabel = use === 'tts' ? '语音' : '生图';
    // 请求结构由内置供应商预设提供，所以只需在「api连接」里加一个该用途的模型（必要时用 [types] 声明类型）
    const tag = use === 'tts' ? 'tts' : 'gen';
    return {
        error: `未配置${kindLabel}模型：请在「api连接」添加该用途的模型（语音/生图命名识别不到时用 [types] 声明为 "${tag}"），请求结构由内置预设提供、无需写「模型规则」；「api连接」末两框已有现成的语音/文生图示例，填入 api_key 并删掉 ignore 行即可。`,
    };
}
