// 联网搜索（web）单元测试：纯逻辑，不联网。
//
// 覆盖 docs/18 §6.2/§6.7/§14：配置校验、占位符、10 家方言的请求构造/响应取数、
// 路由回退、渲染与截断。
// 运行：npm run test:unit（由 scripts/test-unit.cjs 打包）
import assert from 'node:assert/strict';

import { resolveWebConfig } from '../src/web/schema';
import { ADAPTERS, getAdapter } from '../src/web/presets';
import { parseWebConfig } from '../src/web/schema';
import { runSearch, runFetch, renderSearchResult, renderFetchResult, isPlaceholderKey } from '../src/web/service';
import { getByPath, renderTemplate } from '../src/web/template';
import { SearchInput, WebConfig, WebProviderRuntime } from '../src/web/types';

// ---------------------------------------------------------------- 构造工具

function input(over: Partial<SearchInput> = {}): SearchInput {
    return {
        query: 'deepseek v4',
        count: 5,
        offset: 0,
        detail: 'summary',
        ...over,
    };
}

function provider(dialect: string, over: Partial<WebProviderRuntime> = {}): WebProviderRuntime {
    return {
        id: dialect,
        dialect,
        baseURL: ADAPTERS[dialect]?.defaultBaseURL ?? '',
        apiKey: 'sk-test',
        enabled: true,
        ...over,
    };
}

