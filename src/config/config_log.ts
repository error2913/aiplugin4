import { ConfigManager } from "./config";

export class LogConfig {
    static ext: seal.ExtInfo;

    static register() {
        LogConfig.ext = ConfigManager.getExt('aiplugin4');

        seal.ext.registerOptionConfig(LogConfig.ext, "日志打印方式", "简短", ["永不", "简短", "详细"]);
    }

    static get() {
        return {
            logLevel: seal.ext.getOptionConfig(LogConfig.ext, "日志打印方式")
        }
    }
}