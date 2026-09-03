// 模型 API 错误分类：把各家（OpenAI 兼容 / Anthropic / Google / 智谱 / 阿里 / SiliconFlow / 网关）的
// 报错报文归一化为语义类别，供自动处理（上下文超长归档重试、余额不足自动切模型、限流退避重试、
// 其余静默日志）决策。纯模块：不依赖 seal / Config，便于单元测试。

/** 语义错误类别 */
export type ApiErrorKind =
    | 'balance'            // 余额不足 / 欠费 / 额度用尽（充值类）
    | 'context_too_long'   // 请求上下文（含输入）超过模型上下文窗口
    | 'rate_limit'         // 限速（RPM/TPM/RPD/并发/资源配额）
    | 'overloaded'         // 服务端过载 / 容量不足（503/504/529 等，退避可恢复）
    | 'auth'               // 认证失败（API key 无效/过期）
    | 'permission'         // 权限不足（403 / 模型未开通 / 免费额度耗尽）
    | 'model_not_found'    // 模型不存在 / 无访问该模型的权限（404/400 特定码）
    | 'content_filter'     // 内容安全拦截（输入/输出命中审查）
    | 'invalid_request'    // 请求体/参数错误（400/422 等）
    | 'server'             // 服务端内部错误（500 等）
    | 'unknown';           // 无法归类

/** 类别 → 中文名（日志与 ctx.notice 通知文案用） */
export const KIND_LABEL: Record<ApiErrorKind, string> = {
    balance: '余额不足',
    context_too_long: '上下文超长',
    rate_limit: '触发限流',
    overloaded: '服务繁忙',
    auth: '认证失败',
    permission: '权限不足',
    model_not_found: '模型不存在',
    content_filter: '内容安全拦截',
    invalid_request: '请求参数错误',
    server: '服务端错误',
    unknown: '未知错误'
};

/** 分类器输出一个合法 kind */
export function isApiErrorKind(v: unknown): v is ApiErrorKind {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABEL, v);
}

/** 带语义分类的模型请求错误：附加 status/provider/rawText（响应体原文）/kind/可选 Retry-After */
export class ApiError extends Error {
    status: number;
    provider: string;
    kind: ApiErrorKind;
    /** 服务端响应体原文（未截断），供窗口上限解析 / 日志复核 */
    rawText: string;
    /** 429/5xx 响应 Retry-After 头换算的毫秒数（缺失时不退避基准） */
    retryAfterMs?: number;
    /** 请求对应的模型名（可选，日志用） */
    modelName?: string;

    constructor(status: number, provider: string, kind: ApiErrorKind, message: string, rawText = '') {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.provider = provider || '';
        this.kind = kind;
        this.rawText = rawText;
    }

    /** 由 HTTP 响应构造：先分类再抛（保留现状的人话 message 格式，便于既有日志与展示兼容） */
    static fromResponse(status: number, provider: string, rawText: string, retryAfterMs?: number, modelName?: string): ApiError {
        const kind = classifyApiError(provider, status, rawText);
        const text = String(rawText ?? '');
        const snippet = text.length > 300 ? text.slice(0, 300) + `…(+${text.length - 300})` : text;
        const err = new ApiError(status, provider, kind, `请求失败! 状态码: ${status}\n响应体:${snippet}`, text);
        if (retryAfterMs && retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
        if (modelName) err.modelName = modelName;
        return err;
    }
}

/** 将 Retry-After 头（秒）换算为毫秒；非法/缺失返回 undefined */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const v = value.trim();
    if (!v) return undefined;
    const secs = parseFloat(v);
    if (Number.isFinite(secs) && secs > 0) return Math.ceil(secs * 1000);
    return undefined;
}

function tryParseJson(text: string): any {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
}

function asString(v: unknown): string {
    return v === undefined || v === null ? '' : String(v);
}

/**
 * 跨厂商错误分类：HTTP 状态码优先，其次按 provider/报错字段（code/type/status）白名单，
 * 最后 message 关键词（中英双语）兜底。字段名跨厂商归一：
 * OpenAI 系 error.code/error.type；Anthropic error.type；Google error.status；智谱 error.code；
 * 阿里 OpenAI 兼容 error.code、DashScope 原生顶层 code；SiliconFlow 顶层数字 code（无码表，靠 message）。
 */
