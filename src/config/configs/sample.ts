// 示例开关配置
import { ext } from "../config";
export default class SampleConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "是否启用", true, '', "示例");
    }

    static get() {
        return {
            ENABLED: seal.ext.getBoolConfig(ext, "是否启用"),
        }
    }
}