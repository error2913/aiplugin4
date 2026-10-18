// 上下文配置：独立「上下文」分组
import { logger } from "../../logger";
import { ext } from "../config";

export default class ContextConfig {
    static register() {
        seal.ext.registerIntConfig(ext, "上下文最大token", 1000000, "持久化上下文 token 上限；0/负数视为无效并回退默认 1000000", "上下文");
        seal.ext.registerIntConfig(ext, "对话保存轮数", 5, "上下文超过最大 token 后保留的最近真实用户轮数；更早消息会先归档总结再删除", "上下文");
        seal.ext.registerTemplateConfig(ext, "预设上下文", [""], "每框一条预设上下文，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "上下文");
        seal.ext.registerIntConfig(ext, "插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，预设上下文不计入轮数", "上下文");
        seal.ext.registerIntConfig(ext, "消息压缩阈值", 2000, "用户消息（含连续多条合并后）超过该字符数时，使用压缩智能体压缩后存入上下文；压缩前原文自动保留，AI 可用 read_raw kind=user 按 msg_id/blk:id 查看原文", "上下文");
        seal.ext.registerIntConfig(ext, "冷态窗口字数", 5000, "待机（冷态）下模型可见的最近内容字数：超过则把更早内容折叠为纯代码摘要（不调用模型）；0=不折叠", "上下文");
        seal.ext.registerIntConfig(ext, "冷态单条截断字数", 500, "待机（冷态）时单条消息超过该字数则留头留尾（原文仍可用 read_raw 查）；0=不截断", "上下文");
        seal.ext.registerBoolConfig(ext, "归档保留原文", true, "开启时：归档时把群聊原文写入归档分片（可用 read_raw kind=user id=arc:序号 回查），并调用总结智能体沉淀记忆；关闭时：归档不留原文、不写分片（省存储），但仍会调用总结智能体沉淀记忆——历史依旧进长期记忆，只是之后无法回查原文", "上下文");
        seal.ext.registerIntConfig(ext, "窗口上限字数", 20000, "上下文里保留的最近内容字数上界：超出部分移出到原文分片（session_<会话ID>:raw:<序号>，可用 read_raw kind=user id=raw:序号 回查），使会话存档体积与消息总量解耦；0=不移出（保持旧行为）", "上下文");
        seal.ext.registerIntConfig(ext, "结算水位", 3000, "待结算积压达到该 token 数才把窗口外原文总结进长期记忆（0=关闭自动结算）", "上下文");
        seal.ext.registerIntConfig(ext, "结算最小门槛", 20000, "上下文总量低于该 token 数时不做 LLM 结算，避免短会话也调用总结智能体", "上下文");
        seal.ext.registerIntConfig(ext, "结算空闲门槛", 600, "距上次相关活动达到该秒数才结算（0=不要求空闲）；会话转入冷态时也会结算一次", "上下文");
        seal.ext.registerIntConfig(ext, "单次结算调用上限", 2, "每次结算最多处理多少个分片（限制单次 LLM 调用量）", "上下文");
        seal.ext.registerIntConfig(ext, "原文分片保留天数", 30, "原文分片（归档/窗口移出）超过该天数后惰性淘汰；0=不按时间淘汰", "上下文");
        seal.ext.registerIntConfig(ext, "原文分片上限", 200, "每个会话的原文分片数量上限：超出时把最旧的分片置空（海豹无删除 API，置空即项目内先例做法）", "上下文");
    }

    static get() {
        const MAX_ROUNDS = seal.ext.getIntConfig(ext, "对话保存轮数");
        const INSERT_COUNT = normalizeInsertCount(seal.ext.getIntConfig(ext, "插入system message间隔轮数"), MAX_ROUNDS);
        const rawMaxTokens = seal.ext.getIntConfig(ext, "上下文最大token");
        const MAX_CONTEXT_TOKENS = rawMaxTokens > 0 ? rawMaxTokens : 1000000;
        if (rawMaxTokens <= 0) {
            logger.warning(`「上下文最大token」不能为 0，已自动使用默认值 1000000`);
        }
        return {
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(ext, "预设上下文"),
            MAX_ROUNDS,
            MAX_CONTEXT_TOKENS,
            INSERT_COUNT,
            COMPRESS_THRESHOLD: seal.ext.getIntConfig(ext, "消息压缩阈值"),
            COLD_WINDOW_CHARS: seal.ext.getIntConfig(ext, "冷态窗口字数"),
            COLD_SINGLE_TRUNCATE: seal.ext.getIntConfig(ext, "冷态单条截断字数"),
            ARCHIVE_KEEP_RAW: seal.ext.getBoolConfig(ext, "归档保留原文"),
            WINDOW_MAX_CHARS: seal.ext.getIntConfig(ext, "窗口上限字数"),
            SETTLE_WATERMARK: seal.ext.getIntConfig(ext, "结算水位"),
            SETTLE_MIN_TOKENS: seal.ext.getIntConfig(ext, "结算最小门槛"),
            SETTLE_IDLE_SEC: seal.ext.getIntConfig(ext, "结算空闲门槛"),
            // 上限 <= 0 会静默关闭结算（无任何提示），与「结算水位」的"0=关闭"语义混淆。
            // 这里统一回退到默认 2，只把"水位=0"作为唯一的关闭开关，避免用户误设后以为坏了。
            SETTLE_MAX_SHARDS: normalizePositive(seal.ext.getIntConfig(ext, "单次结算调用上限"), 2, "单次结算调用上限"),
            SHARD_TTL_DAYS: seal.ext.getIntConfig(ext, "原文分片保留天数"),
            SHARD_LIMIT: normalizePositive(seal.ext.getIntConfig(ext, "原文分片上限"), 200, "原文分片上限")
        }
    }
}

/**
 * 插入 system message 间隔轮数校验：必须 > 0 且小于「对话保存轮数」的一半才生效，
 * 否则按关闭（0）处理并告警，避免插入频率超过历史窗口导致 system 消息占满上下文。
 */
function normalizeInsertCount(raw: number, maxRounds: number): number {
    if (raw <= 0) return 0;
    if (maxRounds > 0 && raw * 2 >= maxRounds) {
        logger.warning(`「插入system message间隔轮数」${raw} 未小于「对话保存轮数」${maxRounds} 的二分之一，已按关闭处理`);
        return 0;
    }
    return raw;
}

/**
 * 必须为正数的配置项：<= 0 时回退默认并告警。
 * 用于「单次结算调用上限」这类"设成 0 会静默关闭功能"的项——避免用户误设后无从察觉。
 */
function normalizePositive(raw: number, fallback: number, name: string): number {
    if (raw > 0) return raw;
    logger.warning(`「${name}」必须为正数，已回退默认值 ${fallback}`);
    return fallback;
}
