// 联网服务层：路由选择、失败回退、结果归一化与渲染。
//
// 不依赖 seal / Config：可以注入 fetch 与 sleep 做纯逻辑单测。

import { executeRequest, isRetryable, shouldFallback } from './client';
import { getAdapter } from './presets';
import {
    BuiltRequest, SearchInput, WebConfig, WebFetchResult, WebProviderRuntime, WebSearchItem, WebSearchResult,
} from './types';

export interface ServiceDeps {
    fetchImpl?: typeof fetch;
    /** 重试间隔（毫秒）；测试可注入 0 */
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 占位 key（生成器/出厂示例里的 sk-xxxx）视为未配置，不发注定 401 的请求 */
export function isPlaceholderKey(key: string): boolean {
    const k = String(key ?? '').trim();
    if (!k) return true;
    return /^sk-(x+|\.\.\.)$/i.test(k);
}

function providerById(config: WebConfig, id: string): WebProviderRuntime | undefined {
    return config.providers.find(p => p.id === id);
}

function orderedProviders(config: WebConfig, kind: 'search' | 'fetch'): WebProviderRuntime[] {
    const ids = config.routes[kind];
    if (ids && ids.length > 0) {
        return ids.map(id => providerById(config, id)).filter((p): p is WebProviderRuntime => !!p);
    }
    return config.providers.slice();
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function truncateContent(input: SearchInput, maxContentChars: number, items: WebSearchItem[]): WebSearchItem[] {
    return items.map(item => {
        let next = item;
        // detail=snippet 不返回长摘要（部分方言总是带 summary，如 bocha）
        if (input.detail === 'snippet' && next.summary) next = { ...next, summary: undefined };
        if (!next.content) return next;
        // 非 content 详细程度不携带正文：避免把整页塞进上下文（部分方言总是返回 markdown）
        if (input.detail !== 'content') return { ...next, content: undefined };
        const limit = Math.max(1, maxContentChars);
        if (next.content.length <= limit) return next;
        return { ...next, content: next.content.slice(0, limit) + '…' };
    });
}

/**
 * 按路由顺序执行搜索；失败回退到下一个 provider。
 * 全部失败时抛出带汇总信息的 Error（工具层转成可读文案）。
 */
export async function runSearch(
    config: WebConfig,
    input: SearchInput,
    deps: ServiceDeps = {},
): Promise<WebSearchResult> {
    const sleep = deps.sleep ?? defaultSleep;
    const retryDelay = deps.retryDelayMs ?? 300;
    const attempts: { provider: string; message: string }[] = [];

    for (const provider of orderedProviders(config, 'search')) {
        if (!provider.enabled) continue;
        const adapter = getAdapter(provider);
        if (!adapter) {
            attempts.push({ provider: provider.id, message: `未知方言 ${provider.dialect}` });
            continue;
        }
        if (adapter.needKey && isPlaceholderKey(provider.apiKey)) {
            attempts.push({ provider: provider.id, message: '未配置 API Key，已跳过' });
            continue;
        }

        const timeoutMs = (provider.timeout ?? config.defaults.timeout) * 1000;
        let lastError: unknown = null;
        let built: BuiltRequest | null = null;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                built = adapter.buildSearch(provider.baseURL, provider.apiKey, input, provider);
                const data = await executeRequest(built, {
                    timeoutMs,
                    provider: provider.id,
                    fetchImpl: deps.fetchImpl,
                });
                let items = adapter.parseSearch(data, input);
                if (adapter.countHandledByApi === false) items = items.slice(0, Math.max(1, input.count));
                items = truncateContent(input, config.defaults.maxContentChars, items);
                return { provider: provider.id, query: input.query, items, attempts };
            } catch (e) {
                lastError = e;
                if (attempt === 0 && isRetryable(e)) {
                    await sleep(retryDelay);
                    continue;
                }
                break;
            }
        }

        attempts.push({ provider: provider.id, message: errMessage(lastError) });
        if (!shouldFallback(lastError)) {
            // 参数/配置错误：不换家，直接把问题暴露出来
            throw new Error(`联网搜索失败（${provider.id}）：${errMessage(lastError)}`);
        }
        if (!config.defaults.fallback) {
            throw new Error(`联网搜索失败（${provider.id}）：${errMessage(lastError)}`);
        }
    }

