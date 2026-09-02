// 角色设定配置：独立「角色设定」分组
import { ext } from "../config";

const ROLE_NAME_MAX_LENGTH = 20;

interface RoleParseResult {
    instructions: string[];
    names: string[];
    settings: string[];
}

let roleParseCache: RoleParseResult | null = null;

/** 角色扮演设定整体快照：原始条目 + 解析出的名称/设定，启动解析一次、重载 JS 后重新解析 */
function getRoleParse(): RoleParseResult {
    if (roleParseCache) return roleParseCache;
    const instructions = seal.ext.getTemplateConfig(ext, "角色扮演设定");
    roleParseCache = {
        instructions,
        names: parseRoleNames(instructions),
        settings: parseRoleSettings(instructions),
    };
    return roleParseCache;
}

export default class RoleConfig {
    static register() {
        seal.ext.registerTemplateConfig(ext, "角色扮演设定", [
            `测试机器人
你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。`
        ], '每行一个角色的扮演设定，第一行为角色设定名称（超过20字符自动截断），其余为设定内容；通过豹语变量 $gSYSPROMPT 选择，.ai role 可切换；修改后需重载 JS 生效', "角色设定")
    }

    static get() {
        const roleParse = getRoleParse();
        return {
            INSTRUCTIONS: roleParse.instructions,
            ROLE_NAMES: roleParse.names,
            ROLE_SETTINGS: roleParse.settings,
        }
    }
}

/**
 * 解析单个角色设定条目：第一行为角色设定名称（超过 20 字符自动截断），其余为设定内容。
 * 兼容旧格式：整条只有一行时，整条内容作为设定，首行截断作为名称。
 */
export function parseRoleEntry(entry: string): { name: string; setting: string } {
    const text = String(entry ?? '');
    const lines = text.split('\n');
    const name = (lines[0] || '').trim().slice(0, ROLE_NAME_MAX_LENGTH);
    const setting = lines.slice(1).join('\n').trim();
    return { name, setting: setting || text };
}

export function parseRoleNames(instructions: string[]): string[] {
    return (instructions || []).map(entry => parseRoleEntry(entry).name);
}

export function parseRoleSettings(instructions: string[]): string[] {
    return (instructions || []).map(entry => parseRoleEntry(entry).setting);
}
