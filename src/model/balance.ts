// 余额查询：连接级「查账户余额」适配（.ai balance 用）。只查不写：结果不持久化、密钥不落日志。
// 默认 OpenAI 兼容之外的三家原生端点：
// - deepseek   GET {base 去 /v1}/user/balance          → is_available + balance_infos[]（多币种）
// - moonshot   GET {base}/users/me/balance             → data.{available_balance,cash_balance,voucher_balance}
// - siliconflow GET {base}/user/info                   → data.{balance,chargeBalance,totalBalance}
// 连接 [request] 可配 balance_url/balance_json_path/balance_divisor/balance_currency
// （配合 auth_header_name/headers）覆盖到 one-api/new-api 等网关；模式与 model/list.ts 一致：
// 端点推导 → GET → Promise.race 超时（goja 无 AbortController）→ 防呆解析 → 错误短文案。
import { ApiError } from "./api_error";

/** 一条余额结果（deepseek 可能多币种 → 一个条目/币种） */
export interface BalanceEntry {
    currency: string;
    /** 可用余额（已归一 number；负数=欠费） */
    available: number;
    /** 拆分展示：如 充值/赠送（deepseek）、现金/券（moonshot）、充值/总额（siliconflow） */
    parts?: Array<{ label: string; amount: number }>;
    /** deepseek is_available=false → 余额不足以调用，供展示告警 */
    availableFlag?: boolean;
}

/** 一次查询所需的最小信息：与 Model.balanceConns() 快照结构一致 */
export interface BalanceRequestContext {
    provider: string;
    baseUrl: string;
    apiKey: string;
    /** 连接配置 [request]（含余额覆盖键），默认 {} */
    request?: Record<string, any>;
}

/** 余额接口 GET 目标（null = 无内置端点且未配 balance_url → 不支持） */
export interface BalanceEndpoint {
    url: string;
    headers: Record<string, string>;
}

export const BALANCE_FETCH_TIMEOUT_MS = 10000;

function trimSlash(s: string): string {
    return String(s ?? '').trim().replace(/\/+$/, '');
}

/** 无 URL 解析依赖的主机提取：取协议后第一段（goja 环境稳妥） */
function hostOf(baseUrl: string): string {
    const s = String(baseUrl ?? '');
    const m = s.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i);
    return m ? m[1] : s;
}

/** 现有列表拉取里 auth_header_name/headers 的语义保持：给了 auth_header_name 则不拼 Bearer、原样放 key */
function buildHeaders(ctx: BalanceRequestContext, overrides: Record<string, any>): Record<string, string> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (overrides.headers && typeof overrides.headers === 'object') {
        for (const k of Object.keys(overrides.headers)) headers[k] = String(overrides.headers[k]);
    }
    const authHeader = typeof overrides.auth_header_name === 'string' && overrides.auth_header_name.trim()
        ? overrides.auth_header_name.trim()
        : 'Authorization';
    headers[authHeader] = authHeader === 'Authorization' ? `Bearer ${ctx.apiKey}` : ctx.apiKey;
    return headers;
}

/** 内置端点 URL（无 balance_url 覆盖时按 provider → host 推导） */
function nativeBalanceUrl(ctx: BalanceRequestContext): string | null {
    const p = (ctx.provider || '').toLowerCase();
    const host = hostOf(ctx.baseUrl);
    const base = trimSlash(ctx.baseUrl);
    if (!base) return null;

    if (p === 'deepseek' || host.includes('api.deepseek.com')) {
        // DeepSeek 官方余额端点在域名根（/user/balance），不带 /v1
        const root = base.replace(/\/v1(?:beta)?$/i, '');
        return root ? `${root}/user/balance` : null;
    }
    if (p === 'moonshot' || host.includes('api.moonshot.cn') || host.includes('api.moonshot.ai')) {
        return `${base}/users/me/balance`;
    }
    if (p === 'siliconflow' || host.includes('api.siliconflow.cn') || host.includes('api.siliconflow.com')) {
        return `${base}/user/info`;
    }
    return null;
}

/** 解析余额请求：balance_url 覆盖优先 → 三家内置；均不命中返回 null（不支持，不报错） */
export function resolveBalanceEndpoint(ctx: BalanceRequestContext): BalanceEndpoint | null {
    const overrides = ctx.request && typeof ctx.request === 'object' ? ctx.request : {};
    let url = '';
    if (typeof overrides.balance_url === 'string' && overrides.balance_url.trim()) {
        url = overrides.balance_url.trim();
    } else {
        const native = nativeBalanceUrl(ctx);
        if (!native) return null;
        url = native;
    }
    return { url, headers: buildHeaders(ctx, overrides) };
}

/** 宽松数字强转：字符串/数字都可；空/null/非有限数返回 null */
function toNumber(v: unknown): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** 取某字段数值；缺省/不可转返回 null（区别于 toNumber 的 0） */
function fieldNumber(obj: any, key: string): number | null {
    if (!obj || typeof obj !== 'object') return null;
    return toNumber(obj[key]);
}

