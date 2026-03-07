import { ConfigManager } from "./configManager";

export class SampleConfig {
    static ext: seal.ExtInfo;

    static register() {
        SampleConfig.ext = ConfigManager.getExt('aiplugin4_0:示例');

        seal.ext.registerBoolConfig(SampleConfig.ext, "是否启用", true, '');
    }

    static get() {
        return {
            enabled: seal.ext.getBoolConfig(SampleConfig.ext, "是否启用"),
        }
    }
}