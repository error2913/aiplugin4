import { Config } from "../config";

export class BaseConfig {
    static ext: seal.ExtInfo;

    static register() {
        BaseConfig.ext = Config.getExt('aiplugin4');

        seal.ext.registerOptionConfig(BaseConfig.ext, "日志打印方式", "简短", ["永不", "简短", "详细", "调试"]);
        seal.ext.registerIntConfig(BaseConfig.ext, "请求超时时限/ms", 180000, '');
    }

    static get() {
        return {
            logLevel: seal.ext.getOptionConfig(BaseConfig.ext, "日志打印方式") as "永不" | "简短" | "详细" | "调试",
            timeout: seal.ext.getIntConfig(BaseConfig.ext, "请求超时时限/ms")
        }
    }
}