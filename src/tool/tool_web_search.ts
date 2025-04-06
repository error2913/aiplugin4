import { logger } from "../AI/logger";
import { Tool, ToolInfo, ToolManager } from "./tool";

export function registerWebSearch() {
    const info: ToolInfo = {
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
    }

    const tool = new Tool(info);
    tool.solve = async (_, __, ___, args) => {
        const { q, page, categories, time_range = '' } = args;

        let part = 1;
        let pageno = '';
        if (page) {
            part = parseInt(page) % 2;
            pageno = page ? Math.ceil(parseInt(page) / 2).toString() : '';
        }

        const url = `http://110.41.69.149:8080/search?q=${q}&format=json${pageno ? `&pageno=${pageno}` : ''}${categories ? `&categories=${categories}` : ''}${time_range ? `&time_range=${time_range}` : ''}`;
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

    ToolManager.toolMap[info.function.name] = tool;
}