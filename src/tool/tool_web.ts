import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";

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
        const { webSearchUrl } = ConfigManager.backend;

        let part = 1;
        let pageno = '';
        if (page) {
            part = parseInt(page) % 2;
            pageno = page ? Math.ceil(parseInt(page) / 2).toString() : '';
        }

        const url = `${webSearchUrl}/search?q=${q}&format=json${pageno ? `&pageno=${pageno}` : ''}${categories ? `&categories=${categories}` : ''}${time_range ? `&time_range=${time_range}` : ''}`;
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
                return { content: `没有搜索到结果`, images: [] };
            }

            const s = `搜索结果长度:${number_of_results}\n` + results.map((result: any, index: number) => {
                return `${index + 1}. 标题:${result.title}
- 内容:${result.content}
- 链接:${result.url}
- 相关性:${result.score}`;
            }).join('\n');

            return { content: s, images: [] };
        } catch (error) {
            logger.error("在web_search中请求出错：", error);
            return { content: `使用搜索引擎搜索失败:${error}`, images: [] };
        }
    }

    const tool = new Tool({
        type: "function",
        function: {
            name: "web_read",
            description: `读取网页内容`,
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "需要读取内容的网页链接"
                    }
                },
                required: ["url"]
            }
        }
    });
    tool.solve = async (_, __, ___, args) => {
        const { url } = args;
        const { webReadUrl } = ConfigManager.backend;

        try {
            logger.info(`读取网页内容: ${url}`);

            const response = await fetch(`${webReadUrl}/scrape`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ url })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(`请求失败: ${JSON.stringify(data)}`);
            }

            const { title, content, links } = data;

            if (!title && !content && (!links || links.length === 0)) {
                return { content: `未能从网页中提取到有效内容`, images: [] };
            }

            const result = `标题: ${title || "无标题"}\n内容: ${content || "无内容"}\n网页包含链接:\n` +
                (links && links.length > 0
                    ? links.map((link: string, index: number) => `${index + 1}. ${link}`).join('\n')
                    : "无链接");

            return { content: result, images: [] };
        } catch (error) {
            logger.error("在web_read中请求出错：", error);
            return { content: `读取网页内容失败: ${error}`, images: [] };
        }
    }
}