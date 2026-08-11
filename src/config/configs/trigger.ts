// 触发配置：默认计数器/计时器/概率/活跃时间/触发正则与令牌桶
import { ext } from "../config";
import { getRegexConfig } from "../config";

export default class TriggerConfig {
    static register() {
        seal.ext.registerIntConfig(ext, "默认计数器", 10, "计数器模式下达到该条数触发回复", "消息触发");
        seal.ext.registerFloatConfig(ext, "默认计时器", 60, "计时器模式下间隔多少秒触发回复", "消息触发");
        seal.ext.registerFloatConfig(ext, "默认概率", 10, "概率模式下每条消息触发回复的概率（%）", "消息触发");
        seal.ext.registerStringConfig(ext, "默认触发活跃时间", "10:00-20:00-5", "格式：HH:mm-HH:mm-次数，示例 10:00-20:00-5 表示 10:00-20:00 之间最多触发 5 次", "消息触发");
        seal.ext.registerFloatConfig(ext, "默认向量相似度", 0.8, "向量记忆检索的相似度下限，0-1 浮点数；低于该值的记忆不返回", "消息触发");
        seal.ext.registerTemplateConfig(ext, "触发正则表达式", [
            "\\[CQ:at,qq=3893625976\\]",
            "^正确.*[。？！?!]$"
        ], "每行一个正则，任一命中即触发回复（如 @机器人 或包含关键词）；示例：^你好.*；修改后自动生效（缓存最多 1 分钟）", "消息触发");
        seal.ext.registerStringConfig(ext, "触发需要满足的条件", '1', "额外的豹语表达式条件，命中为 1 才触发；示例：$t群号_RAW=='2001'，不需要额外条件时填 1", "消息触发");
        seal.ext.registerIntConfig(ext, "触发次数上限", 3, "消息触发令牌桶容量，达到上限后需等待补充", "消息触发");
        seal.ext.registerIntConfig(ext, "触发次数补充间隔", 3, "令牌桶补充间隔（秒）", "消息触发");
    }

    static get() {
        return {
            COUNTER: seal.ext.getIntConfig(ext, "默认计数器"),
            TIMER: seal.ext.getFloatConfig(ext, "默认计时器"),
            PROBABILITY: seal.ext.getFloatConfig(ext, "默认概率"),
            ACTIVE_TIME: seal.ext.getStringConfig(ext, "默认触发活跃时间"),
            // 默认向量相似度：向量记忆检索的相似度下限（低于该值的记忆不返回）
            VECTOR_SIMILARITY: seal.ext.getFloatConfig(ext, "默认向量相似度"),
            TRIGGER_REGEX: getRegexConfig(ext, "触发正则表达式"),
            TRIGGER_CONDITION: seal.ext.getStringConfig(ext, "触发需要满足的条件"),
            BUCKET_LIMIT: seal.ext.getIntConfig(ext, "触发次数上限"),
            FILL_INTERVAL: seal.ext.getIntConfig(ext, "触发次数补充间隔")
        }
    }
}
