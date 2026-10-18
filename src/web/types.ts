// 联网搜索/抓取：类型与常量（纯类型，无运行时依赖）
//
// 设计见 docs/18-联网搜索与抓取接入方案.md。工具层只认这里的归一化结构，
// 各方言的请求构造与取数在 presets.ts。

/** 结果详细程度：snippet=短摘要，summary=长摘要，content=网页正文 */
export type WebDetail = 'snippet' | 'summary' | 'content';

export const WEB_DETAILS: WebDetail[] = ['snippet', 'summary', 'content'];

/** 一次搜索的归一化入参 */
export interface SearchInput {
    query: string;
    count: number;
    /** 结果偏移（分页） */
    offset: number;
    detail: WebDetail;
    allowedDomains?: string[];
    blockedDomains?: string[];
    /** day / week / month / year */
    timeRange?: string;
    /** 旧参数兼容：SearXNG 半页拆分；其他方言映射为 offset=(page-1)*count */
    page?: number;
    /** DeepSeek 的 ori_question（可选） */
    oriQuestion?: string;
}

/** 归一化单条搜索结果 */
export interface WebSearchItem {
    title: string;
    url: string;
    snippet?: string;
    summary?: string;
    content?: string;
    date?: string;
    site?: string;
    score?: number;
}

/** 归一化搜索响应 */
export interface WebSearchResult {
    provider: string;
    query: string;
    items: WebSearchItem[];
    /** 失败过的 provider 及原因（成功时为空；失败回退时用于提示） */
    attempts: { provider: string; message: string }[];
}

/** 归一化抓取响应 */
export interface WebFetchResult {
    provider: string;
    url: string;
    title: string;
    content: string;
    attempts: { provider: string; message: string }[];
}

/** 方言构造出的 HTTP 请求 */
export interface BuiltRequest {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    provider: string;
}

/** generic 方言的请求/响应描述（用户配置） */
export interface GenericDescriptor {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    /** 请求体模板（值里可用 {query} 等占位符） */
    body?: unknown;
    /** URL 查询参数模板 */
    query?: Record<string, string>;
    /** 结果数组路径，默认 results */
    results_path?: string;
    /** 归一化字段 → 响应字段路径 */
    fields?: Record<string, string>;
    /** 抓取响应类型 */
    response_type?: 'json' | 'text';
    title_path?: string;
    content_path?: string;
}

/** 运行时 provider（配置解析后的形态，不含默认值合并） */
export interface WebProviderRuntime {
    id: string;
    dialect: string;
    baseURL: string;
    apiKey: string;
    enabled: boolean;
    timeout?: number;
    headers?: Record<string, string>;
    genericSearch?: GenericDescriptor;
    genericFetch?: GenericDescriptor;
}

/** 方言适配器：每家一个（generic 由工厂生成） */
export interface DialectAdapter {
    dialect: string;
    defaultBaseURL: string;
    needKey: boolean;
    supportsFetch: boolean;
    buildSearch(baseURL: string, apiKey: string, input: SearchInput, provider: WebProviderRuntime): BuiltRequest;
    parseSearch(data: any, input: SearchInput): WebSearchItem[];
    buildFetch?(baseURL: string, apiKey: string, url: string, provider: WebProviderRuntime): BuiltRequest;
    parseFetch?(data: any, url: string): { title: string; content: string };
    /** 结果条数是否由 API 保证（false 时 service 在本地截断） */
    countHandledByApi?: boolean;
}

/** 联网配置的默认项 */
export interface WebDefaults {
    count: number;
    detail: WebDetail;
    timeout: number;
    maxContentChars: number;
    fallback: boolean;
}

/** 联网配置（v1） */
export interface WebConfig {
    version: 1;
    defaults: WebDefaults;
    providers: WebProviderRuntime[];
    routes: { search?: string[]; fetch?: string[] };
}

/** 配置校验问题（path 用 $.providers[0].baseURL 形式） */
export interface WebIssue {
    path: string;
    msg: string;
}
