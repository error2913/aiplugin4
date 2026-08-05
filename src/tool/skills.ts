// Skills：配置驱动的技能，AI 通过 use_skill 工具按需获取技能内容
import { ext } from "../config/config";
import Logger from "../logger";

import Tool from "./tool";

interface Skill {
    name: string;
    description: string;
    content: string;
}

function getSkills(): Skill[] {
    return seal.ext.getTemplateConfig(ext, "技能配置")
        .map(line => (line || '').trim())
        .filter(Boolean)
        .map(line => {
            const [name, description = '', ...rest] = line.split('|');
            return {
                name: name.trim(),
                description: description.trim(),
                content: rest.join('|').trim()
            };
        })
        .filter(s => s.name);
}

/** 返回已配置的技能名称列表 */
export function getSkillNames(): string[] {
    return getSkills().map(s => s.name);
}

/**
 * 读取“技能配置”，注册 use_skill 工具
 */
export function registerSkills() {
    const skills = getSkills();
    if (skills.length === 0) return;

    const tool = new Tool({
        type: "function",
        function: {
            name: "use_skill",
            description: `使用指定技能完成当前任务。可用技能: ${skills.map(s => s.name).join('、')}`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "技能名称，取可用技能中的一项",
                        enum: skills.map(s => s.name)
                    }
                },
                required: ["name"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const skill = skills.find(s => s.name === args?.name);
        return skill ? skill.content : `技能 ${args?.name} 不存在`;
    };
    Logger.info(`已注册技能工具 use_skill，可用技能: ${skills.map(s => s.name).join('、')}`);
}
