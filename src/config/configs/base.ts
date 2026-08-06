// 基础配置：日志级别/超时/SealDice 路径/全局待机
import { ext } from "../config";
export default class BaseConfig {
    static register() {
        seal.ext.registerOptionConfig(ext, "日志级别", "信息", ["从不", "错误", "警告", "信息", "调试"], "", "基础");
        seal.ext.registerBoolConfig(ext, "日志简短打印", true, "日志超长时只保留首尾各 500 字", "基础");
        seal.ext.registerBoolConfig(ext, "日志记录消息内容", true, "关闭后请求上下文日志只记录角色与长度，不打印消息正文", "基础");
        seal.ext.registerIntConfig(ext, "请求超时时限", 180000, "单位：毫秒", "基础");
        seal.ext.registerIntConfig(ext, "请求并发上限", 1, "同时进行中的请求数量上限，0 表示不限制", "基础");
        seal.ext.registerIntConfig(ext, "请求队列上限", 5, "超出并发上限后排队等待的请求数量上限，超过后直接丢弃；0 表示超出并发后不排队", "基础");
        seal.ext.registerStringConfig(ext, "海豹核心全局路径", "/root/sealdice", "本地资源相对路径拼接用的 SealDice 核心目录", "基础");
        seal.ext.registerBoolConfig(ext, "是否开启全局待机", false, "开启后，全局的ai将进入待机状态，可能造成性能问题", "基础");
    }

    static get() {
        return {
            LOG_LEVEL: seal.ext.getOptionConfig(ext, "日志级别") as "从不" | "错误" | "警告" | "信息" | "调试",
            LOG_SHORT_PRINT: seal.ext.getBoolConfig(ext, "日志简短打印"),
            LOG_MESSAGE_CONTENT: seal.ext.getBoolConfig(ext, "日志记录消息内容"),
            TIMEOUT: seal.ext.getIntConfig(ext, "请求超时时限"),
            REQUEST_CONCURRENCY: seal.ext.getIntConfig(ext, "请求并发上限"),
            REQUEST_QUEUE: seal.ext.getIntConfig(ext, "请求队列上限"),
            SEALDICE_PATH: seal.ext.getStringConfig(ext, "海豹核心全局路径"),
            GLOBAL_STANDBY: seal.ext.getBoolConfig(ext, "是否开启全局待机"),
        }
    }
}
