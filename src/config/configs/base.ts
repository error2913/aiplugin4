// 基础配置：日志级别/超时/SealDice 路径/全局待机
import Config from "../config";

export default class BaseConfig {
    static ext: seal.ExtInfo;

    static register() {
        BaseConfig.ext = Config.getExt('基础');

        seal.ext.registerOptionConfig(BaseConfig.ext, "日志级别", "信息", ["从不", "错误", "警告", "信息", "调试"], "");
        seal.ext.registerBoolConfig(BaseConfig.ext, "日志简短打印", true, "");
        seal.ext.registerIntConfig(BaseConfig.ext, "请求超时时限", 180000, "单位：毫秒");
        seal.ext.registerStringConfig(BaseConfig.ext, "海豹核心全局路径", "/root/sealdice", '');
        seal.ext.registerBoolConfig(BaseConfig.ext, "是否开启全局待机", false, "开启后，全局的ai将进入待机状态，可能造成性能问题");
    }

    static get() {
        return {
            LOG_LEVEL: seal.ext.getOptionConfig(BaseConfig.ext, "日志级别") as "从不" | "错误" | "警告" | "信息" | "调试",
            LOG_SHORT_PRINT: seal.ext.getBoolConfig(BaseConfig.ext, "日志简短打印"),
            TIMEOUT: seal.ext.getIntConfig(BaseConfig.ext, "请求超时时限"),
            SEALDICE_PATH: seal.ext.getStringConfig(BaseConfig.ext, "海豹核心全局路径"),
            GLOBAL_STANDBY: seal.ext.getBoolConfig(BaseConfig.ext, "是否开启全局待机"),
        }
    }
}