export function classifyApiError(providerRaw: string, status: number, rawText: string): ApiErrorKind {
    const p = (providerRaw || '').toLowerCase();
    const text = String(rawText ?? '');
    const json = tryParseJson(text);
    const errObj = json && typeof json === 'object' ? (json.error && typeof json.error === 'object' ? json.error : json) : null;
    const code = asString(errObj?.code).trim();
    const type = asString(errObj?.type).trim();
    const gstatus = asString(errObj?.status).trim(); // Google: error.status 枚举
    const message = asString(errObj?.message).trim();

    // ---- 1) HTTP 状态码粗分（最稳的第一键）----
    if (status === 401) return 'auth';
    // 402 在 DeepSeek / SiliconFlow / OpenRouter 等语义统一为“余额不足”
    if (status === 402) return 'balance';
    // Anthropic 529 = 过载（容量），非欠费
    if (status === 529) return 'overloaded';
    if (status === 503 || status === 504) {
        if (/throttl|limit|overload/i.test(message)) return /overload|繁忙|暂时/i.test(message) ? 'overloaded' : 'rate_limit';
        return 'overloaded';
    }
    if (status >= 500) return 'server';

    // ---- 2) 结构化字段白名单 ----
    // Google：RESOURCE_EXHAUSTED = 配额/限速用尽
    if (gstatus === 'RESOURCE_EXHAUSTED') return 'rate_limit';
    if (gstatus === 'INVALID_ARGUMENT') {
        return matchContextTooLong(text, message) ? 'context_too_long' : 'invalid_request';
    }
    if (gstatus === 'PERMISSION_DENIED') return 'permission';

    // 内容安全（优先于参数错误，各家 code/type 不同但都指向审查）
    if (code === 'content_filter' || type === 'content_filter' || code === '1301' || code === 'DataInspectionFailed' || code === 'data_inspection_failed') {
        return 'content_filter';
    }
    if (/inappropriate content|considered high risk|content filter|敏感内容|不安全或敏感/i.test(message) && !/insufficient/i.test(message)) {
        return 'content_filter';
    }

    // 余额/额度用尽
    if (p === 'anthropic' && type === 'billing_error') return 'balance';
    if (type === 'exceeded_current_quota_error') return 'balance'; // Kimi/Moonshot
    if (type === 'insufficient_quota' || code === 'insufficient_quota') {
        // ⚠ 阿里百炼把 insufficient_quota 用作 TPM/额度限流别名，不是余额不足
        if (p === 'alibaba') return 'rate_limit';
        if (/allocated quota exceeded/i.test(message)) return 'rate_limit'; // 阿里文案，兜 provider 缺失
        return 'balance';
    }
    if (['credit_balance_exhausted', 'organization_usage_limit_exceeded', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'insufficient_quota'].includes(code)) {
        if (p === 'alibaba') return 'rate_limit';
        return 'balance';
    }
    if (p === 'zhipu' && (code === '1113' || /^131[6-9]$|^132[01]$/.test(code))) return 'balance';
    if (p === 'alibaba' && ['Arrearage', 'isv.OUT_OF_SERVICE', 'PrepaidBillOverdue', 'PostpaidBillOverdue', 'CommodityNotPurchased'].includes(code)) return 'balance';
    // 兜底 message 强信号（双语；避免只依赖 status=429/400 误判）
    if (/账户.*欠费|余额不足|请充值|已停用|欠费|Insufficient Balance|has run out of credits|account is in good standing|OUT_OF_SERVICE/i.test(message)) {
        return 'balance';
    }

    // 上下文超长（先于通用参数错误）
    if (code === 'context_length_exceeded' || type === 'context_length_exceeded') return 'context_too_long';
    if (p === 'zhipu' && code === '1261') return 'context_too_long';
    if (matchContextTooLong(text, message)) return 'context_too_long';

    // 模型不存在
    if (['model_not_found', 'model_not_supported', 'ModelNotFound', 'WorkSpaceNotFound'].includes(code)) return 'model_not_found';
    if (type === 'resource_not_found_error') return 'model_not_found';
    if (p === 'zhipu' && code === '1211') return 'model_not_found';
    if (/model.*(does not exist|not found)|model not found|模型不存在|Model does not exist|The model .* does not exist/i.test(message)) return 'model_not_found';

    // 过载 / 容量（退避可恢复）
    if (type === 'overloaded_error' || type === 'engine_overloaded_error' || type === 'server_unavailable' || type === 'overloaded') return 'overloaded';
    if (p === 'zhipu' && code === '1305') return 'overloaded';
    if (/is currently overloaded|暂时无法处理|系统负载|服务繁忙|访问量过大|server is overloaded/i.test(message)) return 'overloaded';

    // 限速（429 剩余全归限速；各家在 429 上的细分 type 都进这里）
    if (status === 429) return 'rate_limit';
    if (p === 'zhipu' && code === '1302') return 'rate_limit';
    if (type === 'rate_limit_error' || type === 'rate_limit_reached_error' || type === 'rate_limited' || type === 'request_limit_reached') return 'rate_limit';
    if (/rate limit|too many requests|throttl|RPM|TPM|RPD|TPD|并发|频率|限流|requests.*limit/i.test(message)) {
        return 'rate_limit';
    }

    // 权限（403 剩余）
    if (status === 403) return 'permission';
    if (type === 'permission_error' || type === 'permission_denied_error' || type === 'access_denied') return 'permission';

    // 请求参数错误（400/422 剩余）
    if (status === 400 || status === 422) return 'invalid_request';

    // ---- 3) 剩余状态码兜底 ----
    if (status >= 400) return 'unknown';
    // 200 + body 内 error（部分网关成功状态码携带错误对象）
    if (code || type || message) return 'unknown';
    return 'unknown';
}

