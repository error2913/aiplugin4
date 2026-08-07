// 基础配置：日志级别/超时/SealDice 路径/全局待机
import { ext } from "../config";
export default class BaseConfig {
    static register() {
        seal.ext.registerOptionConfig(ext, "日志级别", "信息", ["从不", "错误", "警告", "信息", "调试"], "控制台日志详细程度；日常建议「信息」，排查问题时切「调试」可看到更多细节", "基础");
        seal.ext.registerBoolConfig(ext, "日志简短打印", true, "开启后超长日志只保留首尾各 500 字，便于快速定位", "基础");
        seal.ext.registerBoolConfig(ext, "日志记录消息内容", true, "开启后请求上下文日志会打印消息正文；关闭则只记录角色与长度", "基础");
        seal.ext.registerIntConfig(ext, "请求超时时限", 180000, "单次模型请求的超时时限，单位毫秒（默认 180000=3 分钟）", "基础");
        seal.ext.registerIntConfig(ext, "请求并发上限", 1, "同时进行的模型请求数量上限，0 表示不限制", "基础");
        seal.ext.registerIntConfig(ext, "请求队列上限", 5, "超出并发上限后排队等待的请求数量上限，队列满后新请求直接丢弃；0 表示超出并发后不排队", "基础");
        seal.ext.registerStringConfig(ext, "海豹核心全局路径", "/root/sealdice", "用于拼接本地图片/语音等资源相对路径的 SealDice 核心目录；Windows 部署请填海豹实际安装目录", "基础");
        seal.ext.registerBoolConfig(ext, "是否开启全局待机", false, "开启后 AI 不主动回复，收到的所有消息会录入上下文（会话的计数器/计时器/概率仍可触发）。\n长时间开启可能占用较多上下文", "基础");
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
