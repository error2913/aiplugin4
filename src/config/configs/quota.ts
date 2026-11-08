// 「用量限制」配置页（L2 能力层）：12 个键 + 解析/回退。
//
// 约定（AGENT.md 7 / 需求 §5）：
// - configs/* 只负责「注册 + 解析」，不做业务判定；
// - `get()` 整段 try/catch 兜底返回默认值，**永不抛**（SealDice 读未注册键会 panic）；
// - 页签 group 恒为「用量限制」，顺序由 `src/config/config.ts` 的 configMap 决定。
import { logger } from '../../logger';
import type { PeakRule, QuotaPurposeUse } from '../../quota/types';
import { parsePeakTemplate } from '../../quota/window';
import { ext } from '../ext';

/** 解析后的配置视图（manager 只读这个结构，不直接摸 seal） */
export interface QuotaConfigView {
    /** 总开关：false = 只统计不拦截 */
    ENABLED: boolean;
    /** 三个窗口的总限制；0 = 不限 */
    LIMIT_5H: number;
    LIMIT_WEEK: number;
    LIMIT_MONTH: number;
    /** 会话 / 个人预算占总预算的百分比（1..100） */
    SESSION_PERCENT: number;
    USER_PERCENT: number;
    /** 峰时片段（已解析；空 = 不收紧，**绝不回退默认值**） */
    PEAK_RULE: PeakRule;
    /** 四个语言用途的预算百分比 */
    PURPOSE_PERCENT: Record<QuotaPurposeUse, number>;
    /** 超限时是否回复提示 */
    NOTIFY_ON_LIMIT: boolean;
}

/** 默认峰时模板：只用于 `registerTemplateConfig` 的默认值（用户清空后不生效） */
export const DEFAULT_PEAK_TEMPLATE: readonly string[] = ['1-5 09:00-12:00-30', '1-5 14:00-18:00-30'];

export const CONFIG_GROUP = '用量限制';

const KEYS = {
    ENABLED: '启用用量限制',
    LIMIT_5H: '5小时限制',
    LIMIT_WEEK: '一周限制',
    LIMIT_MONTH: '一个月限制',
    SESSION_PERCENT: '会话限制百分比',
    USER_PERCENT: '个人限制百分比',
    PEAK_TEMPLATE: '限制时段及百分比',
    PURPOSE_SUMMARIZATION: '摘要用途百分比',
    PURPOSE_JUDGE: '判定用途百分比',
    PURPOSE_IMAGE: '识图用途百分比',
    PURPOSE_EMBED: '嵌入用途百分比',
    NOTIFY: '超限提示',
} as const;

/** 注册顺序 = 页面显示顺序（单测会断言这个顺序） */
export const QUOTA_CONFIG_KEYS: readonly string[] = [
    KEYS.ENABLED,
    KEYS.LIMIT_5H,
    KEYS.LIMIT_WEEK,
    KEYS.LIMIT_MONTH,
    KEYS.SESSION_PERCENT,
    KEYS.USER_PERCENT,
    KEYS.PEAK_TEMPLATE,
    KEYS.PURPOSE_SUMMARIZATION,
    KEYS.PURPOSE_JUDGE,
    KEYS.PURPOSE_IMAGE,
    KEYS.PURPOSE_EMBED,
    KEYS.NOTIFY,
];

function normalizeLimit(key: string, raw: number): number {
    if (!Number.isFinite(raw) || raw < 0) {
        logger.warning(`「${key}」${raw} 非法（非有限或负数），已回退 0=不限`);
        return 0;
    }
    return Math.floor(raw);
}

function normalizePercent(key: string, raw: number): number {
    if (!Number.isFinite(raw) || raw < 1 || raw > 100) {
        logger.warning(`「${key}」${raw} 超出 1-100，已回退 100`);
        return 100;
    }
    return Math.floor(raw);
}

function defaultView(): QuotaConfigView {
    return {
        ENABLED: false,
        LIMIT_5H: 2_000_000,
        LIMIT_WEEK: 10_000_000,
        LIMIT_MONTH: 40_000_000,
        SESSION_PERCENT: 100,
        USER_PERCENT: 100,
        PEAK_RULE: { segments: [], warnings: [] },
        PURPOSE_PERCENT: {
            summarization: 100,
            judge: 100,
            'image-understanding': 100,
            'text-embedding': 100,
        },
        NOTIFY_ON_LIMIT: true,
    };
}

