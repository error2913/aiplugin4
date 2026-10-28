// 上下文配置：Context v2 新键（旧键、旧回退字段全部移除）。
import { logger } from "../../logger";
import { DEFAULT_HOURLY_COMPACT_CAP, DEFAULT_RETAIN_PERCENT, normalizeRetainPercent } from "../../utils/context_limits";
import { ext } from "../ext";

export default class ContextConfig {
    static register() {
        // 预设上下文：提示词构造仍需要
        seal.ext.registerTemplateConfig(ext, "预设上下文", [""], "每框一条预设上下文，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "上下文");

        // Context v2 配置
        seal.ext.registerIntConfig(ext, "上下文预算", 131072, "上下文 token 预算；0=跟随报错探测到的模型真实窗口×0.8（未探测到回退 100 万）", "上下文");
        seal.ext.registerIntConfig(ext, "保留强度", DEFAULT_RETAIN_PERCENT, "最近原文保留占上下文预算的百分比（1-100）；压缩后保留这个比例的最新原文，其余滚动摘要；同时作为消息标签边界", "上下文");
        seal.ext.registerIntConfig(ext, "待机入库配额", 0, "待机会话每小时最多入库多少条普通群消息（0=不限）", "上下文");
        seal.ext.registerIntConfig(ext, "每小时后台压缩上限", DEFAULT_HOURLY_COMPACT_CAP, "每小时最多自动压缩批次数（每批约 6000 token）；0=不限", "上下文");
    }

    static get() {
        const retainRaw = seal.ext.getIntConfig(ext, "保留强度");
        const retainPercent = normalizeRetainPercent(retainRaw);
        if (retainPercent !== retainRaw) {
            logger.warning(`「保留强度」${retainRaw} 超出 1-100，已回退 ${retainPercent}%`);
        }
        return {
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(ext, "预设上下文"),
            BUDGET_TOKENS: seal.ext.getIntConfig(ext, "上下文预算"),
            RETAIN_PERCENT: retainPercent,
            STANDBY_QUOTA: Math.max(0, seal.ext.getIntConfig(ext, "待机入库配额")),
            HOURLY_COMPACT_CAP: Math.max(0, seal.ext.getIntConfig(ext, "每小时后台压缩上限")),
        };
    }
}