function config(over: Partial<WebConfig> = {}): WebConfig {
    return {
        version: 1,
        defaults: { count: 5, detail: 'summary', timeout: 20, maxContentChars: 4000, fallback: true },
        providers: [provider('deepseek')],
        routes: {},
        ...over,
    };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const noSleep = async () => { /* 测试不等待 */ };

// ---------------------------------------------------------------- 用例

export const tests: Record<string, () => void | Promise<void>> = {

    // ---------- schema

    testWebSchemaMinimal(): void {
        const { config: cfg, issues } = parseWebConfig('{"providers":[{"dialect":"deepseek","apiKey":"sk-1"}]}');
        assert.equal(issues.length, 0, JSON.stringify(issues));
        assert.ok(cfg);
        assert.equal(cfg!.providers.length, 1);
        assert.equal(cfg!.providers[0].id, 'deepseek');
        assert.equal(cfg!.providers[0].baseURL, 'https://api.deepseek.com');
        assert.equal(cfg!.defaults.count, 5);
        assert.equal(cfg!.defaults.detail, 'summary');
    },

    testWebSchemaFull(): void {
        const text = JSON.stringify({
            version: 1,
            defaults: { count: 8, detail: 'content', timeout: 9, maxContentChars: 1234, fallback: false },
            providers: [
                { id: 'ds', dialect: 'deepseek', apiKey: 'k' },
                { id: 'g', dialect: 'generic', baseURL: 'https://x.test', search: { path: '/search', fields: { title: 'a.b' } } },
            ],
            routes: { search: ['ds', 'g'], fetch: ['ds'] },
        });
        const { config: cfg, issues } = parseWebConfig(text);
        assert.equal(issues.length, 0, JSON.stringify(issues));
        assert.equal(cfg!.providers[1].genericSearch?.path, '/search');
        assert.deepEqual(cfg!.routes.search, ['ds', 'g']);
        assert.equal(cfg!.defaults.fallback, false);
    },

    testWebSchemaErrors(): void {
        const cases: [string, string][] = [
            ['{bad json', '$'],
            ['{"version":2,"providers":[]}', '$.version'],
            ['{"providers":[{"dialect":"nope"}]}', '$.providers[0].dialect'],
            ['{"providers":[{"dialect":"deepseek"},{"dialect":"deepseek"}]}', '$.providers[1].id'],
            ['{"providers":[{"dialect":"generic"}]}', '$.providers[0].baseURL'],
            ['{"providers":[],"defaults":{"count":0}}', '$.defaults.count'],
            ['{"providers":[],"defaults":{"detail":"x"}}', '$.defaults.detail'],
            ['{"providers":[],"routes":{"search":["missing"]}}', '$.routes.search'],
        ];
        for (const [text, path] of cases) {
            const { config: cfg, issues } = parseWebConfig(text);
            assert.equal(cfg, null, `应拒绝：${text}`);
            assert.ok(issues.some(i => i.path === path), `期望 ${path}，实际 ${JSON.stringify(issues)}`);
        }
    },

    testWebSchemaGenericNeedsSearchOrFetch(): void {
        const { issues } = parseWebConfig('{"providers":[{"dialect":"generic","baseURL":"https://x"}]}');
        assert.ok(issues.some(i => i.path === '$.providers[0].search'));
    },

    // ---------- 模板

    testWebTemplate(): void {
        const out = renderTemplate(
            { n: '{count}', ok: '{need_content}', q: 'x {query}', missing: '{nope}', list: ['{query}', '{nope}'] },
            { count: 5, need_content: true, query: 'q1' },
        ) as Record<string, any>;
        assert.equal(out.n, 5, '整值占位符保留数字类型');
        assert.equal(out.ok, true, '整值占位符保留布尔类型');
        assert.equal(out.q, 'x q1');
        assert.equal('missing' in out, false, '空值键应删除');
        assert.deepEqual(out.list, ['q1'], '数组里的空值应丢弃');

        assert.equal(getByPath({ a: { b: [{ c: 'hit' }] } }, 'a.b.0.c'), 'hit');
        assert.equal(getByPath({}, 'a.b'), undefined);
    },

    // ---------- 配置页签 / 默认配置（确保开箱不报错）

    testWebConfigEmptyIsEmpty(): void {
        const resolved = resolveWebConfig('');
        assert.equal(resolved.issues.length, 0, '空配置不应产生校验错误');
        assert.equal(resolved.config.providers.length, 0, '空配置 = 没有 provider');
        assert.equal(resolved.config.defaults.count, 5);
        assert.equal(resolved.config.defaults.detail, 'summary');
    },

    testWebConfigCustomJson(): void {
        const resolved = resolveWebConfig(JSON.stringify({ providers: [{ dialect: 'deepseek', apiKey: 'sk-1' }] }));
        assert.equal(resolved.issues.length, 0);
        assert.equal(resolved.config.providers[0].dialect, 'deepseek');
        assert.equal(resolved.config.providers[0].apiKey, 'sk-1');
    },

    testWebConfigInvalidFallsBackNoThrow(): void {
        // 坏 JSON 不能抛错：返回空配置 + issues 供日志使用
        const resolved = resolveWebConfig('{ not json');
        assert.ok(resolved.issues.length > 0, '应带回校验问题');
        assert.equal(resolved.config.providers.length, 0, '校验失败 = 空配置，不崩');
    },

    testWebDefaultConfigSearchGivesActionableError: async () => {
        // 默认空配置调用 web_search：不抛到会话，而是给可操作的「去联网页配置」提示
        const cfg = resolveWebConfig('').config;
        let called = false;
        await assert.rejects(
            runSearch(cfg, input(), {
                fetchImpl: (async () => { called = true; return jsonResponse(200, {}); }) as any,
                sleep: noSleep,
            }),
            /没有可用的联网搜索 provider[\s\S]*联网配置/,
        );
        assert.equal(called, false, '没有 provider 时不应发任何请求');
    },

    // ---------- 方言：build

    testWebDeepSeekBuild(): void {
        const req = ADAPTERS.deepseek.buildSearch('https://api.deepseek.com', 'sk-1', input({
            query: 'kimi', allowedDomains: ['github.com'], blockedDomains: ['spam.example'], detail: 'content',
        }), provider('deepseek'));
        assert.equal(req.method, 'POST');
        assert.equal(req.url, 'https://api.deepseek.com/v1/tools/search');
        assert.equal(req.headers.Authorization, 'Bearer sk-1');
        const body = req.body as Record<string, any>;
        assert.equal(body.count, 5);
        assert.equal(body.need_content, true);
        assert.ok(String(body.query).includes('site:github.com'));
        assert.ok(String(body.query).includes('-site:spam.example'));
    },

    testWebSearxngPageAndHeader(): void {
        getAdapter(provider('searxng'))!.buildSearch('https://s.example', '', input({ count: 4 }), provider('searxng'));
        const adapter = ADAPTERS.searxng;
        const req = adapter.buildSearch('https://s.example', '', input({ page: 2, count: 4 }), provider('searxng'));
        assert.ok(req.url.includes('pageno=1'), 'page=2 属于第一页的后半');
        const items = adapter.parseSearch({
            results: [1, 2, 3, 4].map(i => ({ title: `t${i}`, url: `u${i}`, content: `c${i}` })),
        }, input({ page: 2, count: 4 }));
        assert.equal(items.length, 2, '后半页只取一半');
        assert.equal(items[0].title, 't3');
    },

    testWebKimiBuildAndParse(): void {
        const req = ADAPTERS.kimi.buildSearch('https://api.moonshot.ai', 'sk', input({ detail: 'content', count: 9 }), provider('kimi'));
        assert.equal(req.url, 'https://api.moonshot.ai/v1/tools/search');
        const body = req.body as Record<string, any>;
        assert.equal(body.limit, 9);
        assert.equal(body.include_content, true);
        assert.equal(typeof body.text_query, 'string');

        const items = ADAPTERS.kimi.parseSearch({
            search_results: [{ title: 'T', url: 'U', snippet: 'S', text: 'BODY', site_name: 'Site', date: '2026-01-01' }],
        }, input());
        assert.equal(items[0].content, 'BODY');
        assert.equal(items[0].site, 'Site');
    },

    testWebBraveBuild(): void {
        const req = ADAPTERS.brave.buildSearch('https://api.search.brave.com', 'k', input({ timeRange: 'day', count: 3 }), provider('brave'));
        assert.equal(req.method, 'GET');
        assert.ok(req.url.includes('count=3'));
        assert.ok(req.url.includes('freshness=pd'));
        assert.ok(!req.url.includes('after:'), '时间范围走 freshness 参数，不再拼 after:');
        assert.equal(req.headers['X-Subscription-Token'], 'k');
        const items = ADAPTERS.brave.parseSearch({ web: { results: [{ title: 'T', url: 'U', description: 'D', page_age: '2026' }] } }, input());
        assert.equal(items[0].snippet, 'D');
    },

    testWebTavilyBuildAndParse(): void {
        const req = ADAPTERS.tavily.buildSearch('https://api.tavily.com', 'k', input({
            allowedDomains: ['a.com'], blockedDomains: ['b.com'], detail: 'content', timeRange: 'week',
        }), provider('tavily'));
        const body = req.body as Record<string, any>;
        assert.deepEqual(body.include_domains, ['a.com']);
        assert.deepEqual(body.exclude_domains, ['b.com']);
        assert.equal(body.include_raw_content, true);
        assert.equal(body.time_range, 'week');
        const items = ADAPTERS.tavily.parseSearch({
            results: [{ title: 'T', url: 'U', content: 'S', raw_content: 'B', published_date: 'D', score: 0.5 }],
        }, input());
        assert.equal(items[0].content, 'B');
        assert.equal(items[0].snippet, 'S');
        assert.equal(items[0].score, 0.5);
    },

    testWebSerperBuild(): void {
        const req = ADAPTERS.serper.buildSearch('https://google.serper.dev', 'k', input({ count: 7 }), provider('serper'));
        const body = req.body as Record<string, any>;
        assert.equal(body.num, 7);
        assert.equal(req.headers['X-API-KEY'], 'k');
        const items = ADAPTERS.serper.parseSearch({ organic: [{ title: 'T', link: 'L', snippet: 'S' }] }, input());
        assert.equal(items[0].url, 'L');
    },

    testWebBochaBuildAndParse(): void {
        const req = ADAPTERS.bocha.buildSearch('https://api.bocha.cn', 'k', input({ allowedDomains: ['a.com'], blockedDomains: ['b.com'], timeRange: 'month' }), provider('bocha'));
        const body = req.body as Record<string, any>;
        assert.equal(body.summary, true);
        assert.equal(body.include, 'a.com');
        assert.equal(body.exclude, 'b.com');
        assert.equal(body.freshness, 'oneMonth');
        const snippetReq = ADAPTERS.bocha.buildSearch('https://api.bocha.cn', 'k', input({ detail: 'snippet' }), provider('bocha'));
        assert.equal((snippetReq.body as Record<string, any>).summary, false, 'snippet 不请求长摘要');
        const items = ADAPTERS.bocha.parseSearch({
            data: { webPages: { value: [{ name: 'N', url: 'U', snippet: 'S', summary: 'L', siteName: 'Site', datePublished: 'D' }] } },
        }, input());
        assert.equal(items[0].title, 'N');
        assert.equal(items[0].summary, 'L');
        assert.equal(items[0].site, 'Site');
    },

    testWebZhipuBuildAndParse(): void {
        const req = ADAPTERS.zhipu.buildSearch('https://open.bigmodel.cn/api/paas/v4', 'k', input({ allowedDomains: ['a.com'], timeRange: 'day' }), provider('zhipu'));
        const body = req.body as Record<string, any>;
        assert.equal(body.search_engine, 'search_std');
        assert.equal(body.search_intent, false);
        assert.equal(body.search_domain_filter, 'a.com');
        assert.equal(body.search_recency_filter, 'oneDay');
        const items = ADAPTERS.zhipu.parseSearch({ search_result: [{ title: 'T', link: 'L', content: 'C', media: 'M', publish_date: 'D' }] }, input());
        assert.equal(items[0].url, 'L');
        assert.equal(items[0].site, 'M');
    },

    testWebExaBuildAndParse(): void {
        const req = ADAPTERS.exa.buildSearch('https://api.exa.ai', 'k', input({ detail: 'content', allowedDomains: ['a.com'] }), provider('exa'));
        const body = req.body as Record<string, any>;
        assert.deepEqual(body.includeDomains, ['a.com']);
        assert.deepEqual(body.contents, { text: true });
        assert.equal(req.headers['x-api-key'], 'k');
        const summaryReq = ADAPTERS.exa.buildSearch('https://api.exa.ai', 'k', input(), provider('exa'));
        assert.deepEqual((summaryReq.body as Record<string, any>).contents, { highlights: true }, '非 content 用 highlights 取摘要');
        const items = ADAPTERS.exa.parseSearch({
            results: [{ title: 'T', url: 'U', text: 'BODY', highlights: ['h1', 'h2'], publishedDate: 'D' }],
        }, input());
        assert.equal(items[0].content, 'BODY');
        assert.equal(items[0].snippet, 'h1 h2');
    },

    testWebFirecrawlBuildAndParse(): void {
        const req = ADAPTERS.firecrawl.buildSearch('https://api.firecrawl.dev/v1', 'k', input({ count: 4, timeRange: 'day', detail: 'content' }), provider('firecrawl'));
        const body = req.body as Record<string, any>;
        assert.equal(body.limit, 4);
        assert.equal(body.tbs, 'qdr:d');
        assert.ok(!String(body.query).includes('after:'), '时间范围走 tbs 参数，不再拼 after:');
        assert.deepEqual(body.scrapeOptions, { formats: ['markdown'] }, 'detail=content 才抓正文');
        const summaryReq = ADAPTERS.firecrawl.buildSearch('https://api.firecrawl.dev/v1', 'k', input(), provider('firecrawl'));
        assert.equal((summaryReq.body as Record<string, any>).scrapeOptions, undefined, 'summary 不抓正文');
        const items = ADAPTERS.firecrawl.parseSearch({
            data: [{ title: 'T', url: 'U', description: 'D', markdown: 'MD' }],
        }, input());
        assert.equal(items[0].content, 'MD');
        assert.equal(items[0].snippet, 'D');
    },

    testWebGenericBuildAndParse(): void {
        const p = provider('generic', {
            baseURL: 'https://x.test',
            genericSearch: {
                method: 'POST',
                path: '/v1/search/{query}',
                body: { q: '{query}', limit: '{count}', deep: '{need_content}' },
                results_path: 'data.items',
                fields: { title: 'name', url: 'link', snippet: 'desc' },
            },
        });
        const adapter = getAdapter(p)!;
        const req = adapter.buildSearch('https://x.test', '', input({ count: 3, detail: 'content' }), p);
        assert.equal(req.method, 'POST');
        assert.ok(req.url.includes('/v1/search/deepseek v4'), req.url);
        const body = req.body as Record<string, any>;
        assert.equal(body.limit, 3);
        assert.equal(body.deep, true);
        const items = adapter.parseSearch({ data: { items: [{ name: 'N', link: 'L', desc: 'D' }] } }, input());
        assert.equal(items[0].title, 'N');
        assert.equal(items[0].snippet, 'D');
    },

    // ---------- service

    testWebServiceSuccess: async () => {
        const calls: string[] = [];
        const result = await runSearch(config(), input(), {
            fetchImpl: (async (url: string) => {
                calls.push(String(url));
                return jsonResponse(200, { results: [{ title: 'T', url: 'U', summary: 'S' }] });
            }) as any,
            sleep: noSleep,
        });
        assert.equal(calls.length, 1);
        assert.equal(result.provider, 'deepseek');
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].summary, 'S');
    },

    testWebServiceFallbackOn500: async () => {
        let n = 0;
        const cfg = config({
            providers: [provider('deepseek'), provider('searxng', { apiKey: '', needKey: false } as any)],
            routes: { search: ['deepseek', 'searxng'] },
        });
        const result = await runSearch(cfg, input(), {
            fetchImpl: (async () => {
                n += 1;
                if (n <= 2) return jsonResponse(500, { error: 'boom' });
                return jsonResponse(200, { results: [{ title: 'T', url: 'U', content: 'C' }] });
            }) as any,
            sleep: noSleep,
        });
        assert.equal(n, 3, 'deepseek 重试一次后才换家');
        assert.equal(result.provider, 'searxng');
        assert.equal(result.attempts[0].provider, 'deepseek');
    },

    testWebServiceNoFallbackOn400: async () => {
        let n = 0;
        const cfg = config({
            providers: [provider('deepseek'), provider('searxng', { apiKey: '' } as any)],
            routes: { search: ['deepseek', 'searxng'] },
        });
        await assert.rejects(
            runSearch(cfg, input(), {
                fetchImpl: (async () => { n += 1; return jsonResponse(400, { error: 'bad query' }); }) as any,
                sleep: noSleep,
            }),
            /联网搜索失败（deepseek）/,
        );
        assert.equal(n, 1, '400 不重试、不换家');
    },

    testWebServiceSkipsDisabledAndPlaceholder: async () => {
        const calls: string[] = [];
        const cfg = config({
            providers: [
                provider('deepseek', { enabled: false }),
                provider('brave', { apiKey: 'sk-xxxx' }),
                provider('searxng', { apiKey: '' }),
            ],
            routes: { search: ['deepseek', 'brave', 'searxng'] },
        });
        const result = await runSearch(cfg, input(), {
            fetchImpl: (async (url: string) => { calls.push(String(url)); return jsonResponse(200, { results: [{ title: 'T', url: 'U' }] }); }) as any,
            sleep: noSleep,
        });
        assert.equal(result.provider, 'searxng');
        assert.ok(isPlaceholderKey('sk-xxxx'));
        assert.equal(calls.length, 1);
    },

    testWebServiceAllFail: async () => {
        const cfg = config({
            providers: [provider('deepseek'), provider('searxng', { apiKey: '' } as any)],
            routes: { search: ['deepseek', 'searxng'] },
        });
        await assert.rejects(
            runSearch(cfg, input(), {
                fetchImpl: (async () => jsonResponse(500, { error: 'boom' })) as any,
                sleep: noSleep,
            }),
            /已尝试[\s\S]*deepseek[\s\S]*searxng/,
        );
    },

    testWebServiceContentTruncation: async () => {
        const cfg = config({ defaults: { ...config().defaults, maxContentChars: 10 } });
        const result = await runSearch(cfg, input({ detail: 'content' }), {
            fetchImpl: (async () => jsonResponse(200, {
                results: [{ title: 'T', url: 'U', content: 'abcdefghijklmnopqrstuvwxyz' }],
            })) as any,
            sleep: noSleep,
        });
        assert.equal(result.items[0].content, 'abcdefghij…');
    },

    testWebServiceDropsContentUnlessRequested: async () => {
        // detail=summary 时，即使方言返回了正文（如 firecrawl）也应被丢弃，避免上下文膨胀
        const result = await runSearch(config(), input({ detail: 'summary' }), {
            fetchImpl: (async () => jsonResponse(200, {
                results: [{ title: 'T', url: 'U', summary: 'S', content: 'FULL BODY' }],
            })) as any,
            sleep: noSleep,
        });
        assert.equal(result.items[0].content, undefined);
        assert.equal(result.items[0].summary, 'S');

        // detail=snippet 时连长摘要也不返回（部分方言总是带 summary）
        const snippet = await runSearch(config(), input({ detail: 'snippet' }), {
            fetchImpl: (async () => jsonResponse(200, {
                results: [{ title: 'T', url: 'U', summary: 'LONG', content: 'BODY' }],
            })) as any,
            sleep: noSleep,
        });
        assert.equal(snippet.items[0].summary, undefined);
        assert.equal(snippet.items[0].content, undefined);
    },

    // ---------- 渲染

    testWebRenderSearch(): void {
        const empty = renderSearchResult({ provider: 'deepseek', query: 'x', items: [], attempts: [] });
        assert.ok(empty.includes('没有搜索到结果'));
        assert.ok(empty.includes('更宽泛'));

        const text = renderSearchResult({
            provider: 'deepseek',
            query: 'x',
            attempts: [],
            items: [{ title: 'T', url: 'U', summary: 'S', date: 'D', site: 'Site', score: 1.2 }],
        });
        assert.ok(text.includes('1. T'));
        assert.ok(text.includes('链接：U'));
        assert.ok(text.includes('摘要：S'));
        assert.ok(text.includes('D / Site / 相关度 1.2'));
    },

    testWebRenderFetchTruncation(): void {
        const text = renderFetchResult({ provider: 'deepseek', url: 'U', title: 'T', content: '0123456789', attempts: [] }, 4, 0);
        assert.ok(text.includes('标题：T'));
        assert.ok(text.includes('0123'));
        assert.ok(text.includes('start_index=4'));
        const tail = renderFetchResult({ provider: 'deepseek', url: 'U', title: 'T', content: '0123456789', attempts: [] }, 100, 8);
        assert.ok(tail.includes('89'));
        assert.ok(!tail.includes('已截断'));
        const beyond = renderFetchResult({ provider: 'deepseek', url: 'U', title: 'T', content: '0123456789', attempts: [] }, 100, 99);
        assert.ok(beyond.includes('已到末尾'));
    },

    // ---------- 抓取

    testWebFetchAdapterDeepSeek(): void {
        const req = ADAPTERS.deepseek.buildFetch!('https://api.deepseek.com', 'k', 'https://a.test', provider('deepseek'));
        assert.equal(req.url, 'https://api.deepseek.com/v1/tools/fetch');
        assert.deepEqual(req.body, { url: 'https://a.test' });
        const parsed = ADAPTERS.deepseek.parseFetch!({ title: 'T', content: '# C' }, 'https://a.test');
        assert.deepEqual(parsed, { title: 'T', content: '# C' });
    },

    testWebRunFetchFallback: async () => {
        const cfg = config({
            providers: [provider('deepseek'), provider('kimi')],
            routes: { fetch: ['deepseek', 'kimi'] },
        });
        const result = await runFetch(cfg, 'https://a.test', {
            fetchImpl: (async (url: string) => {
                if (String(url).includes('deepseek')) return jsonResponse(500, { error: 'boom' });
                return jsonResponse(200, { title: 'T', markdown: '# BODY' });
            }) as any,
            sleep: noSleep,
        });
        assert.equal(result.provider, 'kimi');
        assert.equal(result.title, 'T');
        assert.equal(result.content, '# BODY');
    },
};