export default class QuotaConfig {
    static register() {
        seal.ext.registerBoolConfig(
            ext,
            KEYS.ENABLED,
            false,
            '总开关：开启后按下方预算拦截对话请求；关闭时只统计不拦截（可先用 .ai tk quota 观察）。修改后约 1 分钟生效，无需重载',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.LIMIT_5H,
            2_000_000,
            '5 小时窗口内对话 token 上限（输入+输出）；0=不限。每天末段 20:00-24:00 只有 4 小时',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.LIMIT_WEEK,
            10_000_000,
            '自然周（周一 00:00 起）对话 token 上限；单位 token；0=不限',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.LIMIT_MONTH,
            40_000_000,
            '自然月（1 日 00:00 起）对话 token 上限；单位 token；0=不限',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.SESSION_PERCENT,
            100,
            '单会话对话预算 = 有效总预算（总限制×时段百分比）× 本百分比；不预扣、不分割总预算',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.USER_PERCENT,
            100,
            '单个触发者对话预算 = 有效总预算 × 本百分比；定时器/事件等无触发者轮次只受会话与总量限制',
            CONFIG_GROUP,
        );
        seal.ext.registerTemplateConfig(
            ext,
            KEYS.PEAK_TEMPLATE,
            [...DEFAULT_PEAK_TEMPLATE],
            '每框一段：[周几 ]HH:mm-HH:mm-百分比（第三段是百分比不是次数）；时段内有效总预算×百分比；跨 0 点按起始日；空=不收紧',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.PURPOSE_SUMMARIZATION,
            100,
            'summarization 用途预算 = 有效总预算 × 本百分比；用途不占对话总量，全部用途合计以总预算兜底',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.PURPOSE_JUDGE,
            100,
            'judge 用途预算（评分触发 / System One）= 有效总预算 × 本百分比',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.PURPOSE_IMAGE,
            100,
            'image-understanding 用途预算；被拒时图片按文本标签处理',
            CONFIG_GROUP,
        );
        seal.ext.registerIntConfig(
            ext,
            KEYS.PURPOSE_EMBED,
            100,
            'text-embedding 用途预算；被拒时语义检索回退关键词检索',
            CONFIG_GROUP,
        );
        seal.ext.registerBoolConfig(
            ext,
            KEYS.NOTIFY,
            true,
            '对话被拒时是否回复提示；每会话×窗口×维度最多一次；关闭后仅记日志',
            CONFIG_GROUP,
        );
    }

    /** 解析当前配置；任何异常都退化为默认值并 warning（永不抛） */
    static get(): QuotaConfigView {
        const fallback = defaultView();
        try {
            const parsed = parsePeakTemplate(seal.ext.getTemplateConfig(ext, KEYS.PEAK_TEMPLATE));
            parsed.warnings.forEach(warning => logger.warning(warning));
            return {
                ENABLED: seal.ext.getBoolConfig(ext, KEYS.ENABLED),
                LIMIT_5H: normalizeLimit(KEYS.LIMIT_5H, seal.ext.getIntConfig(ext, KEYS.LIMIT_5H)),
                LIMIT_WEEK: normalizeLimit(KEYS.LIMIT_WEEK, seal.ext.getIntConfig(ext, KEYS.LIMIT_WEEK)),
                LIMIT_MONTH: normalizeLimit(KEYS.LIMIT_MONTH, seal.ext.getIntConfig(ext, KEYS.LIMIT_MONTH)),
                SESSION_PERCENT: normalizePercent(KEYS.SESSION_PERCENT, seal.ext.getIntConfig(ext, KEYS.SESSION_PERCENT)),
                USER_PERCENT: normalizePercent(KEYS.USER_PERCENT, seal.ext.getIntConfig(ext, KEYS.USER_PERCENT)),
                PEAK_RULE: parsed,
                PURPOSE_PERCENT: {
                    summarization: normalizePercent(KEYS.PURPOSE_SUMMARIZATION, seal.ext.getIntConfig(ext, KEYS.PURPOSE_SUMMARIZATION)),
                    judge: normalizePercent(KEYS.PURPOSE_JUDGE, seal.ext.getIntConfig(ext, KEYS.PURPOSE_JUDGE)),
                    'image-understanding': normalizePercent(KEYS.PURPOSE_IMAGE, seal.ext.getIntConfig(ext, KEYS.PURPOSE_IMAGE)),
                    'text-embedding': normalizePercent(KEYS.PURPOSE_EMBED, seal.ext.getIntConfig(ext, KEYS.PURPOSE_EMBED)),
                },
                NOTIFY_ON_LIMIT: seal.ext.getBoolConfig(ext, KEYS.NOTIFY),
            };
        } catch (error) {
            logger.warning(`读取「用量限制」配置失败，本次按默认值处理：${error instanceof Error ? error.message : String(error)}`);
            return fallback;
        }
    }
}
