// 技能配置：标准 SKILL.md，AI 通过 use_skill 按需调用
import { ext } from "../config";
import { OB11_API_SKILLS } from "../static_config/ob11_api_skills";
import { SEALDICE_COMMAND_SKILLS } from "../static_config/sealdice_command_defaults";

export default class SkillsConfig {
    static register() {

        seal.ext.registerTemplateConfig(ext, "技能配置", [...SEALDICE_COMMAND_SKILLS, ...OB11_API_SKILLS], "每条配置项一个技能，仅支持标准 SKILL.md 格式：以 --- 开头的 YAML frontmatter 里写 name（必填）/description（可选），正文为技能内容；默认包含当前 SealDice 核心命令、内置扩展命令及别名的调用帮助，统一说明 run_ext_command / run_core_command 的参数传递方式。修改后需重载 JS 生效。AI 可通过 use_skill 工具按需调用", "技能");
    }

    static get() {
        return {
            SKILLS: seal.ext.getTemplateConfig(ext, "技能配置"),
        };
    }
}
