// Skills：配置驱动的技能，AI 通过 use_skill 工具按需获取技能内容
import { ext } from "../config/config";
import { OB11_API_SKILLS } from "../config/static_config/ob11_api_skills";
import { SEALDICE_COMMAND_SKILLS } from "../config/static_config/sealdice_command_defaults";
import Logger from "../logger";
import { splitFrontmatter } from "../utils/frontmatter";
import { matchesPlatform, platformOf } from "../utils/target_id";

import Tool from "./tool";

interface Skill {
    name: string;
    description: string;
    content: string;
    /** frontmatter platform 白名单：缺省 = 所有平台 */
    platforms?: string[];
}

const MAX_SKILL_CONTENT_LENGTH = 12000; // 单次返回的技能内容上限
const MAX_REF_DEPTH = 2; // 技能间引用的最大解析深度
/** 技能摘要注入字符预算：system prompt「可用技能」段不超该值，超出提示用 skill_list 查看完整列表 */
export const SKILL_INJECT_MAX_CHARS = 1500;
/** skill_list 工具返回技能条目的上限，避免技能过多时一次输出过长 */
export const SKILL_LIST_LIMIT = 100;
/** system prompt 技能摘要最多展示条数 */
export const SKILL_INJECT_MAX_ITEMS = 100;

/** 解析单条技能配置：仅支持标准 SKILL.md（--- frontmatter + 正文） */
function parseSkillEntry(line: string): { name: string, description: string, content: string, platforms?: string[] } {
    // 标准 SKILL.md：--- frontmatter（name/description/platform）--- 正文，可直接粘贴其他 agent 的技能文件
    const fm = splitFrontmatter(line);
    if (fm) {
        if (fm.meta.name) {
            return {
                name: fm.meta.name.trim(),
                description: (fm.meta.description || '').trim(),
                content: fm.body,
                platforms: fm.meta.platforms
            };
        }
        Logger.error(`技能配置缺少 name 字段，已跳过: ${line.split('\n')[0]}`);
        return { name: '', description: '', content: '' };
    }
    Logger.error(`技能配置不是标准 SKILL.md 格式，已跳过: ${line.split('\n')[0]}`);
    return { name: '', description: '', content: '' };
}

