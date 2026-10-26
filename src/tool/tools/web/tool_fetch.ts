// 网页抓取工具：url + 长度上限 + start_index 续读。
import WebConfigStore from "../../../config/configs/web";
import { logger } from "../../../logger";
import { renderFetchResult, runFetch } from "../../../web/service";
import Tool from "../../tool";

function isHttpUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

export function registerWebFetch() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "web_fetch",
            description: "Fetch web page content (Markdown). Backends: DeepSeek / Kimi / Tavily / Exa / Firecrawl or generic fetching",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "Web page URL to fetch (http/https)",
                    },
                    max_chars: {
                        type: "integer",
                        description: "Max length of the returned text; defaults to the configured value (5000)",
                    },
                    start_index: {
                        type: "integer",
                        description: "Start returning from this character offset; pass the value suggested when the previous result was truncated",
                    },
                },
                required: ["url"],
            },
        },
    });

    tool.solve = async (_ctx, _msg, _session, args) => {
        const url = String((args as Record<string, any>).url ?? '').trim();
        if (!url) return '缺少参数 url（要抓取的网页地址）';
        if (!isHttpUrl(url)) return 'url 必须以 http:// 或 https:// 开头';

        const cfg = WebConfigStore.get();
        const maxRaw = Number((args as Record<string, any>).max_chars);
        const maxChars = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : cfg.defaults.maxContentChars;
        const startRaw = Number((args as Record<string, any>).start_index);
        const startIndex = Number.isFinite(startRaw) && startRaw > 0 ? Math.floor(startRaw) : 0;

        const started = Date.now();
        try {
            const result = await runFetch(cfg, url);
            logger.info(`web_fetch 完成：provider=${result.provider} 耗时=${Date.now() - started}ms`);
            let text = renderFetchResult(result, maxChars, startIndex);
            if (!result.content) text = `抓取成功，但没有可读正文（${result.provider}）：${url}`;
            if (result.attempts.length > 0) {
                text += `\n\n（已回退：${result.attempts.map(a => `${a.provider} 失败`).join('、')}）`;
            }
            return text;
        } catch (e) {
            logger.warning(`web_fetch 失败：${e instanceof Error ? e.message : String(e)}`);
            return `网页抓取失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };
}
