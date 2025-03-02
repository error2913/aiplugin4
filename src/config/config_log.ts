import { ConfigManager } from "./config";

export class LogConfig {
    static register() {
        seal.ext.registerOptionConfig(ConfigManager.ext, "日志打印方式", "简短", ["永不", "简短", "详细"]);
    }

    static get() {
        return {
            logLevel: seal.ext.getOptionConfig(ConfigManager.ext, "日志打印方式")
        }
    }
}