// 技能配置属于启动解析一次、重载 JS 才生效的复杂配置（SKILL.md frontmatter 解析）：模块级缓存
let skillsCache: Skill[] | null = null;
function getSkills(): Skill[] {
    if (skillsCache) return skillsCache;
    skillsCache = compileSkills();
    return skillsCache;
}
function compileSkills(): Skill[] {
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

/** 已编译技能列表的签名（名称+描述+平台），供 prompt 静态缓存做 key；重载/refresh 后随重新解析自然变化 */
export function getSkillsSignature(): string {
    return getSkills().map(s => {
        const base = s.description ? `${s.name}：${s.description}` : s.name;
        return `${base}[${s.platforms && s.platforms.length > 0 ? s.platforms.join(',') : '*'}]`;
    }).join('\n');
}

/** 返回已配置的技能名称列表（可选按平台过滤） */
export function getSkillNames(platform?: string): string[] {
    const skills = platform ? getSkills().filter(s => matchesPlatform(s.platforms, platform)) : getSkills();
    return skills.map(s => s.name);
}

export interface SkillSummaryResult {
    summaries: string[];
    total: number;
    truncated: boolean;
}

/** 技能过滤谓词（平台 + 会话启用统一在调用侧组合） */
export type SkillFilter = (s: { name: string; description: string; platforms?: string[] }) => boolean;

/** 技能列表视图：供 .ai skill list 与内部展示（未提供 isEnabled 视为全开） */
export interface SkillView {
    name: string;
    description: string;
    platforms?: string[];
    enabled: boolean;
}

/** 返回过滤后的技能视图（含会话启用状态） */
export function getSkillViews(filter?: SkillFilter, isEnabled?: (name: string) => boolean): SkillView[] {
    const skills = filter ? getSkills().filter(filter as (s: Skill) => boolean) : getSkills();
    return skills.map(s => ({
        name: s.name,
        description: s.description,
        platforms: s.platforms,
        enabled: !isEnabled || isEnabled(s.name)
    }));
}

/** 重新解析「技能配置」（.ai skill refresh 使用）：清空编译缓存，下次访问重新编译 */
export function refreshSkills(): void {
    skillsCache = null;
}

/**
 * 返回技能摘要（名称 + 描述），用于注入 system prompt 的能力段。
 * 预算内尽可能多列，超出 SKILL_INJECT_MAX_CHARS 截断并标记 truncated，
 * 模型可用 skill_list 查看完整技能名列表、用 use_skill 按需获取内容。
 */
export function getSkillSummariesBudgeted(maxChars = SKILL_INJECT_MAX_CHARS, filter?: SkillFilter): SkillSummaryResult {
    const skills = filter ? getSkills().filter(filter as (s: Skill) => boolean) : getSkills();
    const summaries: string[] = [];
    let total = 0;
    for (const s of skills) {
        const line = s.description ? `${s.name}：${s.description}` : s.name;
        if (total + line.length + 2 > maxChars) break;
        summaries.push(line);
        total += line.length + 2;
    }
    return { summaries, total: skills.length, truncated: summaries.length < skills.length };
}

/** 返回技能摘要（名称 + 描述），按条数上限截断，用于 system prompt 静态技能块 */
export function getSkillSummaries(maxItems = SKILL_INJECT_MAX_ITEMS, filter?: SkillFilter): SkillSummaryResult {
    const skills = filter ? getSkills().filter(filter as (s: Skill) => boolean) : getSkills();
    const summaries = skills.slice(0, maxItems).map(s => s.description ? `${s.name}：${s.description}` : s.name);
    return { summaries, total: skills.length, truncated: skills.length > maxItems };
}

/** 平台 + 会话启用组合过滤：AI 侧技能是否可见/可用 */
export function skillAllowedFor(s: Skill, platform: string, enabled: boolean): boolean {
    return matchesPlatform(s.platforms, platform) && enabled;
}

/**
 * 读取“技能配置”，注册 use_skill / skill_list 工具
 */
export function registerSkills() {
    const toolList = new Tool({
        type: "function",
        function: {
            name: "skill_list",
            description: "列出当前平台可用且本会话已开启的技能名称与描述（用于发现 system prompt「可用技能」段未列出的技能），随后可用 use_skill 按名称获取技能内容",
            parameters: {
                type: "object",
                properties: {
                    page: {
                        type: "integer",
                        description: "页码，从 1 开始，默认 1"
                    },
                    page_size: {
                        type: "integer",
                        description: "每页数量，默认 20，最大 100"
                    },
                    query: {
                        type: "string",
                        description: "按技能名称或描述关键词过滤"
                    }
                }
            }
        }
    }, false, '技能');
    toolList.solve = async (ctx, _msg, session, args) => {
        const { page = 1, page_size = 20, query = '' } = args || {};
        const platform = platformOf(ctx);
        const all = getSkills().filter(s =>
            skillAllowedFor(s, platform, !session?.skillState || session.skillState[s.name] !== false)
        );
        if (all.length === 0) return '暂无技能';
        const q = String(query || '').trim().toLowerCase();
        const filtered = q
            ? all.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.description || '').toLowerCase().includes(q)
            )
            : all;
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), SKILL_LIST_LIMIT);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(filtered.length / size));
        const start = (current - 1) * size;
        const items = filtered.slice(start, start + size).map(s => s.description ? `${s.name}：${s.description}` : s.name);
        const lines = [`技能列表（共 ${filtered.length} 个）`];
        items.forEach((item, i) => lines.push(`${start + i + 1}. ${item}`));
        lines.push(`当前第 ${current} 页，共 ${totalPages} 页；使用 use_skill 获取技能正文。`);
        return lines.join('\n');
    };

    const tool = new Tool({
        type: "function",
        function: {
            name: "use_skill",
            description: "使用指定技能完成当前任务，技能名称以 system prompt 中「可用技能」列表或 skill_list 返回的列表为准",
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
    }, false, '技能');
    tool.solve = async (ctx, _msg, session, args) => {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (!name) return 'use_skill 缺少技能名称 name';
        const platform = platformOf(ctx);
        const enabled = !session?.skillState || session.skillState[name] !== false;
        const all = getSkills();
        const target = all.find(s => s.name === name);
        if (!target) return `技能 ${name} 不存在`;
        if (!skillAllowedFor(target, platform, enabled)) {
            return `技能 ${name} 当前不可用（平台限制或已在本会话关闭，可用 .ai skill on ${name} 开启）`;
        }
        const allowed = all.filter(s =>
            skillAllowedFor(s, platform, !session?.skillState || session.skillState[s.name] !== false)
        );
        return resolveSkillContent(allowed, target.name, 0);
    };
    Logger.info('已注册技能工具 use_skill / skill_list（技能内容按启动解析结果加载，修改技能配置可用 .ai skill refresh 生效）');
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
