// 技能配置：标准 SKILL.md，AI 通过 use_skill 按需调用
import { ext } from "../config";
import { SEALDICE_COMMAND_SKILLS } from "../static_config/sealdice_command_defaults";

export default class SkillsConfig {
    static register() {

        seal.ext.registerTemplateConfig(ext, "技能配置", [...SEALDICE_COMMAND_SKILLS], "每条配置项一个技能，仅支持标准 SKILL.md 格式：以 --- 开头的 YAML frontmatter 里写 name（必填）/description（可选）/platform（可选平台白名单数组，如 [QQ, DISCORD]，[] 或省略 = 所有平台），正文为技能内容。默认只含「录卡」技能（角色卡录入流程）；SealDice 核心/扩展指令与 OB11 API 的调用帮助已作为默认知识库提供（知识库页签的「核心指令」「扩展指令」「ob11-api」，需在知识库配置中查看/修改）。修改后可用 .ai skill refresh 生效（或重载 JS）。AI 可通过 use_skill 工具按需调用", "技能");
    }

    static get() {
        return {
            SKILLS: seal.ext.getTemplateConfig(ext, "技能配置"),
        };
    }
}
