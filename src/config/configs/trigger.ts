import { Config, getRegexConfig } from "../config";

export class TriggerConfig {
    static ext: seal.ExtInfo;

    static register() {
        TriggerConfig.ext = Config.getExt('aiplugin4:消息触发');

        seal.ext.registerIntConfig(TriggerConfig.ext, "默认计数器", 10, "");
        seal.ext.registerFloatConfig(TriggerConfig.ext, "默认计时器/s", 60, "");
        seal.ext.registerFloatConfig(TriggerConfig.ext, "默认概率/%", 10, "");
        seal.ext.registerStringConfig(TriggerConfig.ext, "默认触发活跃时间", "10:00-20:00-5", "");
        seal.ext.registerFloatConfig(TriggerConfig.ext, "默认向量相似度", 0.8, "");
        seal.ext.registerTemplateConfig(TriggerConfig.ext, "触发正则表达式", [
            "\\[CQ:at,qq=748569109\\]",
            "^正确.*[。？！?!]$"
        ], "");
        seal.ext.registerIntConfig(TriggerConfig.ext, "触发次数上限", 3, "");
        seal.ext.registerIntConfig(TriggerConfig.ext, "触发次数补充间隔/s", 3, "");
    }

    static get() {
        return {
            COUNTER: seal.ext.getIntConfig(TriggerConfig.ext, "默认计数器"),
            TIMER: seal.ext.getFloatConfig(TriggerConfig.ext, "默认计时器/s"),
            PROBABILITY: seal.ext.getFloatConfig(TriggerConfig.ext, "默认概率/%"),
            ACTIVE_TIME: seal.ext.getStringConfig(TriggerConfig.ext, "默认触发活跃时间"),
            VECTOR_SIMILARITY: seal.ext.getFloatConfig(TriggerConfig.ext, "默认向量相似度"),
            TRIGGER_REGEX: getRegexConfig(TriggerConfig.ext, "触发正则表达式"),
            BUCKET_LIMIT: seal.ext.getIntConfig(TriggerConfig.ext, "触发次数上限"),
            FILL_INTERVAL: seal.ext.getIntConfig(TriggerConfig.ext, "触发次数补充间隔/s")
        }
    }
}