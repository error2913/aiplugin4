// Skills：配置驱动的技能，AI 通过 use_skill 工具按需获取技能内容
import { ext } from "../config/config";
import Logger from "../logger";

import Tool from "./tool";

interface Skill {
    name: string;
    description: string;
    content: string;
}

const MAX_SKILL_CONTENT_LENGTH = 4000; // 单次返回的技能内容上限
const MAX_REF_DEPTH = 2; // 技能间引用的最大解析深度

function getSkills(): Skill[] {
    return seal.ext.getTemplateConfig(ext, "技能配置")
        .map(line => (line || '').trim())
        .filter(Boolean)
        .map(line => {
            // 支持 JSON 格式：{"name":"骰点","description":"...","content":"..."}
            if (line.startsWith('{')) {
                try {
                    const j = JSON.parse(line);
                    return {
                        name: String(j.name || '').trim(),
                        description: String(j.description || '').trim(),
                        content: String(j.content || '').trim()
                    };
                } catch (e) {
                    Logger.error(`技能配置 JSON 解析失败: ${e.message}，内容: ${line}`);
                    return { name: '', description: '', content: '' };
                }
            }
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

/** 返回技能摘要（名称 + 描述），用于注入 system prompt 的能力段 */
export function getSkillSummaries(): string[] {
    return getSkills().map(s => s.description ? `${s.name}：${s.description}` : s.name);
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
        return resolveSkillContent(skills, args?.name, 0);
    };
    Logger.info(`已注册技能工具 use_skill，可用技能: ${skills.map(s => s.name).join('、')}`);
}

/** 解析技能内容：支持 {{skill:名称}} 引用（限深度），并截断超长内容 */
function resolveSkillContent(skills: Skill[], name: string, depth: number): string {
    const skill = skills.find(s => s.name === name);
    if (!skill) return `技能 ${name} 不存在`;

    let content = skill.content;
    if (depth < MAX_REF_DEPTH) {
        content = content.replace(/\{\{\s*skill:([^}]+)\s*\}\}/g, (_, refName: string) => {
            return resolveSkillContent(skills, refName.trim(), depth + 1);
        });
    }

    if (content.length > MAX_SKILL_CONTENT_LENGTH) {
        content = content.slice(0, MAX_SKILL_CONTENT_LENGTH) + `\n…（技能内容过长，已截断，共 ${skill.content.length} 字符）`;
    }
    return content;
}
