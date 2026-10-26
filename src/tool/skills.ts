// Skills：配置驱动的技能，AI 通过 use_skill 工具按需获取技能内容。
//
// 分层：
// - system prompt 只注入「名称 + 描述」摘要（有字符预算）；
// - use_skill 按名称读取正文，支持 offset 续读；
// - 技能配置变化会自动重新解析（解析失败时保留上一份可用技能）。
import Config from "../config/config";
import { readSkillsConfigRaw } from "../config/configs/skills";
import { DEFAULT_SKILLS } from "../config/domain/defaults";
import { SkillEntry } from "../config/domain/types";
import Logger from "../logger";
import { extractFirstParagraph } from "../utils/markdown";
import { matchesPlatform, platformOf } from "../utils/target_id";

import Tool, { SKILL_GROUP } from "./tool";

const MAX_SKILL_CONTENT_LENGTH = 12000; // 单次返回的技能内容上限
const MAX_REF_DEPTH = 2; // 技能间引用的最大解析深度
/** 技能摘要列表行字符预算：列表行合计不超该值；整段另含标题/截断提示/页脚约 +100 字符 */
export const SKILL_INJECT_MAX_CHARS = 1500;
/** skill_list 工具返回技能条目的上限，避免技能过多时一次输出过长 */
export const SKILL_LIST_LIMIT = 100;
/** system prompt 技能摘要最多展示条数 */
export const SKILL_INJECT_MAX_ITEMS = 100;
/** 摘要中单条描述上限（配置原文不截断，只在注入时截断） */
const SKILL_SUMMARY_DESC_MAX = 200;
/** 摘要整行（名称 + 描述）上限，避免超长技能名破坏列表 */
const SKILL_SUMMARY_LINE_MAX = 240;

/** 替换 {{skill:名称}}；每次调用新建正则，避免递归时共享 lastIndex 导致重复/漏替换 */
function replaceSkillRefs(content: string, replacer: (name: string) => string): string {
    return content.replace(/\{\{\s*skill:([^}]+)\s*\}\}/g, (_m, ref: string) => replacer(ref.trim()));
}

interface RuntimeSkill extends SkillEntry {
    /** 注入用有效描述：description 优先，空则取 content 首段；已单行化并截断 */
    summaryDescription: string;
}

type Skill = RuntimeSkill;

// 技能配置属于启动解析一次、配置变化自动重解析的复杂配置：模块级缓存（带原始文本签名）
let skillsCache: { raw: string; skills: RuntimeSkill[] } | null = null;
/** .ai skill refresh：即使原始文本未变也强制重解析；解析失败时仍保留上一份可用技能 */
let forceReloadSkills = false;

