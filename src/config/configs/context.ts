// 上下文配置：独立「上下文」分组
import { logger } from "../../logger";
import { ext } from "../config";

export default class ContextConfig {
    static register() {
        seal.ext.registerIntConfig(ext, "上下文最大token", 1000000, "持久化上下文 token 上限；0/负数视为无效并回退默认 1000000", "上下文");
        seal.ext.registerIntConfig(ext, "对话保存轮数", 5, "上下文超过最大 token 后保留的最近真实用户轮数；更早消息会先归档总结再删除", "上下文");
        seal.ext.registerTemplateConfig(ext, "预设上下文", [""], "每行一条预设上下文，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "上下文");
        seal.ext.registerIntConfig(ext, "插入system message间隔轮数", 0, "需要小于限制轮数的二分之一才能生效，为0时不生效，预设上下文不计入轮数", "上下文");
        seal.ext.registerIntConfig(ext, "消息压缩阈值", 2000, "用户消息（含连续多条合并后）超过该字符数时，使用压缩智能体压缩后存入上下文", "上下文");
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
            COMPRESS_THRESHOLD: seal.ext.getIntConfig(ext, "消息压缩阈值")
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
