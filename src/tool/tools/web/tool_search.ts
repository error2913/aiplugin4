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
            description: "联网搜索（支持 DeepSeek / SearXNG / Brave / Tavily / Serper / 博查 / 智谱 / Kimi / Exa / Firecrawl 等后端）",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "搜索内容（1~128 字）；旧参数名 q 也兼容",
                    },
                    count: {
                        type: "integer",
                        description: "返回条数（1~50），默认取配置",
                    },
                    offset: {
                        type: "integer",
                        description: "结果偏移（分页）；一般不用填",
                    },
                    detail: {
                        type: "string",
                        enum: ["snippet", "summary", "content"],
                        description: "详细程度：snippet 短摘要 / summary 长摘要 / content 网页正文；默认 summary",
                    },
                    allowed_domains: {
                        type: "array",
                        items: { type: "string" },
                        description: "只保留这些域名，例如 [\"github.com\"]（可选）",
                    },
                    blocked_domains: {
                        type: "array",
                        items: { type: "string" },
                        description: "排除这些域名（可选）",
                    },
                    site: {
                        type: "string",
                        description: "单域快捷方式，等价 allowed_domains:[site]（可选）",
                    },
                    time_range: {
                        type: "string",
                        enum: ["day", "week", "month", "year"],
                        description: "时间范围（可选）",
                    },
                    page: {
                        type: "integer",
                        description: "页码（仅 SearXNG 兼容旧行为，新代码建议用 offset）",
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
