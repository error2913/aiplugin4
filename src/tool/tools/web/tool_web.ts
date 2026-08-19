// 联网工具：搜索与网页阅读
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Tool from "../../tool";

export function registerWeb() {
    const toolSearch = new Tool({
        type: "function",
        function: {
            name: "web_search",
            description: `使用搜索引擎搜索`,
            parameters: {
                type: "object",
                properties: {
                    q: {
                        type: "string",
                        description: "搜索内容"
                    },
                    page: {
                        type: "integer",
                        description: "页码"
                    },
                    categories: {
                        type: "string",
                        description: "搜索分类",
                        enum: ["general", "images", "videos", "news", "map", "music", "it", "science", "files", "social_media"]
                    },
                    time_range: {
                        type: "string",
                        description: "时间范围",
                        enum: ["day", "week", "month", "year"]
                    }
                },
                required: ["q"]
            }
        }
    });
    toolSearch.solve = async (_, __, ___, args) => {
        const { q, page, categories, time_range = '' } = args;
        const { WEB_SEARCH: webSearchUrl } = Config.backend;

        // 页码映射：后端每页结果拆成两个半页（1=前半、2=后半、3=下一页前半……）
        // page 为 0/负数/非法值时按第 1 页处理，避免 parseInt 边界导致 NaN
        const rawPage = parseInt(String(page ?? ''), 10);
        const safePage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
        const part = ((safePage - 1) % 2) + 1;
        const pageno = Math.ceil(safePage / 2).toString();

        const url = `${webSearchUrl}/search?q=${encodeURIComponent(q)}&format=json&pageno=${pageno}${categories ? `&categories=${encodeURIComponent(categories)}` : ''}${time_range ? `&time_range=${time_range}` : ''}`;
        try {
            logger.info(`使用搜索引擎搜索:${url}`);

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(`请求失败:${JSON.stringify(data)}}`);
            }

            const number_of_results = data.number_of_results;
            const results_length = data.results.length;
            const results = part == 1 ? data.results.slice(0, Math.ceil(results_length / 2)) : data.results.slice(Math.ceil(results_length / 2));
            if (number_of_results == 0 || results.length == 0) {
                return `没有搜索到结果`;
            }

            const s = `搜索结果长度:${number_of_results}\n` + results.map((result: any, index: number) => {
                return `${index + 1}. 标题:${result.title}
- 内容:${result.content}
- 链接:${result.url}
- 相关性:${result.score}`;
            }).join('\n');

            return s;
        } catch (error) {
            logger.error("在web_search中请求出错：", error);
            return `使用搜索引擎搜索失败:${error}`;
        }
    }

}
