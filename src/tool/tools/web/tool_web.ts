// 联网工具：搜索与网页阅读
import Config from "../../../config/config";
import { logger } from "../../../logger";
import Image from "../../../resource/image";
import { generateId } from "../../../utils/utils";
import { callServerTool } from "../../mcp";
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

    const tool = new Tool({
        type: "function",
        function: {
            name: "web_read",
            description: `读取网页内容或对网页截图。默认抓取网页标题/正文/链接；screenshot=true 时对网页截图并返回可发送的图片`,
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "需要读取内容或截图的网页链接"
                    },
                    screenshot: {
                        type: "boolean",
                        description: "true 时对网页截图并返回图片，false（默认）时抓取网页文本内容"
                    },
                    width: {
                        type: "integer",
                        description: "截图视口宽度，默认 1680"
                    },
                    height: {
                        type: "integer",
                        description: "截图视口高度，默认 1000"
                    },
                    fullPage: {
                        type: "boolean",
                        description: "是否截取整页（长图），默认 false"
                    },
                    delay: {
                        type: "integer",
                        description: "页面加载完成后等待的毫秒数，默认 3000"
                    }
                },
                required: ["url"]
            }
        }
    });
    tool.solve = async (_, __, ___, args) => {
        const { url, screenshot = false, width, height, fullPage = false, delay } = args;
        const { WEB_READ: webReadUrl } = Config.backend;
        const mcpServer = { name: 'web-read', url: webReadUrl, token: '', headers: {} };

        if (screenshot) {
            try {
                logger.info(`网页截图: ${url}`);
                const base64 = await callServerTool(mcpServer, 'screenshot_url', { url, width, height, fullPage, delay });
                if (!base64) throw new Error('截图失败');

                const img = new Image();
                img.imageId = `web_${generateId()}`;
                img.base64 = base64;
                img.format = 'png';
                img.description = `网页截图[img:${img.imageId}]`;
                Image.save(img);

                return `截图成功，请使用[img:${img.imageId}]发送`;
            } catch (error) {
                logger.error("在web_read截图请求中出错：", error);
                return `网页截图失败: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        try {
            logger.info(`读取网页内容: ${url}`);
            return await callServerTool(mcpServer, 'scrape_url', { url });
        } catch (error) {
            logger.error("在web_read中请求出错：", error);
            return `读取网页内容失败: ${error}`;
        }
    }
}
