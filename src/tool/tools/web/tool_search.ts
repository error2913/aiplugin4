// 联网搜索工具：参数归一化 → WebService 路由 → markdown 文本。
//
// 与旧 web_search 兼容：接受 q（旧参数名）、page（SearXNG 半页）、categories 忽略。
import WebConfigStore from "../../../config/configs/web";
import { logger } from "../../../logger";
import { renderSearchResult, runSearch } from "../../../web/service";
import { SearchInput, WebDetail } from "../../../web/types";
import Tool from "../../tool";

const DETAILS: WebDetail[] = ['snippet', 'summary', 'content'];
const TIME_RANGES = ['day', 'week', 'month', 'year'];

function asStringArray(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.map(x => String(x ?? '').trim()).filter(Boolean);
    return out.length > 0 ? out : undefined;
}

function toInput(args: Record<string, any>): SearchInput | string {
    const query = String(args.query ?? args.q ?? '').trim();
    if (!query) return '缺少参数 query（搜索内容）';

    const cfg = WebConfigStore.get();
    const countRaw = Number(args.count);
    const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : cfg.defaults.count;
    const pageRaw = Number(args.page);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : undefined;
    const offsetRaw = Number(args.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0
        ? Math.floor(offsetRaw)
        : (page ? (page - 1) * count : 0);

    const detailArg = String(args.detail ?? '').trim() as WebDetail;
    const detail = DETAILS.includes(detailArg) ? detailArg : cfg.defaults.detail;

    const timeRange = TIME_RANGES.includes(String(args.time_range)) ? String(args.time_range) : undefined;

    const allowed = asStringArray(args.allowed_domains);
    const blocked = asStringArray(args.blocked_domains);
    const site = String(args.site ?? '').trim();
    const allowedDomains = allowed ?? (site ? [site] : undefined);

    return {
        query,
        count,
        offset,
        detail,
        allowedDomains,
        blockedDomains: blocked,
        timeRange,
        page,
    };
}

export function registerWebSearch() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "web_search",
            description: "Web search (backends: DeepSeek / SearXNG / Brave / Tavily / Serper / Bocha / Zhipu / Kimi / Exa / Firecrawl, etc.)",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search query (1-128 characters); the legacy parameter name q is also accepted",
                    },
                    count: {
                        type: "integer",
                        description: "Number of results (1-50); defaults to the configured value",
                    },
                    offset: {
                        type: "integer",
                        description: "Result offset (pagination); usually left empty",
                    },
                    detail: {
                        type: "string",
                        enum: ["snippet", "summary", "content"],
                        description: "Detail level: snippet short summary / summary long summary / content full page text; default summary",
                    },
                    allowed_domains: {
                        type: "array",
                        items: { type: "string" },
                        description: "Only keep these domains, e.g. [\"github.com\"] (optional)",
                    },
                    blocked_domains: {
                        type: "array",
                        items: { type: "string" },
                        description: "Exclude these domains (optional)",
                    },
                    site: {
                        type: "string",
                        description: "Single-domain shortcut, equivalent to allowed_domains:[site] (optional)",
                    },
                    time_range: {
                        type: "string",
                        enum: ["day", "week", "month", "year"],
                        description: "Time range (optional)",
                    },
                    page: {
                        type: "integer",
                        description: "Page number (SearXNG only, for legacy behavior; new code should use offset)",
                    },
                },
                required: [],
            },
        },
    });

    tool.solve = async (_ctx, _msg, _session, args) => {
        const input = toInput(args as Record<string, any>);
        if (typeof input === 'string') return input;

        const started = Date.now();
        try {
            const result = await runSearch(WebConfigStore.get(), input);
            logger.info(`web_search 完成：provider=${result.provider} count=${result.items.length} 耗时=${Date.now() - started}ms`);
            let text = renderSearchResult(result);
            if (result.attempts.length > 0) {
                text += `\n\n（已回退：${result.attempts.map(a => `${a.provider} 失败`).join('、')}）`;
            }
            return text;
        } catch (e) {
            logger.warning(`web_search 失败：${e instanceof Error ? e.message : String(e)}`);
            return `联网搜索失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };
}
