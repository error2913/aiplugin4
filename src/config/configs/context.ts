// 上下文配置：Context v2 新键（旧键不再注册）。
// 旧键仍被「未接入 v2 的回退路径」读取（迁移失败/单测旧路径），但生产 v2 只用下列新键。
import { logger } from "../../logger";
import { ext } from "../ext";

export default class ContextConfig {
    static register() {
        // 预设上下文 / system 插入间隔：提示词构造仍需要，保留
        seal.ext.registerTemplateConfig(ext, "预设上下文", [""], "每框一条预设上下文，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "上下文");
        seal.ext.registerIntConfig(ext, "插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，预设上下文不计入轮数", "上下文");

        // Context v2 新配置（旧键不再注册）
        seal.ext.registerIntConfig(ext, "上下文预算", 0, "上下文 token 预算；0=跟随报错探测到的模型真实窗口×0.8（未探测到回退 100 万）", "上下文");
        seal.ext.registerIntConfig(ext, "保留强度", 40, "最近内容至少占预算的百分比（1-100）", "上下文");
        seal.ext.registerIntConfig(ext, "摘要水位", 6000, "后台滚动摘要的积压 token 水位；0=关闭自动摘要", "上下文");
        seal.ext.registerIntConfig(ext, "原文保留天数", 0, "原文事件保留天数；0=永久保留（默认）", "上下文");
        seal.ext.registerIntConfig(ext, "待机入库配额", 0, "待机会话每小时最多入库多少条普通群消息（0=不限）", "上下文");
        seal.ext.registerIntConfig(ext, "每小时后台压缩上限", 6, "每小时最多自动压缩次数；0=不限", "上下文");
        seal.ext.registerIntConfig(ext, "原文保留页数上限", 0, "每个会话保留的事件页数上限；0=不限", "上下文");
    }

    static get() {
        // 旧配置读取：仅回退路径使用；键已不注册，生产读取不到时按 0 处理
        const oldInt = (key: string): number => {
            try {
                return seal.ext.getIntConfig(ext, key);
            } catch {
                return 0;
            }
        };
        const oldBool = (key: string): boolean => {
            try {
                return seal.ext.getBoolConfig(ext, key);
            } catch {
                return false;
            }
        };
        const MAX_ROUNDS = oldInt("对话保存轮数");
        const INSERT_COUNT = normalizeInsertCount(oldInt("插入system message间隔轮数"), MAX_ROUNDS);
        return {
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(ext, "预设上下文"),
            MAX_ROUNDS,
            MAX_CONTEXT_TOKENS: oldInt("上下文最大token"),
            INSERT_COUNT,
            // legacy 回退字段（v2 生产不使用）
            COMPRESS_THRESHOLD: oldInt("消息压缩阈值"),
            COLD_WINDOW_CHARS: oldInt("冷态窗口字数"),
            COLD_SINGLE_TRUNCATE: oldInt("冷态单条截断字数"),
            ARCHIVE_KEEP_RAW: oldBool("归档保留原文"),
            WINDOW_MAX_CHARS: oldInt("窗口上限字数"),
            SETTLE_WATERMARK: oldInt("结算水位"),
            SETTLE_MIN_TOKENS: oldInt("结算最小门槛"),
            SETTLE_IDLE_SEC: oldInt("结算空闲门槛"),
            SETTLE_MAX_SHARDS: normalizePositive(oldInt("单次结算调用上限"), 2, "单次结算调用上限"),
            SHARD_TTL_DAYS: oldInt("原文分片保留天数"),
            SHARD_LIMIT: normalizePositive(oldInt("原文分片上限"), 200, "原文分片上限"),
            STANDBY_INGEST_QUOTA: oldInt("待机入库配额"),
            // Context v2
            BUDGET_TOKENS: seal.ext.getIntConfig(ext, "上下文预算"),
            RETAIN_PERCENT: normalizeRetain(seal.ext.getIntConfig(ext, "保留强度")),
            SUMMARY_WATERMARK: Math.max(0, seal.ext.getIntConfig(ext, "摘要水位")),
            RETAIN_DAYS: Math.max(0, seal.ext.getIntConfig(ext, "原文保留天数")),
            STANDBY_QUOTA: Math.max(0, seal.ext.getIntConfig(ext, "待机入库配额")),
            HOURLY_COMPACT_CAP: Math.max(0, seal.ext.getIntConfig(ext, "每小时后台压缩上限")),
            MAX_RETAINED_PAGES: Math.max(0, seal.ext.getIntConfig(ext, "原文保留页数上限")),
        };
    }
}

/** 插入 system message 间隔轮数校验：必须 > 0 且小于「对话保存轮数」的一半才生效 */
function normalizeInsertCount(raw: number, maxRounds: number): number {
    if (raw <= 0) return 0;
    if (maxRounds > 0 && raw * 2 >= maxRounds) {
        logger.warning(`「插入system message间隔轮数」${raw} 未小于「对话保存轮数」${maxRounds} 的二分之一，已按关闭处理`);
        return 0;
    }
    return raw;
}

function normalizeRetain(raw: number): number {
    if (raw < 1 || raw > 100) {
        logger.warning(`「保留强度」${raw}% 超出 1-100，已回退 40%`);
        return 40;
    }
    return raw;
}

/** 必须为正数的旧配置项：<= 0 时回退默认并告警（仅回退路径） */
function normalizePositive(raw: number, fallback: number, name: string): number {
    if (raw > 0) return raw;
    logger.warning(`「${name}」必须为正数，已回退默认值 ${fallback}`);
    return fallback;
}
