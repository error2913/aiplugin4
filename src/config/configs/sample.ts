// 示例配置：仅作开发参考，不注册进 configMap（configMap 见 ../config.ts）
import { ext } from "../config";
export default class SampleConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "是否启用", true, '开启后 .ai sample 显示示例智能体；示例仅作开发参考，不进入实际指令/工具/配置', "示例");
    }

    static get() {
        return {
            ENABLED: seal.ext.getBoolConfig(ext, "是否启用"),
        }
    }
}
