// token 用量统计：按模型按天记录，支持过期归并/汇总/图表
import { ext } from "./config/config";
import Config from "./config/config";
import { logger } from "./logger";

export class UsageManager {
    static usageMapCache: { [model: string]: { [time: string]: { prompt_tokens: number, completion_tokens: number } } } = null;

    static get usageMap(): { [model: string]: { [time: string]: { prompt_tokens: number, completion_tokens: number } } } {
        if (!this.usageMapCache) {
            try {
                this.usageMapCache = JSON.parse(ext.storageGet('usageMap') || '{}');
            } catch (error) {
                logger.error('从存储中获取 usageMap 失败:', error);
            }
        }
        return this.usageMapCache;
    }

    static updateUsage(model: string, usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number }) {
        if (!model) return;
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const key = `${year}-${month}-${day}`;
        if (!Object.prototype.hasOwnProperty.call(this.usageMap, model)) {
            this.usageMap[model] = {};
        }
        if (!Object.prototype.hasOwnProperty.call(this.usageMap[model], key)) {
            this.usageMap[model][key] = { prompt_tokens: 0, completion_tokens: 0 };
            this.clearExpiredUsage(model);
        }
        this.usageMap[model][key].prompt_tokens += usage.prompt_tokens || 0;
        this.usageMap[model][key].completion_tokens += usage.completion_tokens || 0;
        this.saveUsageMap();
    }

    static clearExpiredUsage(model: string) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();
        const currentYM = currentYear * 12 + currentMonth;
        const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;

        if (!Object.prototype.hasOwnProperty.call(this.usageMap, model)) return;

        for (const key in this.usageMap[model]) {
            const [year, month, day] = key.split('-').map(Number);
            const ym = year * 12 + month;
            const ymd = year * 12 * 31 + month * 31 + day;

            let newKey = '';
            if (ymd < currentYMD - 30) newKey = `${year}-${month}-0`;
            if (ym < currentYM - 11) newKey = `0-0-0`;

            if (newKey) {
                if (!Object.prototype.hasOwnProperty.call(this.usageMap[model], newKey)) {
                    this.usageMap[model][newKey] = { prompt_tokens: 0, completion_tokens: 0 };
                }
                this.usageMap[model][newKey].prompt_tokens += this.usageMap[model][key].prompt_tokens;
                this.usageMap[model][newKey].completion_tokens += this.usageMap[model][key].completion_tokens;
                delete this.usageMap[model][key];
            }
        }
    }

    static getModelUsage(model: string): { prompt_tokens: number, completion_tokens: number } {
        if (!Object.prototype.hasOwnProperty.call(this.usageMap, model)) return { prompt_tokens: 0, completion_tokens: 0 };
        const usage = { prompt_tokens: 0, completion_tokens: 0 };
        for (const key in this.usageMap[model]) {
            usage.prompt_tokens += this.usageMap[model][key].prompt_tokens;
            usage.completion_tokens += this.usageMap[model][key].completion_tokens;
        }
        return usage;
    }

    static saveUsageMap() {
        ext.storageSet('usageMap', JSON.stringify(this.usageMapCache));
    }

    static clearUsageMap() {
        this.usageMapCache = {};
    }
}

export async function get_chart_url(chart_type: string, usage_data: {
    [key: string]: {
        prompt_tokens: number;
        completion_tokens: number;
    }
}) {
    const { USAGE_CHART: usageChartUrl } = Config.backend;
    try {
        const response = await fetch(`${usageChartUrl}/chart`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                chart_type: chart_type,
                data: usage_data
            })
        })

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
        }
        if (!text) {
            throw new Error("响应体为空");
        }

        try {
            const data = JSON.parse(text);
            if (data.error) {
                throw new Error(`请求失败! 错误信息: ${data.error.message}`);
            }
            return data.image_url;
        } catch (e) {
            throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
        }
    } catch (e) {
        logger.error("在get_chart_url中请求出错:", e.message);
        return '';
    }
}
