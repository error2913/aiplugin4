// 记忆配置：三层 bank、抽取/巩固/心智模型、注入预算、后台安全阀。
// 默认值对齐 Hindsight（full / refreshAfterConsolidation=false / minInterval=0 / batch=50 / maxTokens=2048）；
// 全局与群→个人自动抽取默认关（隐私）。
import { ext } from "../ext";

export default class MemoryConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "启用长期记忆", true, "开启后对话内容会沉淀为长期记忆并注入", "记忆");
        seal.ext.registerBoolConfig(ext, "启用观察记忆", true, "开启后用 LLM 将多条事实巩固为观察记忆", "记忆");
        seal.ext.registerBoolConfig(ext, "自动记忆抽取", true, "AI 触发后自动抽取事实；关闭则仅手动/命令写入", "记忆");
        seal.ext.registerBoolConfig(ext, "群聊自动写个人记忆", false, "群聊中关于某个用户的稳定事实写入其个人记忆（隐私敏感，默认关）", "记忆");
        seal.ext.registerBoolConfig(ext, "本体自动抽取", false, "从助手经验/纠正中抽取全局本体记忆（隐私敏感，默认关）", "记忆");
        seal.ext.registerBoolConfig(ext, "启用全局记忆", true, "注入/命令使用本体（global）记忆；无数据零成本", "记忆");
        seal.ext.registerBoolConfig(ext, "自动维护固定心智模型", true, "为个人/群聊/本体补建固定模板，并在首次有来源时生成一次", "记忆");
        seal.ext.registerBoolConfig(ext, "巩固后自动刷新心智模型", false, "默认关闭（Hindsight 默认）；开启后仅 tag 重叠 + 已过期 + 到间隔的模型刷新", "记忆");
        seal.ext.registerOptionConfig(ext, "心智模型刷新模式", "full", ["full", "delta"], "full=全部记忆重新推理（Hindsight 默认）；delta=只喂新增记忆做类型化编辑", "记忆");
        seal.ext.registerIntConfig(ext, "心智模型刷新最小间隔", 1440, "同一模型两次自动刷新的最小分钟数；0=不限（Hindsight 默认，建议开自动刷新时设 30）", "记忆");
        seal.ext.registerIntConfig(ext, "心智模型失败冷却", 30, "刷新失败后暂停自动重试的分钟数", "记忆");
        seal.ext.registerIntConfig(ext, "心智模型输出上限", 2048, "单次刷新/合成输出 token 上限", "记忆");
        seal.ext.registerIntConfig(ext, "增量模型定期重建（小时）", 48, "delta 模型定期 full 重建；仅在开启自动刷新时生效", "记忆");
        seal.ext.registerBoolConfig(ext, "心智模型刷新排除其它心智模型", true, "刷新时不把其它心智模型作为推理输入", "记忆");
        seal.ext.registerFloatConfig(ext, "记忆召回新近度权重", 0.4, "检索时给新近记忆的加分权重（0 为关闭）", "记忆");
        seal.ext.registerIntConfig(ext, "记忆召回新近度半衰期", 60, "新近度加分半衰期（天）", "记忆");
        seal.ext.registerFloatConfig(ext, "记忆召回语义相似度下限", 0.35, "语义通路最低 cosine 相似度", "记忆");
        seal.ext.registerIntConfig(ext, "长期记忆条数上限", 300, "安全阀：超过后按失效/覆盖/衰减淘汰；0=不限制", "记忆");
        seal.ext.registerIntConfig(ext, "记忆注入 token 预算", 3000, "单轮注入记忆总 token 预算", "记忆");
        seal.ext.registerIntConfig(ext, "观察记忆过期天数", 90, "超过该天数无新证据的观察不注入（不删除）", "记忆");
        seal.ext.registerIntConfig(ext, "后台记忆 LLM 每小时上限", 20, "后台抽取/巩固/刷新每小时最多 LLM 调用次数；0=不限", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM重排召回结果", false, "使用 LLM 对召回结果重新排序（较慢）", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM合成观察记忆", true, "使用 LLM 合成观察/做观察决策", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM推理记忆", true, "使用 LLM 合成心智模型/reflect 答案", "记忆");
    }

    static get() {
        const memoryEnabled = seal.ext.getBoolConfig(ext, "启用长期记忆");
        const observationEnabled = seal.ext.getBoolConfig(ext, "启用观察记忆");
        return {
            MEMORY_ENABLED: memoryEnabled,
            OBSERVATION_ENABLED: observationEnabled,
            EXTRACT_ENABLED: seal.ext.getBoolConfig(ext, "自动记忆抽取"),
            EXTRACT_PERSONAL_FROM_GROUP: seal.ext.getBoolConfig(ext, "群聊自动写个人记忆"),
            EXTRACT_GLOBAL: seal.ext.getBoolConfig(ext, "本体自动抽取"),
            GLOBAL_MEMORY_ENABLED: seal.ext.getBoolConfig(ext, "启用全局记忆"),
            MM_TEMPLATES: seal.ext.getBoolConfig(ext, "自动维护固定心智模型"),
            MM_REFRESH_AFTER_CONSOLIDATION: seal.ext.getBoolConfig(ext, "巩固后自动刷新心智模型"),
            MM_MODE: seal.ext.getOptionConfig(ext, "心智模型刷新模式"),
            MM_MIN_REFRESH_INTERVAL_MIN: seal.ext.getIntConfig(ext, "心智模型刷新最小间隔"),
            MM_FAILED_COOLDOWN_MIN: seal.ext.getIntConfig(ext, "心智模型失败冷却"),
            MM_MAX_TOKENS: seal.ext.getIntConfig(ext, "心智模型输出上限"),
            MM_DELTA_FULL_REBUILD_HOURS: seal.ext.getIntConfig(ext, "增量模型定期重建（小时）"),
            MM_EXCLUDE_SIBLINGS: seal.ext.getBoolConfig(ext, "心智模型刷新排除其它心智模型"),
            RECALL_RECENCY_WEIGHT: seal.ext.getFloatConfig(ext, "记忆召回新近度权重"),
            RECALL_RECENCY_HALF_LIFE_DAYS: seal.ext.getIntConfig(ext, "记忆召回新近度半衰期"),
            RECALL_SEMANTIC_MIN_SIM: seal.ext.getFloatConfig(ext, "记忆召回语义相似度下限"),
            MEMORY_MAX_FACTS: seal.ext.getIntConfig(ext, "长期记忆条数上限"),
            MEMORY_PROMPT_TOKENS: seal.ext.getIntConfig(ext, "记忆注入 token 预算"),
            OBSERVATION_STALE_DAYS: seal.ext.getIntConfig(ext, "观察记忆过期天数"),
            BACKGROUND_HOURLY_LLM_CAP: seal.ext.getIntConfig(ext, "后台记忆 LLM 每小时上限"),
            LLM_RERANK: seal.ext.getBoolConfig(ext, "用LLM重排召回结果"),
            LLM_OBS_SYNTH: seal.ext.getBoolConfig(ext, "用LLM合成观察记忆"),
            LLM_REFLECT_SYNTH: seal.ext.getBoolConfig(ext, "用LLM推理记忆"),
            // 兼容旧键（代码逐步迁移；新代码使用上面的 key）
            MEMORY: memoryEnabled,
            SUMMARY: observationEnabled,
            MEMORY_CAP: seal.ext.getIntConfig(ext, "长期记忆条数上限"),
            MEMORY_MM_TEMPLATES: seal.ext.getBoolConfig(ext, "自动维护固定心智模型"),
            MEMORY_REFRESH_AFTER_CONSOLIDATE: seal.ext.getBoolConfig(ext, "巩固后自动刷新心智模型"),
            MEMORY_REFRESH_MIN_INTERVAL: seal.ext.getIntConfig(ext, "心智模型刷新最小间隔"),
            MEMORY_MM_DEFAULT_MODE: seal.ext.getOptionConfig(ext, "心智模型刷新模式"),
            MEMORY_MM_EXCLUDE_SIBLINGS: seal.ext.getBoolConfig(ext, "心智模型刷新排除其它心智模型"),
            MEMORY_LLM_RERANK: seal.ext.getBoolConfig(ext, "用LLM重排召回结果"),
            MEMORY_OBSERVATION_SYNTH: seal.ext.getBoolConfig(ext, "用LLM合成观察记忆"),
            MEMORY_REFLECT_SYNTH: seal.ext.getBoolConfig(ext, "用LLM推理记忆"),
            MEMORY_RECENCY_WEIGHT: seal.ext.getFloatConfig(ext, "记忆召回新近度权重"),
            MEMORY_RECENCY_HALF_LIFE_DAYS: seal.ext.getIntConfig(ext, "记忆召回新近度半衰期"),
        };
    }
}
