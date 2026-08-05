// 触发配置：默认计数器/计时器/概率/活跃时间/触发正则与令牌桶
import Config, { getRegexConfig } from "../config";

export default class TriggerConfig {
    static ext: seal.ExtInfo;

    static register() {
        TriggerConfig.ext = Config.getExt('消息触发');

        seal.ext.registerIntConfig(TriggerConfig.ext, "默认计数器", 10, "");
        seal.ext.registerFloatConfig(TriggerConfig.ext, "默认计时器", 60, "单位：秒");
        seal.ext.registerFloatConfig(TriggerConfig.ext, "默认概率", 10, "单位：%");
        seal.ext.registerStringConfig(TriggerConfig.ext, "默认触发活跃时间", "10:00-20:00-5", "格式：HH:mm-HH:mm-次数");
        seal.ext.registerFloatConfig(TriggerConfig.ext, "默认向量相似度", 0.8, "0-1之间的浮点数");
        seal.ext.registerTemplateConfig(TriggerConfig.ext, "触发正则表达式", [
            "\\[CQ:at,qq=748569109\\]",
            "^正确.*[。？！?!]$"
        ], "");
        seal.ext.registerStringConfig(TriggerConfig.ext, "触发需要满足的条件", '1', "使用豹语表达式，例如：$t群号_RAW=='2001'");
        seal.ext.registerIntConfig(TriggerConfig.ext, "触发次数上限", 3, "");
        seal.ext.registerIntConfig(TriggerConfig.ext, "触发次数补充间隔", 3, "单位：秒");
    }

    static get() {
        return {
            COUNTER: seal.ext.getIntConfig(TriggerConfig.ext, "默认计数器"),
            TIMER: seal.ext.getFloatConfig(TriggerConfig.ext, "默认计时器"),
            PROBABILITY: seal.ext.getFloatConfig(TriggerConfig.ext, "默认概率"),
            ACTIVE_TIME: seal.ext.getStringConfig(TriggerConfig.ext, "默认触发活跃时间"),
            // 默认向量相似度：预留作向量记忆检索的相似度下限（当前检索未使用阈值过滤）
            VECTOR_SIMILARITY: seal.ext.getFloatConfig(TriggerConfig.ext, "默认向量相似度"),
            TRIGGER_REGEX: getRegexConfig(TriggerConfig.ext, "触发正则表达式"),
            TRIGGER_CONDITION: seal.ext.getStringConfig(TriggerConfig.ext, "触发需要满足的条件"),
            BUCKET_LIMIT: seal.ext.getIntConfig(TriggerConfig.ext, "触发次数上限"),
            FILL_INTERVAL: seal.ext.getIntConfig(TriggerConfig.ext, "触发次数补充间隔")
        }
    }
}
