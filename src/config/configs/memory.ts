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
        // 高级 LLM 选项
        seal.ext.registerBoolConfig(ext, "用LLM抽取记忆", false, "使用 LLM 从对话中抽取原子事实（实验性，默认关闭）", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM重排召回结果", false, "使用 LLM 对召回结果重新排序（较慢，默认关闭）", "记忆");
        seal.ext.registerBoolConfig(ext, "用LLM合成观察记忆", true, "使用 LLM 合成观察记忆（默认开启）", "记忆");
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
            MEMORY_OBSERVATION_SYNTH: seal.ext.getBoolConfig(ext, "用LLM合成观察记忆")
        }
    }
}