    if (attempts.length === 0) {
        throw new Error('没有可用的联网搜索 provider：请在「联网 → 联网配置」中至少配置一个，并启用对应的 Key');
    }
    throw new Error(`联网搜索失败，已尝试：\n${attempts.map(a => `- ${a.provider}：${a.message}`).join('\n')}`);
}

/** 按路由顺序执行抓取；失败回退 */
export async function runFetch(
    config: WebConfig,
    url: string,
    deps: ServiceDeps = {},
): Promise<WebFetchResult> {
    const sleep = deps.sleep ?? defaultSleep;
    const retryDelay = deps.retryDelayMs ?? 300;
    const attempts: { provider: string; message: string }[] = [];

    for (const provider of orderedProviders(config, 'fetch')) {
        if (!provider.enabled) continue;
        const adapter = getAdapter(provider);
        if (!adapter || !adapter.buildFetch || !adapter.parseFetch || !adapter.supportsFetch) continue;
        if (adapter.needKey && isPlaceholderKey(provider.apiKey)) {
            attempts.push({ provider: provider.id, message: '未配置 API Key，已跳过' });
            continue;
        }

        const timeoutMs = (provider.timeout ?? config.defaults.timeout) * 1000;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const req = adapter.buildFetch(provider.baseURL, provider.apiKey, url, provider);
                const asText = provider.genericFetch?.response_type === 'text';
                const data = await executeRequest(req, {
                    timeoutMs,
                    provider: provider.id,
                    fetchImpl: deps.fetchImpl,
                    asText,
                });
                const parsed = adapter.parseFetch(data, url);
                return { provider: provider.id, url, title: parsed.title, content: parsed.content, attempts };
            } catch (e) {
                lastError = e;
                if (attempt === 0 && isRetryable(e)) {
                    await sleep(retryDelay);
                    continue;
                }
                break;
            }
        }

        attempts.push({ provider: provider.id, message: errMessage(lastError) });
        if (!shouldFallback(lastError) || !config.defaults.fallback) {
            throw new Error(`网页抓取失败（${provider.id}）：${errMessage(lastError)}`);
        }
    }

    if (attempts.length === 0) {
        throw new Error('没有可用的抓取 provider：需要 DeepSeek / Kimi / Tavily / Exa / Firecrawl，或 generic 抓取描述');
    }
    throw new Error(`网页抓取失败，已尝试：\n${attempts.map(a => `- ${a.provider}：${a.message}`).join('\n')}`);
}

// ------------------------------------------------------------------ 渲染

/** 搜索结果的 markdown 文本（工具返回给模型的内容） */
export function renderSearchResult(result: WebSearchResult): string {
    const items = result.items ?? [];
    if (items.length === 0) {
        return `没有搜索到结果（${result.provider}）。可以换更宽泛的关键词，或去掉域名/时间过滤后再试。`;
    }
    const head = `搜索「${result.query}」：共 ${items.length} 条（${result.provider}）`;
    const lines = items.map((item, i) => {
        const title = item.title || '(无标题)';
        const parts = [`${i + 1}. ${title}`, `   链接：${item.url || '(无链接)'}`];
        const summary = item.summary || item.snippet;
        if (summary) parts.push(`   摘要：${summary}`);
        if (item.content) parts.push(`   正文：${item.content}`);
        const meta: string[] = [];
        if (item.date) meta.push(item.date);
        if (item.site) meta.push(item.site);
        if (typeof item.score === 'number') meta.push(`相关度 ${item.score}`);
        if (meta.length) parts.push(`   ${meta.join(' / ')}`);
        return parts.join('\n');
    });
    return [head, ...lines].join('\n');
}

/** 抓取结果的 markdown 文本；maxChars 只影响本次返回（超出尾部提示续读） */
export function renderFetchResult(result: WebFetchResult, maxChars: number, startIndex = 0): string {
    const content = String(result.content ?? '');
    const start = Math.max(0, Math.floor(startIndex));
    const limit = Math.max(1, Math.floor(maxChars));
    const slice = content.slice(start, start + limit);
    const lines = [
        `标题：${result.title || '(无标题)'}`,
        `来源：${result.url}`,
        '',
        slice,
    ];
    const next = start + slice.length;
    if (start >= content.length && content.length > 0) {
        lines.push('', '[start_index 已到末尾，没有更多内容]');
    } else if (next < content.length) {
        lines.push('', `[内容已截断，可传 start_index=${next} 继续读取]`);
    }
    return lines.join('\n');
}