/** 上下文/输入超长的 message 判定：跨厂关键词（中英双语），并排除文件大小/参数范围等近义误伤 */
function matchContextTooLong(text: string, message: string): boolean {
    const target = `${message || ''}\n${text || ''}`;
    // max_tokens/参数类超限属于请求参数错误而非上下文超长，先行排除
    if (/\bmax[_-]?(tokens|completion_tokens)\b[^。\n]{0,80}(maximum|exceed|超过|超出|should be)/i.test(target)) return false;
    return /maximum context length|context window|input token length too long|prompt is too long|prompt: too long|exceeds the maximum number of tokens allowed|token count [^。\n]{0,60} exceeds|reduce the length of the messages|Range of input length should be|Total message token length exceed|token length.*(too long|exceeds)|(上下文|输入).{0,12}(超长|超出|过长)|Prompt 超长|输入长度.*超|请求体.*超/i.test(target);
}

/** 上下文超长归档重试的安全系数：给 system/tools/校准系数留余量 */
export const CONTEXT_RETRY_SAFETY = 0.8;

/** 从超长报文中解析“模型最大上下文窗口 N”；各家报错措辞不一，逐条正则取数字（去逗号） */
export function parseMaxContextTokens(rawText: string): number | undefined {
    const text = String(rawText ?? '');
    const patterns: RegExp[] = [
        /maximum context length is (\d[\d,]*)\s*tokens/i, // OpenAI 系
        /exceeds the maximum number of tokens allowed \((\d[\d,]*)\)/i, // Google Gemini
        /prompt is too long: [\d,]+ tokens > (\d[\d,]+) maximum/i, // Anthropic
        /prompt: too long: [\d,]+ tokens > (\d[\d,]+) maximum/i, // Anthropic 旧文案
        /Range of input length should be \[1,\s*(\d[\d,]*)\]/i, // 阿里百炼
        /Total message token length exceed model limit \((\d[\d,]*)/i, // 阿里百炼 Batch 场景
        /maximum context tokens[^\d]{0,20}(\d[\d,]*)/i
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) {
            const n = parseInt(m[1].replace(/,/g, ''), 10);
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    return undefined;
}

/**
 * 计算超长重试前的归档目标：优先用报文中的模型窗口 N（并留安全余量），
 * 再与本地「上下文最大token」预算取小；都拿不到时返回 undefined（调用方放弃动作）。
 */
export function computeArchiveTarget(localBudget: number, rawText: string): number | undefined {
    const parsed = parseMaxContextTokens(rawText);
    const budget = typeof localBudget === 'number' && localBudget > 0 ? localBudget : undefined;
    if (parsed === undefined && budget === undefined) return undefined;
    let target: number;
    if (parsed !== undefined && budget !== undefined) target = Math.min(parsed, budget);
    else target = parsed ?? budget as number;
    target = Math.floor(target * CONTEXT_RETRY_SAFETY);
    return target > 0 ? target : undefined;
}
