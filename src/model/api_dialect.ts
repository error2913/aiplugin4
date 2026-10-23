// 协议方言判定：把"是不是 anthropic"这类**按厂商名猜协议**的硬编码集中到一处。
//
// v4 的问题：`provider` 字符串同时承担「厂商 + 协议 + 鉴权方式」，同一判断散落在
// provider.ts / adapter.ts / list.ts / model.ts / session.ts 共 7 处。新增一家
// 用 Messages 协议的中转站，必须改插件源码。
//
// v5 改为按 `api` 字段分派（config/v5/schema.ts 的 ApiDialect）。
// 兼容策略：`api` 缺省时**退回按 provider 名推断**，这样
//   - v4 迁移期的连接（适配层会填 api，但旧用例可能不填）
//   - 既有单测里直接构造的 ConnConfigLike
// 都能照常工作，不会因为缺少新字段而行为突变。

import { API_DIALECTS, ApiDialect } from "../config/v5/schema";

/** 已知厂商 → 协议（仅用于 `api` 缺省时的兜底推断） */
const PROVIDER_DEFAULT_API: Record<string, ApiDialect> = {
    anthropic: 'anthropic-messages',
};

export const DEFAULT_API: ApiDialect = 'openai-completions';

/**
 * 归一出一条连接实际使用的协议。
 * @param api     配置里显式声明的协议（优先）
 * @param provider 厂商标识（`api` 缺省时据此推断）
 */
export function resolveApiDialect(api?: string, provider?: string): ApiDialect {
    const a = String(api ?? '').trim();
    // 合法方言唯一来源：config/v5/schema.API_DIALECTS（避免本文件再抄一份字符串）
    if ((API_DIALECTS as string[]).includes(a)) return a as ApiDialect;
    const p = String(provider ?? '').trim().toLowerCase();
    return PROVIDER_DEFAULT_API[p] ?? DEFAULT_API;
}

/** 是否走 Anthropic Messages 协议（请求体/响应/鉴权/URL/列表 都据此分派） */
export function isAnthropicMessages(api?: string, provider?: string): boolean {
    return resolveApiDialect(api, provider) === 'anthropic-messages';
}

/** 是否走 OpenAI Responses 协议（本期未实现，据实报错而不是静默走错协议） */
export function isOpenAiResponses(api?: string, provider?: string): boolean {
    return resolveApiDialect(api, provider) === 'openai-responses';
}
