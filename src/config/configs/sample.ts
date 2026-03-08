import { Config } from "../config";

export class SampleConfig {
    static ext: seal.ExtInfo;

    static register() {
        SampleConfig.ext = Config.getExt('aiplugin4:示例');

        seal.ext.registerBoolConfig(SampleConfig.ext, "是否启用", true, '');
    }

    static get() {
        return {
            enabled: seal.ext.getBoolConfig(SampleConfig.ext, "是否启用"),
        }
    }
}