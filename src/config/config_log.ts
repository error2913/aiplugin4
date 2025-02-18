import { ConfigManager } from "./config";

export class LogConfig {
    static register() {
        seal.ext.registerBoolConfig(ConfigManager.ext, "是否打印日志细节", true, "");
    }

    static get() {
        return {
            isLog: seal.ext.getBoolConfig(ConfigManager.ext, "是否打印日志细节")
        }
    }
}