import { Config } from "../config";

export default class BaseConfig {
    static ext: seal.ExtInfo;

    static register() {
        BaseConfig.ext = Config.getExt('aiplugin4');

        seal.ext.registerOptionConfig(BaseConfig.ext, "日志打印方式", "简短", ["永不", "简短", "详细", "调试"]);
        seal.ext.registerIntConfig(BaseConfig.ext, "请求超时时限/ms", 180000, '');
        seal.ext.registerStringConfig(BaseConfig.ext, "海豹核心全局路径", "/root/sealdice", '');
        seal.ext.registerBoolConfig(BaseConfig.ext, "是否开启全局待机", false, "开启后，全局的ai将进入待机状态，可能造成性能问题");
    }

    static get() {
        return {
            LOG_LEVEL: seal.ext.getOptionConfig(BaseConfig.ext, "日志打印方式") as "永不" | "简短" | "详细" | "调试",
            TIMEOUT: seal.ext.getIntConfig(BaseConfig.ext, "请求超时时限/ms"),
            SEALDICE_PATH: seal.ext.getStringConfig(BaseConfig.ext, "海豹核心全局路径"),
            GLOBAL_STANDBY: seal.ext.getBoolConfig(BaseConfig.ext, "是否开启全局待机"),
        }
    }
}