// Skills：配置驱动的技能，AI 通过 use_skill 工具按需获取技能内容
import { ext } from "../config/config";
import Logger from "../logger";

import Tool from "./tool";

interface Skill {
    name: string;
    description: string;
    content: string;
}

// 内置技能：由代码提供，引导 AI 通过 run_command 统一调用对应海豹指令（指令需在白名单内）
const BUILTIN_SKILLS: Skill[] = [
    {
        name: '今日人品',
        description: '查询指定用户的今日人品值',
        content: `使用 run_command 工具执行：action=call，command="fun|jrrp"，args=["<用户名或QQ号>"]。\n注意：fun|jrrp 需在「可调用指令白名单」中，否则调用会被拒绝。`
    },
    {
        name: 'COC模组抽取',
        description: '随机抽取一个 COC 模组',
        content: `使用 run_command 工具执行：action=call，command="story|modu"，args=["roll"]。\n注意：story|modu 需在「可调用指令白名单」中，否则调用会被拒绝。`
    },
    {
        name: 'COC模组搜索',
        description: '按关键词搜索 COC 模组',
        content: `使用 run_command 工具执行：action=call，command="story|modu"，args=["search", "<关键词>"]。\n注意：story|modu 需在「可调用指令白名单」中，否则调用会被拒绝。`
    },
    {
        name: '属性展示',
        description: '展示指定玩家的 COC 全部个人属性',
        content: `使用 run_command 工具执行：action=call，command="coc7|st"，args=["show", "<玩家名称或QQ号>"]。\n注意：coc7|st 需在「可调用指令白名单」中，否则调用会被拒绝。`
    },
    {
        name: '属性检定',
        description: '对指定玩家进行一次属性/技能检定（ra）',
        content: `使用 run_command 工具执行：action=call，command="coc7|ra"，args 按顺序拼接：\n1. 奖励/惩罚骰（可选，如 b、b2、p3）；\n2. 检定表达式：含难度等级（困难/极难/大成功）或数值运算（如 力量2、敏捷*2）时直接使用；普通属性名时使用该属性（属性为 0 时补 50）；\n3. 检定原因（可选）。\n多次检定可设置 args 数量重复调用。\n注意：coc7|ra 需在「可调用指令白名单」中，否则调用会被拒绝。`
    },
    {
        name: 'san检定',
        description: '对指定玩家进行 san check（sc）',
        content: `使用 run_command 工具执行：action=call，command="coc7|sc"，args 按顺序拼接：\n1. 奖励/惩罚骰（可选，如 b、p2）；\n2. 表达式：成功时掉 san/失败时掉 san（如 0/1d6、0/1）。\n注意：coc7|sc 需在「可调用指令白名单」中，否则调用会被拒绝。`
    }
];

const MAX_SKILL_CONTENT_LENGTH = 4000; // 单次返回的技能内容上限
const MAX_REF_DEPTH = 2; // 技能间引用的最大解析深度

function getSkills(): Skill[] {
    const configSkills = seal.ext.getTemplateConfig(ext, "技能配置")
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
                    Logger.error(`技能配置 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}，内容: ${line}`);
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
    return [...BUILTIN_SKILLS, ...configSkills];
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
