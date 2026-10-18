// 内置方言适配器（10 家）+ generic 工厂
//
// 各家格式见 docs/18 §6.7。适配器只负责「构造请求」与「把响应归一化」，
// HTTP、超时、重试、路由回退在 client.ts / service.ts。

import { asText, getByPath, renderTemplate, renderText } from './template';
import { DialectAdapter, SearchInput, WebProviderRuntime, WebSearchItem } from './types';

// ------------------------------------------------------------------ 小工具

function joinURL(baseURL: string, path: string): string {
    const base = String(baseURL ?? '').replace(/\/+$/, '');
    return `${base}${path}`;
}

function clamp(n: number, min: number, max: number): number {
    const v = Number.isFinite(n) ? Math.floor(n) : min;
    return Math.min(max, Math.max(min, v));
}

function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(extra ?? {}),
    };
}

/** Bearer 鉴权头（key 为空时不发 Authorization，避免部分网关直接拒绝） */
function bearer(key: string, extra?: Record<string, string>): Record<string, string> {
    const h = jsonHeaders(extra);
    if (key) h['Authorization'] = `Bearer ${key}`;
    return h;
}

/** 自定义鉴权头（Brave / Serper / Exa） */
function headerAuth(key: string, headerName: string, extra?: Record<string, string>): Record<string, string> {
    const h = jsonHeaders(extra);
    if (key) h[headerName] = key;
    return h;
}

function withProviderHeaders(base: Record<string, string>, provider: WebProviderRuntime): Record<string, string> {
    return { ...base, ...(provider.headers ?? {}) };
}

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function asObject(v: unknown): Record<string, any> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** 时间范围 → 天数；非法返回 0 */
function timeRangeDays(timeRange?: string): number {
    if (timeRange === 'day') return 1;
    if (timeRange === 'week') return 7;
    if (timeRange === 'month') return 30;
    if (timeRange === 'year') return 365;
    return 0;
}

