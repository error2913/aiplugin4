// 上下文配置：Context v2 新键（旧键、旧回退字段全部移除）。
import { ext } from "../ext";

export default class ContextConfig {
    static register() {
        // 预设上下文：提示词构造仍需要
        seal.ext.registerTemplateConfig(ext, "预设上下文", [""], "每框一条预设上下文，role 按 user/assistant 轮流出现，帮助模型学习对话语气", "上下文");

        // Context v2 配置（旧键不再注册，也不再读取）
        seal.ext.registerIntConfig(ext, "上下文预算", 0, "上下文 token 预算；0=跟随报错探测到的模型真实窗口×0.8（未探测到回退 100 万）", "上下文");
        seal.ext.registerIntConfig(ext, "摘要水位", 6000, "后台滚动摘要的积压 token 水位；0=关闭自动摘要", "上下文");
        seal.ext.registerIntConfig(ext, "待机入库配额", 0, "待机会话每小时最多入库多少条普通群消息（0=不限）", "上下文");
        seal.ext.registerIntConfig(ext, "每小时后台压缩上限", 6, "每小时最多自动压缩次数；0=不限", "上下文");
    }

    static get() {
        return {
            SAMPLE_MESSAGES: seal.ext.getTemplateConfig(ext, "预设上下文"),
            BUDGET_TOKENS: seal.ext.getIntConfig(ext, "上下文预算"),
            SUMMARY_WATERMARK: Math.max(0, seal.ext.getIntConfig(ext, "摘要水位")),
            STANDBY_QUOTA: Math.max(0, seal.ext.getIntConfig(ext, "待机入库配额")),
            HOURLY_COMPACT_CAP: Math.max(0, seal.ext.getIntConfig(ext, "每小时后台压缩上限")),
        };
    }
}