function snippet(obj: any, max = 120): string {
    try {
        const s = JSON.stringify(obj);
        return s ? (s.length > max ? s.slice(0, max) + '…' : s) : '(空响应)';
    } catch {
        return String(obj).slice(0, max);
    }
}

// ---------------- 三家解析（防呆：候选键 + 数字强转；结构识别失败抛可读错误） ----------------

function parseDeepSeek(data: any): BalanceEntry[] {
    const list = Array.isArray(data?.balance_infos) ? data.balance_infos : null;
    if (!list || list.length === 0) {
        throw new Error(`未识别 DeepSeek 余额结构（缺 balance_infos）: ${snippet(data)}`);
    }
    const entries: BalanceEntry[] = [];
    for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const currency = typeof it.currency === 'string' && it.currency ? it.currency : '';
        const available = fieldNumber(it, 'total_balance');
        if (available === null) {
            throw new Error(`未识别 DeepSeek 余额字段 total_balance: ${snippet(it)}`);
        }
        const parts: Array<{ label: string; amount: number }> = [];
        const toppedUp = fieldNumber(it, 'topped_up_balance');
        const granted = fieldNumber(it, 'granted_balance');
        if (toppedUp !== null && toppedUp !== 0) parts.push({ label: '充值', amount: toppedUp });
        if (granted !== null && granted !== 0) parts.push({ label: '赠送', amount: granted });
        entries.push({
            currency,
            available,
            parts: parts.length > 0 ? parts : undefined,
            availableFlag: data.is_available !== false,
        });
    }
    if (entries.length === 0) throw new Error(`DeepSeek 余额列表为空: ${snippet(data)}`);
    return entries;
}

function parseMoonshot(data: any, baseUrl: string): BalanceEntry[] {
    // 错误信封：HTTP 200 + status:false（部分网关行为），把 message 带进错误
    if (data && typeof data === 'object' && data.status === false) {
        const msg = typeof data.message === 'string' && data.message ? data.message : snippet(data);
        throw new Error(`余额接口返回错误: ${msg}`);
    }
    const d = data && typeof data === 'object' && data.data && typeof data.data === 'object' ? data.data : data;
    const available = fieldNumber(d, 'available_balance');
    if (available === null) {
        throw new Error(`未识别 Moonshot 余额字段 available_balance: ${snippet(data)}`);
    }
    const parts: Array<{ label: string; amount: number }> = [];
    const cash = fieldNumber(d, 'cash_balance');
    const voucher = fieldNumber(d, 'voucher_balance');
    if (cash !== null && cash !== 0) parts.push({ label: '现金', amount: cash });
    if (voucher !== null && voucher !== 0) parts.push({ label: '券', amount: voucher });
    const currency = hostOf(baseUrl).includes('api.moonshot.cn') ? 'CNY' : 'USD';
    return [{ currency, available, parts: parts.length > 0 ? parts : undefined, availableFlag: true }];
}

function parseSiliconFlow(data: any, baseUrl: string): BalanceEntry[] {
    if (data && typeof data === 'object' && data.status === false) {
        const msg = typeof data.message === 'string' && data.message ? data.message : snippet(data);
        throw new Error(`余额接口返回错误: ${msg}`);
    }
    const d = data && typeof data === 'object' && data.data && typeof data.data === 'object' ? data.data : data;
    if (!d || typeof d !== 'object') throw new Error(`未识别 SiliconFlow 余额结构: ${snippet(data)}`);
    // 可用余额候选键（社区实现口径 data.balance；兼容可能的 data.totalBalance 兜底）
    let available: number | null = null;
    for (const key of ['balance', 'totalBalance', 'chargeBalance']) {
        const n = fieldNumber(d, key);
        if (n !== null) { available = n; break; }
    }
    if (available === null) {
        throw new Error(`未识别 SiliconFlow 余额字段（候选 balance/totalBalance/chargeBalance）: ${snippet(d)}`);
    }
    const parts: Array<{ label: string; amount: number }> = [];
    const charge = fieldNumber(d, 'chargeBalance');
    const total = fieldNumber(d, 'totalBalance');
    if (charge !== null && charge !== 0 && charge !== available) parts.push({ label: '充值', amount: charge });
    if (total !== null && total !== 0 && total !== available) parts.push({ label: '总额', amount: total });
    const currency = hostOf(baseUrl).includes('api.siliconflow.com') ? 'USD' : 'CNY';
    return [{ currency, available, parts: parts.length > 0 ? parts : undefined, availableFlag: true }];
}

// ---------------- 自定义网关键解析（[request] balance_*） ----------------

/** 极简点路径取值：只支持对象链（如 data.quota），不支持数组下标 */
function readPath(obj: any, path: string): unknown {
    const parts = String(path || '').split('.').map(s => s.trim()).filter(s => s !== '');
    let cur = obj;
    for (const part of parts) {
        if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as any)[part];
    }
    return cur;
}

