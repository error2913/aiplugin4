// 记忆配置：长期记忆/观察记忆（知识库配置见 knowledge_base.ts，独立「知识库」页签）
import { ext } from "../config";


export default class MemoryConfig {
    static register() {
        // 总开关
        seal.ext.registerBoolConfig(ext, "启用长期记忆", true, "开启后对话内容会沉淀为长期记忆", "记忆");
        seal.ext.registerBoolConfig(ext, "启用观察记忆", true, "开启后定期对对话进行观察记忆", "记忆");
        // 观察记忆参数
        seal.ext.registerIntConfig(ext, "每隔多少轮对话生成一次观察", 10, "每累计多少轮对话自动生成一次观察记忆", "记忆");
        seal.ext.registerIntConfig(ext, "每次观察纳入最近的对话轮数", 10, "每次生成观察记忆时纳入最近的多少轮对话", "记忆");
        seal.ext.registerIntConfig(ext, "每隔多少次观察整合一次记忆", 30, "每累计多少次观察后自动整合重复观察，0 为关闭", "记忆");
        // Hindsight 式检索新近度加权：只影响召回排序，不删除旧记忆
        seal.ext.registerFloatConfig(ext, "记忆召回新近度权重", 0.4, "检索时给新近记忆的加分权重（0 为关闭）", "记忆");
        seal.ext.registerIntConfig(ext, "记忆召回新近度半衰期", 60, "新近度加分半衰期（天），越大旧记忆衰减越慢", "记忆");
        // 遗忘机制：长期记忆条数上限（0 = 不限制，超限按覆盖/衰减优先级物理删除）
        seal.ext.registerIntConfig(ext, "长期记忆条数上限", 100, "长期记忆超过该条数自动遗忘最不重要的记忆，0 为不限制", "记忆");
        // 高级 LLM 选项
        seal.ext.registerBoolConfig(ext, "用LLM抽取记忆", false, "使用 LLM 从对话中抽取原子事实（实验性，默认关闭）", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM重排召回结果", false, "使用 LLM 对召回结果重新排序（较慢，默认关闭）", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM合成观察记忆", true, "使用 LLM 合成观察记忆（默认开启）", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM推理记忆", true, "使用 LLM 合成心智模型推理答案（.ai memo mm / reflect 使用，默认开启）", "记忆");
        seal.ext.registerBoolConfig(ext, "自动维护固定心智模型", true, "自动为个人/群聊补建写死的固定心智模型问题（设定/偏好/规则），并优先固定注入；删除后不会自动重建", "记忆");
        seal.ext.registerBoolConfig(ext, "巩固后自动刷新心智模型", true, "巩固记忆后自动基于最新记忆刷新心智模型（默认开启）", "记忆");
        seal.ext.registerIntConfig(ext, "心智模型刷新最小间隔", 30, "自动刷新心智模型的最小间隔（分钟），0 为不限制", "记忆");
        // Hindsight 式心智模型刷新配置
        seal.ext.registerOptionConfig(ext, "心智模型刷新模式", "full", ["full", "delta"], "新增心智模型刷新方式：full=基于全部记忆重新推理，delta=只按新增记忆增量更新", "记忆");
        seal.ext.registerBoolConfig(ext, "心智模型刷新排除其它心智模型", true, "刷新心智模型时不把其它心智模型作为推理输入，避免互相引用", "记忆");
        seal.ext.registerIntConfig(ext, "心智模型定时刷新间隔", 0, "每累计该分钟数自动检查并刷新心智模型（仅当有新记忆时实际刷新），0 为关闭", "记忆");
    }

    static get() {
        return {
            MEMORY: seal.ext.getBoolConfig(ext, "启用长期记忆"),
            SUMMARY: seal.ext.getBoolConfig(ext, "启用观察记忆"),
            SUMMARY_INTERVAL: seal.ext.getIntConfig(ext, "每隔多少轮对话生成一次观察"),
            SUMMARY_SIZE: seal.ext.getIntConfig(ext, "每次观察纳入最近的对话轮数"),
            CONSOLIDATE_INTERVAL: seal.ext.getIntConfig(ext, "每隔多少次观察整合一次记忆"),
            MEMORY_LLM_EXTRACT: seal.ext.getBoolConfig(ext, "用LLM抽取记忆"),
            MEMORY_LLM_RERANK: seal.ext.getBoolConfig(ext, "用LLM重排召回结果"),
            MEMORY_OBSERVATION_SYNTH: seal.ext.getBoolConfig(ext, "用LLM合成观察记忆"),
            MEMORY_REFLECT_SYNTH: seal.ext.getBoolConfig(ext, "用LLM推理记忆"),
            MEMORY_MM_TEMPLATES: seal.ext.getBoolConfig(ext, "自动维护固定心智模型"),
            MEMORY_REFRESH_AFTER_CONSOLIDATE: seal.ext.getBoolConfig(ext, "巩固后自动刷新心智模型"),
            MEMORY_REFRESH_MIN_INTERVAL: seal.ext.getIntConfig(ext, "心智模型刷新最小间隔"),
            MEMORY_MM_DEFAULT_MODE: seal.ext.getOptionConfig(ext, "心智模型刷新模式"),
            MEMORY_MM_EXCLUDE_SIBLINGS: seal.ext.getBoolConfig(ext, "心智模型刷新排除其它心智模型"),
            MEMORY_MM_TICK_INTERVAL: seal.ext.getIntConfig(ext, "心智模型定时刷新间隔"),
            MEMORY_RECENCY_WEIGHT: seal.ext.getFloatConfig(ext, "记忆召回新近度权重"),
            MEMORY_RECENCY_HALF_LIFE_DAYS: seal.ext.getIntConfig(ext, "记忆召回新近度半衰期"),
            MEMORY_CAP: seal.ext.getIntConfig(ext, "长期记忆条数上限")
        }
    }
}
