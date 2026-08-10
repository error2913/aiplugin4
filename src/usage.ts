// token 用量统计：按模型按天记录，支持过期归并/汇总/图表
import { ext } from "./config/config";
import Config from "./config/config";
import { logger } from "./logger";

export class UsageManager {
    static usageMapCache: { [model: string]: { [time: string]: { prompt_tokens: number, completion_tokens: number } } } | null = null;

    static get usageMap(): { [model: string]: { [time: string]: { prompt_tokens: number, completion_tokens: number } } } {
        if (!this.usageMapCache) {
            try {
                this.usageMapCache = JSON.parse(ext.storageGet('usageMap') || '{}');
            } catch (error) {
                logger.error('从存储中获取 usageMap 失败:', error);
            }
        }
        return this.usageMapCache || (this.usageMapCache = {});
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

        const map = this.usageMap[model];
        // 先收集过期 key 与归并结果，完成后再统一替换，避免遍历同一对象时增删导致数据丢失/翻倍
        const expiredKeys: string[] = [];
        const merged: { [time: string]: { prompt_tokens: number, completion_tokens: number } } = {};
        for (const key in map) {
            if (key === '0-0-0') continue; // 长期汇总桶常驻，不再参与归并
            const [year, month, day] = key.split('-').map(Number);
            const ym = year * 12 + month;
            const ymd = year * 12 * 31 + month * 31 + day;

            let newKey = '';
            if (ym < currentYM - 11) {
                newKey = `0-0-0`;
            } else if (day > 0 && ymd < currentYMD - 30) {
                // 仅按天记录（day>0）的条目才需要按月归并；月度桶已聚合，只参与长期归并
                newKey = `${year}-${month}-0`;
            }

            if (newKey) {
                expiredKeys.push(key);
                if (!Object.prototype.hasOwnProperty.call(merged, newKey)) {
                    merged[newKey] = { prompt_tokens: 0, completion_tokens: 0 };
                }
                merged[newKey].prompt_tokens += map[key].prompt_tokens;
                merged[newKey].completion_tokens += map[key].completion_tokens;
            }
        }
        if (expiredKeys.length === 0) return;
        for (const key of expiredKeys) delete map[key];
        for (const key of Object.keys(merged)) {
            if (!Object.prototype.hasOwnProperty.call(map, key)) {
                map[key] = { prompt_tokens: 0, completion_tokens: 0 };
            }
            map[key].prompt_tokens += merged[key].prompt_tokens;
            map[key].completion_tokens += merged[key].completion_tokens;
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
        logger.error("在get_chart_url中请求出错:", e instanceof Error ? e.message : String(e));
        return '';
    }
}
