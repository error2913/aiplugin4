// Skills：配置驱动的技能，AI 通过 use_skill 工具按需获取技能内容
import { ext } from "../config/config";
import { OB11_API_SKILLS } from "../config/static_config/ob11_api_skills";
import { SEALDICE_COMMAND_SKILLS } from "../config/static_config/sealdice_command_defaults";
import Logger from "../logger";

import Tool from "./tool";

interface Skill {
    name: string;
    description: string;
    content: string;
}

const MAX_SKILL_CONTENT_LENGTH = 12000; // 单次返回的技能内容上限
const MAX_REF_DEPTH = 2; // 技能间引用的最大解析深度

/** 解析标准 SKILL.md frontmatter（--- 开头，name/description 键值对），兼容 Claude/Codex/Cursor 等 agent 的技能文件 */
function parseSkillFrontmatter(raw: string): { name?: string, description?: string } {
    const meta: { name?: string, description?: string } = {};
    for (const line of raw.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim().replace(/^['"]|['"]$/g, '');
        if (!value) continue;
        if (key === 'name') meta.name = value;
        else if (key === 'description') meta.description = value;
    }
    return meta;
}

/** 解析单条技能配置：仅支持标准 SKILL.md（--- frontmatter + 正文） */
function parseSkillEntry(line: string): { name: string, description: string, content: string } {
    // 标准 SKILL.md：--- frontmatter（name/description）--- 正文，可直接粘贴其他 agent 的技能文件
    const fmMatch = line.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (fmMatch) {
        const meta = parseSkillFrontmatter(fmMatch[1]);
        if (meta.name) {
            return {
                name: meta.name.trim(),
                description: (meta.description || '').trim(),
                content: fmMatch[2].trim()
            };
        }
        Logger.error(`技能配置缺少 name 字段，已跳过: ${line.split('\n')[0]}`);
        return { name: '', description: '', content: '' };
    }
    Logger.error(`技能配置不是标准 SKILL.md 格式，已跳过: ${line.split('\n')[0]}`);
    return { name: '', description: '', content: '' };
}

function getSkills(): Skill[] {
    const configured = seal.ext.getTemplateConfig(ext, "技能配置")
        .map(line => (line || '').replace(/\r\n/g, '\n').trim())
        .filter(Boolean)
        .map(parseSkillEntry)
        .filter(s => s.name);

    // registerTemplateConfig 不会覆盖已有安装的配置。为避免升级后新默认技能（如“录卡”）
    // 因旧配置持久化而不可用，补入缺失的默认技能；同名自定义技能优先保留。
    const configuredNames = new Set(configured.map(skill => skill.name));
    const defaults = [...SEALDICE_COMMAND_SKILLS, ...OB11_API_SKILLS]
        .map(line => parseSkillEntry(line.trim()))
        .filter(skill => skill.name && !configuredNames.has(skill.name));
    return configured.concat(defaults);
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
    const tool = new Tool({
        type: "function",
        function: {
            name: "use_skill",
            description: "使用指定技能完成当前任务，技能名称以 system prompt 中「可用技能」列表为准",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "技能名称"
                    }
                },
                required: ["name"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        const skills = getSkills();
        return resolveSkillContent(skills, args?.name, 0);
    };
    Logger.info('已注册技能工具 use_skill（技能内容按配置动态加载）');
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
