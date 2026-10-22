// token 用量统计：按模型按天记录，支持过期归并/汇总/图表
import Config from "./config/config";
import { getHost } from "./core/host";
import { logger } from "./logger";
import { backendAuthHeaders, backendAuthHint } from "./utils/backend";

/** 用量计数（输入/输出；缓存字段按厂商提供时累加，用于观察缓存命中） */
interface UsageCount { prompt_tokens: number; completion_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number }
/** 维度（模型或用途）→ 日期 → 计数 */
type UsageByDate = { [time: string]: UsageCount };
/** 存储结构：models 为原有「模型」维度，purposes 为新增「用途」维度；同一 key 一次写入，避免多写一份 */
interface UsageStore { models: { [name: string]: UsageByDate }; purposes: { [use: string]: UsageByDate } }

export class UsageManager {
    static storeCache: UsageStore | null = null;

    /** 读取存储；兼容旧格式（旧值就是「模型 → 日期 → 计数」映射，没有 models/purposes 包裹） */
    static get store(): UsageStore {
        if (!this.storeCache) {
            let parsed: any = {};
            try {
                parsed = JSON.parse(getHost().storage.get('usageMap') || '{}');
            } catch (error) {
                logger.error('从存储中获取 usageMap 失败:', error);
            }
            if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
                this.storeCache = {
                    models: parsed.models,
                    purposes: parsed.purposes && typeof parsed.purposes === 'object' ? parsed.purposes : {},
                };
            } else {
                this.storeCache = { models: parsed && typeof parsed === 'object' ? parsed : {}, purposes: {} };
            }
        }
        return this.storeCache;
    }

    static get usageMap(): { [model: string]: UsageByDate } {
        return this.store.models;
    }

    /** 按用途维度的用量（chat / compression / summarization / judge / text-embedding / …） */
    static get purposeUsage(): { [use: string]: UsageByDate } {
        return this.store.purposes;
    }

    /**
     * 记录一次用量。
     * @param use 用途（模型请求的 use），传入时同时累计到用途维度；旧调用方不传即只记模型维度
     */
    static updateUsage(model: string, usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number }, use?: string) {
        if (!model) return;
        const key = this.todayKey();
        this.accumulate(this.usageMap, model, key, usage);
        if (use) this.accumulate(this.purposeUsage, use, key, usage);
        this.saveUsageMap();
    }

    /** 累加到「维度 → 日期」结构；该维度首次出现时顺带做一次过期归并 */
    private static accumulate(map: { [name: string]: UsageByDate }, name: string, key: string, usage: { prompt_tokens: number, completion_tokens: number }) {
        if (!Object.prototype.hasOwnProperty.call(map, name)) {
            map[name] = {};
            this.sweep(map[name]);
        }
        if (!Object.prototype.hasOwnProperty.call(map[name], key)) {
            map[name][key] = { prompt_tokens: 0, completion_tokens: 0 };
        }
        map[name][key].prompt_tokens += usage.prompt_tokens || 0;
        map[name][key].completion_tokens += usage.completion_tokens || 0;
        const cacheRead = (usage as any).cache_read_tokens || 0;
        const cacheWrite = (usage as any).cache_write_tokens || 0;
        if (cacheRead) map[name][key].cache_read_tokens = (map[name][key].cache_read_tokens || 0) + cacheRead;
        if (cacheWrite) map[name][key].cache_write_tokens = (map[name][key].cache_write_tokens || 0) + cacheWrite;
    }

    /** 全局缓存命中/写入 token 汇总（`.ai ctx` 展示用；按厂商提供时才有值） */
    static getCacheUsage(): { read: number; write: number } {
        let read = 0;
        let write = 0;
        const map = this.usageMap;
        for (const model of Object.keys(map)) {
            for (const key in map[model]) {
                read += map[model][key].cache_read_tokens || 0;
                write += map[model][key].cache_write_tokens || 0;
            }
        }
        return { read, write };
    }

    private static todayKey(): string {
        const now = new Date();
        return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    }

    /** 保留旧签名：对指定模型做过期归并 */
    static clearExpiredUsage(model: string) {
        if (!Object.prototype.hasOwnProperty.call(this.usageMap, model)) return;
        this.sweep(this.usageMap[model]);
    }

    /** 过期归并：超过 12 个月归入 `0-0-0`，超过 30 天的按天桶归入当月桶 */
    private static sweep(map: UsageByDate) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();
        const currentYM = currentYear * 12 + currentMonth;
        const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;

        // 先收集过期 key 与归并结果，完成后再统一替换，避免遍历同一对象时增删导致数据丢失/翻倍
        const expiredKeys: string[] = [];
        const merged: UsageByDate = {};
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

    /** 按用途维度取总用量 */
    static getPurposeUsage(use: string): { prompt_tokens: number, completion_tokens: number } {
        const map = this.purposeUsage;
        if (!Object.prototype.hasOwnProperty.call(map, use)) return { prompt_tokens: 0, completion_tokens: 0 };
        const usage = { prompt_tokens: 0, completion_tokens: 0 };
        for (const key in map[use]) {
            usage.prompt_tokens += map[use][key].prompt_tokens;
            usage.completion_tokens += map[use][key].completion_tokens;
        }
        return usage;
    }

    static saveUsageMap() {
        getHost().storage.set('usageMap', JSON.stringify(this.store));
    }

    static clearUsageMap() {
        this.storeCache = { models: {}, purposes: {} };
    }
}

export interface ChartResult {
    /** 后端临时图片 URL（旧版后端只有它；协议端能访问后端时可用） */
    url: string;
    /** 图表 PNG 的 base64（新版后端）：落本地文件发送，token 不进 URL、不依赖后端地址可达 */
    base64?: string;
    /** 失败原因（命令层展示用；成功时为空） */
    error?: string;
}

export async function get_chart_url(chart_type: string, usage_data: {
    [key: string]: {
        prompt_tokens: number;
        completion_tokens: number;
    }
}): Promise<ChartResult> {
    const { USAGE_CHART: usageChartUrl, USAGE_CHART_TOKEN: usageChartToken } = Config.backend;
    try {
        const response = await fetch(`${usageChartUrl}/chart`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...backendAuthHeaders(usageChartToken),
            },
            body: JSON.stringify({
                chart_type: chart_type,
                data: usage_data
            })
        })

        const text = await response.text();
        if (!response.ok) {
            const hint = response.status === 401 ? `\n${backendAuthHint('usage-chart')}` : '';
            throw new Error(`请求失败! 状态码: ${response.status}${hint}\n响应体: ${text}`);
        }
        if (!text) {
            throw new Error("响应体为空");
        }

        let data: any;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
        }
        if (data.error) {
            throw new Error(`请求失败! 错误信息: ${data.error.message}`);
        }
        return {
            url: typeof data.image_url === 'string' ? data.image_url : '',
            base64: typeof data.base64 === 'string' && data.base64 ? data.base64 : undefined,
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.error("在get_chart_url中请求出错:", message);
        return { url: '', error: message };
    }
}

/**
 * 图表 → CQ 图片段。
 * 优先用后端返回的 base64 落本地文件（token 不进图片 URL、也不要求协议端能访问后端地址）；
 * 旧版后端没有 base64 时回退 `image_url`。
 */
export function chartImageCQ(chart: ChartResult | null): string {
    if (!chart) return '';
    if (chart.base64) return `[CQ:image,file=${seal.base64ToImage(chart.base64)}]`;
    if (chart.url) return `[CQ:image,file=${chart.url}]`;
    return '';
}
