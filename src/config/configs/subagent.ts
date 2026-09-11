// 子代理配置（分组「子代理」，紧随「技能」）。极简三旋钮：总开关 / 委派深度 / 禁调工具。
import { ext } from "../config";

export default class SubAgentConfig {
    static register() {
        seal.ext.registerBoolConfig(ext, "是否启用子代理", true, "总开关；关闭后 AI 调用 subagent 工具会直接提示已关闭", "子代理");
        seal.ext.registerIntConfig(ext, "最大委派深度", 3, "子代理最多嵌套几层（0=禁止委派）；主会话为 0 层，每层 +1", "子代理");
        seal.ext.registerTemplateConfig(ext, "子代理禁止调用工具", [''], "每框一个子代理不可调用的工具名（如 call_ob11_api）；留空=继承主会话全部已开启工具", "子代理");
    }

    static get() {
        return {
            ENABLE: seal.ext.getBoolConfig(ext, "是否启用子代理"),
            MAX_DEPTH: seal.ext.getIntConfig(ext, "最大委派深度"),
            DENY_TOOLS: seal.ext.getTemplateConfig(ext, "子代理禁止调用工具"),
        };
    }
}
