// token 估算自适应校准：用 API 返回的真实 prompt_tokens 对启发式估算做 EMA 修正。
import { ext } from "./config/config";
import { logger } from "./logger";

export interface TokenCalibrationState {
    factor: number;
    sampleCount: number;
    updatedAt: number;
}

type TokenCalibrationMap = { [modelName: string]: TokenCalibrationState };

const STORAGE_KEY = 'tokenCalibration';
const MIN_RATIO = 0.5;
const MAX_RATIO = 2.0;
const FAST_SAMPLE_LIMIT = 20;
const SLOW_EMA_ALPHA = 0.05;

export class TokenCalibration {
    static cache: TokenCalibrationMap | null = null;

    static getMap(): TokenCalibrationMap {
        if (!this.cache) {
            try {
                this.cache = JSON.parse(ext.storageGet(STORAGE_KEY) || '{}') as TokenCalibrationMap;
            } catch (error) {
                logger.error('读取 tokenCalibration 失败，已重置:', error);
                this.cache = {};
            }
            if (!this.cache || typeof this.cache !== 'object' || Array.isArray(this.cache)) this.cache = {};
        }
        return this.cache;
    }

    static save() {
        ext.storageSet(STORAGE_KEY, JSON.stringify(this.cache || {}));
    }

    /** 当前模型的校准系数；没有样本时默认 1 */
    static getFactor(modelName: string): number {
        if (!modelName) return 1;
        const state = this.getMap()[modelName];
        return state && state.factor > 0 ? state.factor : 1;
    }

    /** 用模型校准系数预测 token 数 */
    static predict(modelName: string, rawEstimate: number): number {
        if (!modelName || rawEstimate <= 0) return rawEstimate;
        return Math.ceil(rawEstimate * this.getFactor(modelName));
    }

    /**
     * 记录一次真实 usage 校准样本。
     * @param modelName 模型名，与 predict 使用的 key 保持一致
     * @param rawEstimate 发送前用启发式计算的原始估算（不含校准系数）
     * @param actualPromptTokens API 返回的真实 prompt_tokens
     */
    static record(modelName: string, rawEstimate: number, actualPromptTokens: number): void {
        if (!modelName || rawEstimate <= 0 || actualPromptTokens <= 0) return;

        const map = this.getMap();
        const current = map[modelName] || { factor: 1, sampleCount: 0, updatedAt: 0 };
        const ratio = actualPromptTokens / rawEstimate;
        const clampedRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));

        let factor: number;
        if (current.sampleCount === 0) {
            factor = clampedRatio;
        } else {
            const alpha = current.sampleCount < FAST_SAMPLE_LIMIT
                ? 1 / (current.sampleCount + 1)
                : SLOW_EMA_ALPHA;
            factor = current.factor + alpha * (clampedRatio - current.factor);
        }

        map[modelName] = {
            factor,
            sampleCount: current.sampleCount + 1,
            updatedAt: Date.now()
        };
        this.save();
    }

    /** 测试专用：清空内存缓存，使下一次读取重新从存储加载 */
    static resetForTest(): void {
        this.cache = null;
    }
}
