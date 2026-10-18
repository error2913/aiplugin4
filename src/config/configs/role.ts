// 角色设定配置：独立「角色设定」分组；整份 JSON（v1）。
//
// 新键名 `角色设定` 与旧模板键 `角色扮演设定` 不同；旧键不再注册/读取（不做迁移）。
import Logger from "../../logger";
import { ext } from "../config";
import { DEFAULT_ROLES, DEFAULT_ROLES_JSON } from "../domain/defaults";
import { parseRolesConfig } from "../domain/parse";
import { RoleEntry } from "../domain/types";

const ROLE_NAME_MAX_LENGTH = 20;
export const ROLE_CONFIG_KEY = '角色设定';

interface RoleParseResult {
    entries: RoleEntry[];
    instructions: string[];
    names: string[];
    settings: string[];
}

let roleParseCache: RoleParseResult | null = null;

function fallbackRoles(): RoleEntry[] {
    return DEFAULT_ROLES.map(r => ({ ...r }));
}

function readRoles(): RoleEntry[] {
    let text = '';
    try {
        text = seal.ext.getStringConfig(ext, ROLE_CONFIG_KEY) ?? '';
    } catch (e) {
        Logger.error(`读取配置项「${ROLE_CONFIG_KEY}」失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!text.trim()) {
        Logger.warning(`「${ROLE_CONFIG_KEY}」为空，已载入出厂角色。`);
        return fallbackRoles();
    }
    const result = parseRolesConfig(text);
    for (const issue of result.issues) Logger.error(`  ${issue.path} ${issue.msg}`);
    for (const warning of result.warnings) Logger.warning(`  ${warning.path} ${warning.msg}`);
    if (!result.config) {
        Logger.error(`「${ROLE_CONFIG_KEY}」校验失败（共 ${result.issues.length} 处），本次回退到出厂角色。`);
        Logger.error('提示：可用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/');
        return fallbackRoles();
    }
    return result.config.roles;
}

function getRoleParse(): RoleParseResult {
    if (roleParseCache) return roleParseCache;
    const entries = readRoles();
    roleParseCache = {
        entries,
        instructions: entries.map(item => `${item.name}\n${item.prompt}`),
        names: entries.map(item => item.name.slice(0, ROLE_NAME_MAX_LENGTH)),
        settings: entries.map(item => item.prompt),
    };
    return roleParseCache;
}

export default class RoleConfig {
    static register() {
        seal.ext.registerStringConfig(
            ext,
            ROLE_CONFIG_KEY,
            DEFAULT_ROLES_JSON,
            '整份角色设定配置（JSON v1）：{"version":1,"roles":[{"name":"角色名","prompt":"设定内容"}]}。'
            + 'name 超过 20 字符会自动截断；.ai role 可切换角色。'
            + '推荐用配置生成器生成后粘贴：https://error2913.github.io/aiplugin4-config/（「角色设定」页）。'
            + '修改后需重载 JS 生效。',
            '角色设定',
        );
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