/** 时间范围 → `after:YYYY-MM-DD`（DeepSeek 等支持操作符的引擎） */
export function timeRangeAfter(timeRange?: string): string {
    const days = timeRangeDays(timeRange);
    if (!days) return '';
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `after:${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 追加 site:/ -site: / after: 操作符（只用于「把 query 原样交给搜索引擎」的方言） */
export function withQueryOperators(query: string, input: SearchInput, opts: { site?: boolean; after?: boolean }): string {
    const parts: string[] = [String(query ?? '').trim()];
    if (opts.site) {
        const allowed = (input.allowedDomains ?? []).map(s => s.trim()).filter(Boolean);
        if (allowed.length === 1) parts.push(`site:${allowed[0]}`);
        else if (allowed.length > 1) parts.push(`(${allowed.map(d => `site:${d}`).join(' OR ')})`);
        for (const d of (input.blockedDomains ?? []).map(s => s.trim()).filter(Boolean)) parts.push(`-site:${d}`);
    }
    if (opts.after) {
        const after = timeRangeAfter(input.timeRange);
        if (after) parts.push(after);
    }
    return parts.filter(Boolean).join(' ');
}

/** 值 → 字符串（数组按空格拼接，用于 exa highlights 等） */
function pickText(v: unknown): string {
    if (Array.isArray(v)) return v.map(x => asText(x)).filter(Boolean).join(' ');
    return asText(v);
}

/** 从泛型结果数组提取归一化条目（字段路径由 fields 指定） */
function mapItems(raw: unknown, fields: Record<string, string>): WebSearchItem[] {
    const out: WebSearchItem[] = [];
    for (const item of asArray(raw)) {
        const rec = asObject(item);
        const pick = (key: string): string => {
            const path = fields[key];
            if (!path) return '';
            return pickText(getByPath(rec, path));
        };
        const title = pickText(getByPath(rec, fields.title ?? 'title'));
        const url = pickText(getByPath(rec, fields.url ?? 'url'));
        if (!title && !url) continue;
        const scoreRaw = getByPath(rec, fields.score ?? '');
        const score = typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : undefined;
        out.push({
            title,
            url,
            snippet: pick('snippet') || undefined,
            summary: pick('summary') || undefined,
            content: pick('content') || undefined,
            date: pick('date') || undefined,
            site: pick('site') || undefined,
            score,
        });
    }
    return out;
}

const COMMON_FIELDS: Record<string, string> = {
    title: 'title',
    url: 'url',
    snippet: 'snippet',
    summary: 'summary',
    content: 'content',
    date: 'date',
    site: 'site',
    score: 'score',
};

// ------------------------------------------------------------------ 各家适配器

const deepseek: DialectAdapter = {
    dialect: 'deepseek',
    defaultBaseURL: 'https://api.deepseek.com',
    needKey: true,
    supportsFetch: true,
    buildSearch(baseURL, apiKey, input, provider) {
        const body: Record<string, unknown> = {
            query: withQueryOperators(input.query, input, { site: true, after: true }),
            count: clamp(input.count, 1, 50),
        };
        if (input.detail === 'content') body.need_content = true;
        if (input.oriQuestion) body.ori_question = input.oriQuestion;
        return {
            method: 'POST',
            url: joinURL(baseURL, '/v1/tools/search'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        return mapItems(asObject(data).results, COMMON_FIELDS);
    },
    buildFetch(baseURL, apiKey, url, provider) {
        return {
            method: 'POST',
            url: joinURL(baseURL, '/v1/tools/fetch'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body: { url },
            provider: provider.id,
        };
    },
    parseFetch(data) {
        const obj = asObject(data);
        return { title: asText(obj.title), content: asText(obj.content) };
    },
    countHandledByApi: true,
};

const searxng: DialectAdapter = {
    dialect: 'searxng',
    defaultBaseURL: 'https://searxng.fishwhite.top',
    needKey: false,
    supportsFetch: false,
    buildSearch(baseURL, _apiKey, input, provider) {
        // 兼容旧行为：page 拆成两个「半页」（1=前半页、2=后半页……）
        const page = input.page && input.page > 0
            ? Math.floor(input.page)
            : Math.floor(input.offset / Math.max(1, input.count)) + 1;
        const pageno = Math.ceil(page / 2);
        const q = withQueryOperators(input.query, input, { site: true, after: false });
        let url = `${joinURL(baseURL, '/search')}?q=${encodeURIComponent(q)}&format=json&pageno=${pageno}`;
        if (input.timeRange && ['day', 'month', 'year'].includes(input.timeRange)) {
            url += `&time_range=${encodeURIComponent(input.timeRange)}`;
        }
        return { method: 'GET', url, headers: withProviderHeaders(jsonHeaders(), provider), provider: provider.id };
    },
    parseSearch(data, input) {
        const results = asArray(asObject(data).results);
        const page = input.page && input.page > 0
            ? Math.floor(input.page)
            : Math.floor(input.offset / Math.max(1, input.count)) + 1;
        const part = ((page - 1) % 2) + 1;
        const half = Math.ceil(results.length / 2);
        const sliced = part === 1 ? results.slice(0, half) : results.slice(half);
        return sliced.map(item => {
            const rec = asObject(item);
            const score = typeof rec.score === 'number' && Number.isFinite(rec.score) ? rec.score : undefined;
            return {
                title: asText(rec.title),
                url: asText(rec.url),
                // SearXNG 的 content 就是短摘要
                snippet: asText(rec.content) || undefined,
                score,
            };
        }).filter(it => it.title || it.url);
    },
    countHandledByApi: false,
};

const kimi: DialectAdapter = {
    dialect: 'kimi',
    defaultBaseURL: 'https://api.moonshot.ai',
    needKey: true,
    supportsFetch: true,
    buildSearch(baseURL, apiKey, input, provider) {
        const body: Record<string, unknown> = {
            text_query: input.query,
            limit: clamp(input.count, 1, 20),
        };
        if (input.detail === 'content') body.include_content = true;
        return {
            method: 'POST',
            url: joinURL(baseURL, '/v1/tools/search'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        const fields = { ...COMMON_FIELDS, content: 'text', site: 'site_name', date: 'date' };
        return mapItems(asObject(data).search_results, fields);
    },
    buildFetch(baseURL, apiKey, url, provider) {
        return {
            method: 'POST',
            url: joinURL(baseURL, '/v1/tools/fetch'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body: { url },
            provider: provider.id,
        };
    },
    parseFetch(data) {
        const obj = asObject(data);
        return { title: asText(obj.title), content: asText(obj.markdown) };
    },
    countHandledByApi: true,
};

const brave: DialectAdapter = {
    dialect: 'brave',
    defaultBaseURL: 'https://api.search.brave.com',
    needKey: true,
    supportsFetch: false,
    buildSearch(baseURL, apiKey, input, provider) {
        const freshness: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
        const params = [
            `q=${encodeURIComponent(withQueryOperators(input.query, input, { site: true, after: false }))}`,
            `count=${clamp(input.count, 1, 20)}`,
            `offset=${clamp(input.offset, 0, 9)}`,
        ];
        if (input.timeRange && freshness[input.timeRange]) params.push(`freshness=${freshness[input.timeRange]}`);
        return {
            method: 'GET',
            url: `${joinURL(baseURL, '/res/v1/web/search')}?${params.join('&')}`,
            headers: withProviderHeaders(headerAuth(apiKey, 'X-Subscription-Token'), provider),
            provider: provider.id,
        };
    },
    parseSearch(data) {
        const web = asObject(asObject(data).web);
        return mapItems(web.results, { ...COMMON_FIELDS, snippet: 'description', date: 'page_age' });
    },
    countHandledByApi: true,
};

const tavily: DialectAdapter = {
    dialect: 'tavily',
    defaultBaseURL: 'https://api.tavily.com',
    needKey: true,
    supportsFetch: true,
    buildSearch(baseURL, apiKey, input, provider) {
        const body: Record<string, unknown> = {
            query: input.query,
            max_results: clamp(input.count, 1, 20),
            search_depth: 'basic',
        };
        if (input.allowedDomains?.length) body.include_domains = input.allowedDomains;
        if (input.blockedDomains?.length) body.exclude_domains = input.blockedDomains;
        if (input.timeRange) body.time_range = input.timeRange;
        if (input.detail === 'content') body.include_raw_content = true;
        return {
            method: 'POST',
            url: joinURL(baseURL, '/search'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        return mapItems(asObject(data).results, {
            ...COMMON_FIELDS,
            snippet: 'content',
            content: 'raw_content',
            date: 'published_date',
        });
    },
    buildFetch(baseURL, apiKey, url, provider) {
        return {
            method: 'POST',
            url: joinURL(baseURL, '/extract'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body: { urls: [url] },
            provider: provider.id,
        };
    },
    parseFetch(data) {
        const obj = asObject(data);
        const first = asObject(asArray(obj.results)[0]);
        const content = asText(first.raw_content);
        if (!content) {
            const failed = asObject(asArray(obj.failed_results)[0]);
            throw new Error(asText(failed.error) || 'Tavily 未返回页面正文');
        }
        return { title: '', content };
    },
    countHandledByApi: true,
};

const serper: DialectAdapter = {
    dialect: 'serper',
    defaultBaseURL: 'https://google.serper.dev',
    needKey: true,
    supportsFetch: false,
    buildSearch(baseURL, apiKey, input, provider) {
        return {
            method: 'POST',
            url: joinURL(baseURL, '/search'),
            headers: withProviderHeaders(headerAuth(apiKey, 'X-API-KEY'), provider),
            body: {
                q: withQueryOperators(input.query, input, { site: true, after: false }),
                num: clamp(input.count, 1, 100),
                ...(input.timeRange ? { tbs: timeRangeToTbs(input.timeRange) } : {}),
            },
            provider: provider.id,
        };
    },
    parseSearch(data) {
        return mapItems(asObject(data).organic, { ...COMMON_FIELDS, url: 'link', site: 'source' });
    },
    countHandledByApi: true,
};

const bocha: DialectAdapter = {
    dialect: 'bocha',
    defaultBaseURL: 'https://api.bocha.cn',
    needKey: true,
    supportsFetch: false,
    buildSearch(baseURL, apiKey, input, provider) {
        const freshness: Record<string, string> = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' };
        const body: Record<string, unknown> = {
            query: input.query,
            count: clamp(input.count, 1, 50),
            // 长摘要需要显式开启；detail=snippet 时不请求，省一次长摘要成本
            summary: input.detail !== 'snippet',
        };
        if (input.timeRange && freshness[input.timeRange]) body.freshness = freshness[input.timeRange];
        if (input.allowedDomains?.length) body.include = input.allowedDomains.join(',');
        if (input.blockedDomains?.length) body.exclude = input.blockedDomains.join(',');
        return {
            method: 'POST',
            url: joinURL(baseURL, '/v1/web-search'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        const value = asObject(asObject(asObject(data).data).webPages).value;
        return mapItems(value, {
            ...COMMON_FIELDS,
            title: 'name',
            site: 'siteName',
            date: 'datePublished',
        });
    },
    countHandledByApi: true,
};

const zhipu: DialectAdapter = {
    dialect: 'zhipu',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    needKey: true,
    supportsFetch: false,
    buildSearch(baseURL, apiKey, input, provider) {
        const recency: Record<string, string> = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' };
        const body: Record<string, unknown> = {
            search_query: input.query,
            search_engine: 'search_std',
            search_intent: false,
            count: clamp(input.count, 1, 50),
        };
        if (input.timeRange && recency[input.timeRange]) body.search_recency_filter = recency[input.timeRange];
        if (input.allowedDomains?.length) body.search_domain_filter = input.allowedDomains.join(',');
        return {
            method: 'POST',
            url: joinURL(baseURL, '/web_search'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        return mapItems(asObject(data).search_result, {
            ...COMMON_FIELDS,
            url: 'link',
            site: 'media',
            date: 'publish_date',
        });
    },
    countHandledByApi: true,
};

const exa: DialectAdapter = {
    dialect: 'exa',
    defaultBaseURL: 'https://api.exa.ai',
    needKey: true,
    supportsFetch: true,
    buildSearch(baseURL, apiKey, input, provider) {
        const body: Record<string, unknown> = {
            query: input.query,
            numResults: clamp(input.count, 1, 100),
            type: 'auto',
        };
        if (input.allowedDomains?.length) body.includeDomains = input.allowedDomains;
        if (input.blockedDomains?.length) body.excludeDomains = input.blockedDomains;
        if (input.timeRange) {
            const days = timeRangeDays(input.timeRange);
            if (days) body.startPublishedDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        }
        if (input.detail === 'content') body.contents = { text: true };
        else body.contents = { highlights: true };
        return {
            method: 'POST',
            url: joinURL(baseURL, '/search'),
            headers: withProviderHeaders(headerAuth(apiKey, 'x-api-key'), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        return mapItems(asObject(data).results, {
            ...COMMON_FIELDS,
            content: 'text',
            snippet: 'highlights',
            date: 'publishedDate',
        });
    },
    buildFetch(baseURL, apiKey, url, provider) {
        return {
            method: 'POST',
            url: joinURL(baseURL, '/contents'),
            headers: withProviderHeaders(headerAuth(apiKey, 'x-api-key'), provider),
            body: { urls: [url], text: true },
            provider: provider.id,
        };
    },
    parseFetch(data) {
        const first = asObject(asArray(asObject(data).results)[0]);
        const content = asText(first.text);
        if (!content) throw new Error('Exa 未返回页面正文');
        return { title: asText(first.title), content };
    },
    countHandledByApi: true,
};

function timeRangeToTbs(timeRange?: string): string {
    if (timeRange === 'day') return 'qdr:d';
    if (timeRange === 'week') return 'qdr:w';
    if (timeRange === 'month') return 'qdr:m';
    if (timeRange === 'year') return 'qdr:y';
    return '';
}

const firecrawl: DialectAdapter = {
    dialect: 'firecrawl',
    defaultBaseURL: 'https://api.firecrawl.dev/v1',
    needKey: true,
    supportsFetch: true,
    buildSearch(baseURL, apiKey, input, provider) {
        const body: Record<string, unknown> = {
            query: withQueryOperators(input.query, input, { site: true, after: false }),
            limit: clamp(input.count, 1, 100),
        };
        if (input.timeRange) {
            const tbs = timeRangeToTbs(input.timeRange);
            if (tbs) body.tbs = tbs;
        }
        // 只有 detail=content 才顺带抓正文；否则只拿标题/描述，避免无谓的抓取与上下文膨胀
        if (input.detail === 'content') body.scrapeOptions = { formats: ['markdown'] };
        return {
            method: 'POST',
            url: joinURL(baseURL, '/search'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body,
            provider: provider.id,
        };
    },
    parseSearch(data) {
        return mapItems(asObject(data).data, {
            ...COMMON_FIELDS,
            content: 'markdown',
            snippet: 'description',
        });
    },
    buildFetch(baseURL, apiKey, url, provider) {
        return {
            method: 'POST',
            url: joinURL(baseURL, '/scrape'),
            headers: withProviderHeaders(bearer(apiKey), provider),
            body: { url, formats: ['markdown'] },
            provider: provider.id,
        };
    },
    parseFetch(data) {
        const obj = asObject(data);
        const content = asText(asObject(obj.data).markdown);
        if (!content) throw new Error('Firecrawl 未返回页面正文');
        return { title: asText(asObject(asObject(obj.data).metadata).title), content };
    },
    countHandledByApi: true,
};

// ------------------------------------------------------------------ generic

/**
 * generic 方言：用户用 JSON 描述请求与取数。
 * 可用占位符：{query} {count} {offset} {page} {need_content} {time_range} {site} {apiKey} {baseURL}
 */
export function genericAdapter(provider: WebProviderRuntime): DialectAdapter {
    return {
        dialect: 'generic',
        defaultBaseURL: '',
        needKey: false,
        supportsFetch: !!provider.genericFetch,
        buildSearch(baseURL, apiKey, input, p) {
            const desc = p.genericSearch ?? {};
            const vars: Record<string, unknown> = {
                query: input.query,
                count: input.count,
                offset: input.offset,
                page: input.page ?? Math.floor(input.offset / Math.max(1, input.count)) + 1,
                need_content: input.detail === 'content',
                time_range: input.timeRange ?? '',
                site: (input.allowedDomains ?? []).join(' OR '),
                apiKey,
                baseURL,
            };
            const path = renderText(desc.path ?? '/search', vars);
            const qp = desc.query ?? {};
            const pairs = Object.keys(qp)
                .map(k => {
                    const v = renderTemplate(qp[k], vars);
                    return v === undefined ? '' : `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
                })
                .filter(Boolean);
            const url = joinURL(baseURL, path) + (pairs.length ? `?${pairs.join('&')}` : '');
            const body = desc.body !== undefined ? renderTemplate(desc.body, vars) : undefined;
            const headers = {
                ...jsonHeaders(renderTemplate(desc.headers ?? {}, vars) as Record<string, string>),
                ...(p.headers ?? {}),
            };
            return {
                method: String(desc.method ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
                url,
                headers,
                body,
                provider: p.id,
            };
        },
        parseSearch(data) {
            const desc = provider.genericSearch ?? {};
            const results = getByPath(data, desc.results_path ?? 'results');
            return mapItems(results, { ...COMMON_FIELDS, ...(desc.fields ?? {}) });
        },
        buildFetch(baseURL, apiKey, url, p) {
            const desc = p.genericFetch ?? {};
            const vars: Record<string, unknown> = { url, apiKey, baseURL };
            const path = renderText(desc.path ?? '', vars);
            const body = desc.body !== undefined ? renderTemplate(desc.body, vars) : undefined;
            return {
                method: String(desc.method ?? 'GET').toUpperCase() === 'GET' ? 'GET' : 'POST',
                url: joinURL(baseURL, path),
                headers: {
                    ...jsonHeaders(renderTemplate(desc.headers ?? {}, vars) as Record<string, string>),
                    ...(p.headers ?? {}),
                },
                body,
                provider: p.id,
            };
        },
        parseFetch(data) {
            const desc = provider.genericFetch ?? {};
            if (desc.response_type === 'text') {
                return { title: '', content: typeof data === 'string' ? data : asText(data) };
            }
            const title = asText(getByPath(data, desc.title_path ?? 'title'));
            const content = asText(getByPath(data, desc.content_path ?? 'content'));
            return { title, content };
        },
        countHandledByApi: true,
    };
}

// ------------------------------------------------------------------ 注册表

export const ADAPTERS: Record<string, DialectAdapter> = {
    deepseek,
    searxng,
    kimi,
    brave,
    tavily,
    serper,
    bocha,
    zhipu,
    exa,
    firecrawl,
};

export const DIALECT_IDS = [...Object.keys(ADAPTERS), 'generic'];

export function getAdapter(provider: WebProviderRuntime): DialectAdapter | null {
    if (provider.dialect === 'generic') return genericAdapter(provider);
    return ADAPTERS[provider.dialect] ?? null;
}

/** 方言缺省 baseURL（generic 为空） */
export function defaultBaseURL(dialect: string): string {
    return ADAPTERS[dialect]?.defaultBaseURL ?? '';
}