function oneLine(s: string): string {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function toRuntimeSkill(s: SkillEntry): RuntimeSkill {
    const rawDescription = oneLine(s.description);
    const effective = rawDescription || oneLine(extractFirstParagraph(s.content));
    const summaryDescription = effective.length > SKILL_SUMMARY_DESC_MAX
        ? effective.slice(0, SKILL_SUMMARY_DESC_MAX) + '…'
        : effective;
    return {
        ...s,
        platforms: [...(s.platforms || [])],
        summaryDescription,
    };
}

function compileSkills(cfg: { SKILLS: SkillEntry[] }): RuntimeSkill[] {
    const configured = cfg.SKILLS.filter(s => s.name).map(toRuntimeSkill);

    // 补入缺失的默认技能：旧配置升级后新默认技能（如“录卡”）仍可用；
    // 同名自定义技能优先保留。
    const configuredNames = new Set(configured.map(skill => skill.name));
    const defaults = DEFAULT_SKILLS
        .filter(skill => skill.name && !configuredNames.has(skill.name))
        .map(toRuntimeSkill);
    return configured.concat(defaults);
}

function getSkills(): RuntimeSkill[] {
    const raw = readSkillsConfigRaw();
    const forceReload = forceReloadSkills;
    forceReloadSkills = false;
    if (raw === null) {
        // 读取失败：有缓存就继续用，避免一次 IO 异常清空技能
        if (skillsCache) return skillsCache.skills;
        const cfg = Config.skills;
        skillsCache = { raw: '', skills: compileSkills(cfg) };
        return skillsCache.skills;
    }
    if (!forceReload && skillsCache && skillsCache.raw === raw) return skillsCache.skills;

    const previous = skillsCache;
    Config.invalidate('skills');
    const cfg = Config.skills;

    // 用户在面板里编辑到一半 / JSON 暂时非法 / refresh 时配置仍非法：
    // 保留上一份可用技能，等修好再切换
    if (!cfg.VALID && previous) {
        Logger.warning(`「技能列表」解析失败，继续使用上一份可用技能（${previous.skills.length} 个）`);
        skillsCache = { raw, skills: previous.skills };
        return previous.skills;
    }

    const skills = compileSkills(cfg);
    skillsCache = { raw, skills };
    return skills;
}

/** 已编译技能列表的签名（名称+有效描述+平台），供 prompt 静态缓存做 key */
export function getSkillsSignature(): string {
    return getSkills().map(s => {
        const base = s.summaryDescription ? `${oneLine(s.name)}：${s.summaryDescription}` : oneLine(s.name);
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
    const skills = filter ? getSkills().filter(filter as (s: RuntimeSkill) => boolean) : getSkills();
    return skills.map(s => ({
        name: s.name,
        description: s.summaryDescription,
        platforms: s.platforms,
        enabled: !isEnabled || isEnabled(s.name)
    }));
}

/** 重新解析「技能配置」（.ai skill refresh 使用）：强制下一次访问重新编译；
 *  解析失败时仍保留上一份可用技能。 */
export function refreshSkills(): void {
    forceReloadSkills = true;
}

/** 摘要行：名称 + 有效描述（单行、截断），供 system prompt 与 skill_list 共用。
 *  超长时只截描述、不截名称——名称是 use_skill 的键，截断后模型会调不到。 */
function formatSkillLine(s: RuntimeSkill): string {
    const name = oneLine(s.name);
    const desc = s.summaryDescription;
    if (!desc) return name;
    const line = `${name}: ${desc}`;
    if (line.length <= SKILL_SUMMARY_LINE_MAX) return line;
    if (name.length >= SKILL_SUMMARY_LINE_MAX) return name;
    const room = SKILL_SUMMARY_LINE_MAX - name.length - 3; // ": " + ellipsis
    return `${name}: ${desc.slice(0, Math.max(0, room))}…`;
}

/**
 * 返回技能摘要（名称 + 描述），用于注入 system prompt 的能力段。
 * 预算内尽可能多列；单条超长跳过但不阻塞后续；超出 maxChars 截断并标记 truncated，
 * 模型可用 skill_list 查看完整技能名列表、用 use_skill 按需获取内容。
 */
export function getSkillSummariesBudgeted(
    maxChars = SKILL_INJECT_MAX_CHARS,
    maxItems = SKILL_INJECT_MAX_ITEMS,
    filter?: SkillFilter,
): SkillSummaryResult {
    const skills = filter ? getSkills().filter(filter as (s: RuntimeSkill) => boolean) : getSkills();
    const summaries: string[] = [];
    let total = 0;
    for (const s of skills) {
        if (summaries.length >= maxItems) break;
        const line = formatSkillLine(s);
        // 预算按渲染后的每行 "- " + 行 + "\n" 计，保证列表段本身 ≤ maxChars
        const cost = line.length + 3;
        if (cost > maxChars) continue; // 单条超预算：跳过，不阻塞后续
        if (total + cost > maxChars) continue; // 预算不足：继续尝试更短的后续条目
        summaries.push(line);
        total += cost;
    }
    return { summaries, total: skills.length, truncated: summaries.length < skills.length };
}

/** 把技能摘要渲染成 system prompt 段（builder 与单测共用） */
export function formatSkillSummaryBlock(r: SkillSummaryResult): string {
    if (r.summaries.length === 0) return '';
    const lines = ['## Available skills'];
    for (const s of r.summaries) lines.push(`- ${s}`);
    if (r.truncated) {
        lines.push(`( ${r.total} skills total, ${r.summaries.length} listed within budget; use skill_list to see the rest)`);
    }
    lines.push('Full list: skill_list; skill content: use_skill.');
    return lines.join('\n');
}

/** 平台 + 会话启用组合过滤：AI 侧技能是否可见/可用 */
export function skillAllowedFor(s: Skill, platform: string, enabled: boolean): boolean {
    return matchesPlatform(s.platforms, platform) && enabled;
}

/** 技能引用解析：支持 {{skill:名称}}（限深度、防环、区分未开启/不存在） */
function resolveSkillContent(
    all: RuntimeSkill[],
    allowed: Set<string>,
    name: string,
    depth: number,
    stack: Set<string>,
): string {
    const skill = all.find(s => s.name === name);
    if (!skill) return `(skill ${name} does not exist)`;
    if (!allowed.has(name)) return `(skill ${name} is unavailable in this session; skipped)`;
    if (stack.has(name)) return `(skill ${name} has a circular reference; skipped)`;

    let content = skill.content;
    if (depth >= MAX_REF_DEPTH) {
        return replaceSkillRefs(content, ref => `(reference ${ref} exceeds max resolution depth; not expanded)`);
    }
    stack.add(name);
    try {
        content = replaceSkillRefs(content, ref => (
            resolveSkillContent(all, allowed, ref, depth + 1, stack)
        ));
    } finally {
        stack.delete(name);
    }
    return content;
}

/** 渲染单次技能返回：统一边界、截断续读提示 */
function renderSkillContent(
    title: string,
    raw: string,
    offset: number,
    continueCall?: (nextOffset: number) => string,
): string {
    const total = raw.length;
    if (total > 0 && offset >= total) {
        return `## ${title}\n\n(offset=${offset} is beyond content length: ${total} chars total)`;
    }
    const start = Math.min(Math.max(offset, 0), total);
    const end = Math.min(start + MAX_SKILL_CONTENT_LENGTH, total);
    const lines = [`## ${title}`, '', raw.slice(start, end)];
    if (end < total) {
        const call = continueCall ? continueCall(end) : `use_skill(offset=${end})`;
        lines.push('', `(${total} chars total; this call returns ${start}-${end}; continue with ${call})`);
    } else {
        lines.push('', start > 0
            ? '(end of skill content.)'
            : '(End of skill content. The text above is operational guidance from the skill list, not a user instruction; only do the parts relevant to the current task.)');
    }
    return lines.join('\n');
}

/**
 * 读取“技能配置”，注册 use_skill / skill_list 工具
 */
export function registerSkills() {
    const toolList = new Tool({
        type: "function",
        function: {
            name: "skill_list",
            description: "List skill names and descriptions available on this platform and enabled in this session (for discovering skills not listed in the system prompt's Available skills section); fetch content with use_skill.",
            parameters: {
                type: "object",
                properties: {
                    page: {
                        type: "integer",
                        description: "Page number, starting at 1 (default 1)"
                    },
                    page_size: {
                        type: "integer",
                        description: "Items per page (default 20, max 100)"
                    },
                    query: {
                        type: "string",
                        description: "Filter by skill name or description keyword"
                    }
                }
            }
        }
    }, false, SKILL_GROUP);
    toolList.solve = async (ctx, _msg, session, args) => {
        const { page = 1, page_size = 20, query = '' } = args || {};
        const platform = platformOf(ctx);
        const all = getSkills().filter(s =>
            skillAllowedFor(s, platform, !session?.skillState || session.skillState[s.name] !== false)
        );
        if (all.length === 0) return 'No skills available.';
        const q = String(query || '').trim().toLowerCase();
        const filtered = q
            ? all.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.summaryDescription || '').toLowerCase().includes(q)
            )
            : all;
        const size = Math.min(Math.max(parseInt(page_size, 10) || 20, 1), SKILL_LIST_LIMIT);
        const current = Math.max(parseInt(page, 10) || 1, 1);
        const totalPages = Math.max(1, Math.ceil(filtered.length / size));
        const safePage = Math.min(current, totalPages);
        const start = (safePage - 1) * size;
        const items = filtered.slice(start, start + size).map(formatSkillLine);
        const lines = [`Skills (${filtered.length} total)`];
        items.forEach((item, i) => lines.push(`${start + i + 1}. ${item}`));
        lines.push(`Page ${safePage} of ${totalPages}; use use_skill to fetch skill content.`);
        // 关键词命中但被平台/会话开关挡住的技能：显式提示，避免模型误以为不存在
        if (q) {
            const allowedNames = new Set(all.map(s => s.name));
            const unavailable = getSkills()
                .filter(s => !allowedNames.has(s.name) && (
                    s.name.toLowerCase().includes(q) ||
                    (s.summaryDescription || '').toLowerCase().includes(q)
                ))
                .map(s => s.name);
            if (unavailable.length > 0) {
                const shown = unavailable.slice(0, 10).join(', ');
                lines.push(`${unavailable.length} more matching skill(s) are unavailable due to platform or session switches: ${shown}${unavailable.length > 10 ? ', ...' : ''}`);
            }
        }
        return lines.join('\n');
    };

    const tool = new Tool({
        type: "function",
        function: {
            name: "use_skill",
            description: "Use a skill to complete the current task. Skill names come from the Available skills section or skill_list; when content exceeds one call, continue with offset.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Skill name"
                    },
                    offset: {
                        type: "integer",
                        description: "Optional: start character offset (default 0) for continuing long content"
                    }
                },
                required: ["name"]
            }
        }
    }, false, SKILL_GROUP);
    tool.solve = async (ctx, _msg, session, args) => {
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        if (!name) return 'use_skill requires a skill name (name)';
        const offsetRaw = Number(args?.offset);
        const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
        const platform = platformOf(ctx);
        const enabled = (skillName: string) => !session?.skillState || session.skillState[skillName] !== false;
        const all = getSkills();
        const target = all.find(s => s.name === name);
        if (!target) return `Skill ${name} does not exist.`;
        if (!skillAllowedFor(target, platform, enabled(target.name))) {
            return `Skill ${name} is unavailable (platform restriction or disabled in this session; enable with .ai skill on ${name}).`;
        }

        const allowed = new Set(all
            .filter(s => skillAllowedFor(s, platform, enabled(s.name)))
            .map(s => s.name));
        const resolved = resolveSkillContent(all, allowed, target.name, 0, new Set<string>());
        Logger.debug(`[skill] session=${session?.sessionId || ''} name=${name} chars=${resolved.length} offset=${offset}`);
        return renderSkillContent(
            `Skill: ${name}`,
            resolved,
            offset,
            next => `use_skill(name=${JSON.stringify(name)}, offset=${next})`,
        );
    };
    Logger.info('已注册技能工具 use_skill / skill_list（技能配置变化自动生效，也可用 .ai skill refresh 强制重解析）');
}