function parseCustom(data: any, request: Record<string, any>): BalanceEntry[] {
    const path = typeof request.balance_json_path === 'string' && request.balance_json_path.trim()
        ? request.balance_json_path.trim()
        : '';
    if (!path) {
        throw new Error('配置了 balance_url 但缺少 balance_json_path（余额数字所在路径，如 data.quota）');
    }
    const raw = readPath(data, path);
    const n = toNumber(raw);
    if (n === null) {
        throw new Error(`按 balance_json_path="${path}" 未取到数字: ${snippet(data)}`);
    }
    const divisorRaw = Number(request.balance_divisor);
    const divisor = Number.isFinite(divisorRaw) && divisorRaw > 0 ? divisorRaw : 1;
    const currency = typeof request.balance_currency === 'string' ? request.balance_currency.trim() : '';
    return [{ currency, available: n / divisor, availableFlag: true }];
}

/**
 * 解析余额响应体为条目（纯函数，供单测直接打 fixture；网络层不在此）。
 * 自定义网关（[request].balance_url 已配）→ 按 balance_* 解析；否则按 provider 分派。
 */
export function parseBalancePayload(provider: string, data: any, ctx?: { baseUrl?: string; request?: Record<string, any> }): BalanceEntry[] {
    const request = ctx?.request && typeof ctx.request === 'object' ? ctx.request : {};
    const baseUrl = ctx?.baseUrl ?? '';
    if (typeof request.balance_url === 'string' && request.balance_url.trim()) {
        return parseCustom(data, request);
    }
    const p = (provider || '').toLowerCase();
    if (p === 'deepseek' || hostOf(baseUrl).includes('api.deepseek.com')) return parseDeepSeek(data);
    if (p === 'moonshot' || hostOf(baseUrl).includes('api.moonshot.cn') || hostOf(baseUrl).includes('api.moonshot.ai')) return parseMoonshot(data, baseUrl);
    if (p === 'siliconflow' || hostOf(baseUrl).includes('api.siliconflow.cn') || hostOf(baseUrl).includes('api.siliconflow.com')) return parseSiliconFlow(data, baseUrl);
    // 走到这里说明 resolveBalanceEndpoint 已放行（有 balance_url）但解析未走 custom → 配置不一致
    throw new Error(`该连接未配置余额解析方式（provider=${provider || '(空)'}）`);
}

/** GET JSON：超时用 Promise.race（goja 无 AbortController，与列表拉取一致） */
async function httpGetJson(url: string, headers: Record<string, string>, timeoutMs: number, provider: string): Promise<any> {
    const doFetch = (async () => {
        const response = await fetch(url, { method: 'GET', headers });
        const text = await response.text();
        if (!response.ok) {
            throw ApiError.fromResponse(response.status, provider, text);
        }
        if (!text) {
            throw new Error('响应体为空');
        }
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`解析响应体时出错:${e instanceof Error ? e.message : String(e)}\n响应体:${text.slice(0, 200)}`);
        }
    })();
    return await Promise.race([
        doFetch,
        new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`余额查询超时 (${timeoutMs}ms)`)), timeoutMs);
        }),
    ]);
}

/** 发起余额查询（调用前应先用 resolveBalanceEndpoint 确认支持；失败抛 Error/ApiError） */
export async function fetchBalance(ctx: BalanceRequestContext): Promise<BalanceEntry[]> {
    const overrides = ctx.request && typeof ctx.request === 'object' ? ctx.request : {};
    const timeoutMs = Number(overrides.timeout) > 0 ? Number(overrides.timeout) * 1000 : BALANCE_FETCH_TIMEOUT_MS;
    const ep = resolveBalanceEndpoint(ctx);
    if (!ep) {
        throw new Error('该连接无内置余额接口且未配置 balance_url');
    }
    const data = await httpGetJson(ep.url, ep.headers, timeoutMs, ctx.provider);
    return parseBalancePayload(ctx.provider, data, { baseUrl: ctx.baseUrl, request: ctx.request });
}

/** 将余额查询错误转成可展示的短文案（供命令按连接降级展示） */
export function describeBalanceError(e: any): { kind: string, text: string } {
    if (e instanceof ApiError) {
        const kindLabel: { [k: string]: string } = {
            auth: '认证失败',
            permission: '权限不足',
            balance: '余额不足',
            rate_limit: '触发限流',
            overloaded: '服务繁忙',
            server: '服务端错误',
            invalid_request: '请求参数错误',
            context_too_long: '上下文超长',
            model_not_found: '模型不存在',
            content_filter: '内容安全拦截',
        };
        const label = kindLabel[e.kind] ?? (e.status >= 400 && e.status < 500 ? '请求被拒绝' : '服务端错误');
        const snippetText = String(e.message ?? '').replace(/\n+/g, ' ').slice(0, 120);
        return { kind: e.kind, text: `${label}${e.status ? `(${e.status})` : ''} ${snippetText}`.trim() };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'unknown', text: msg.slice(0, 120) };
}
