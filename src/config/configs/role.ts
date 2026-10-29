// 角色设定配置：独立「角色设定」分组；整份 JSON（v1）。
//
// 新键名 `角色设定` 与旧模板键 `角色扮演设定` 不同；旧键不再注册/读取（不做迁移）。
import Logger from "../../logger";
import { DEFAULT_ROLES, DEFAULT_ROLES_JSON } from "../domain/defaults";
import { parseRolesConfig } from "../domain/parse";
import { RoleEntry } from "../domain/types";
import { ext } from "../ext";

import { GENERATOR_CONFIG_HINT } from "./generator_hint";

const ROLE_NAME_MAX_LENGTH = 20;
/** 公共提示词超长告警阈值（只告警不截断：system 不参与 token 裁剪） */
const GLOBAL_PROMPT_WARN_LENGTH = 8000;
export const ROLE_CONFIG_KEY = '角色设定';
export const GLOBAL_PROMPT_CONFIG_KEY = '全局提示词';

interface RoleParseResult {
    entries: RoleEntry[];
    instructions: string[];
    names: string[];
    settings: string[];
}

let roleParseCache: RoleParseResult | null = null;
/** 超长告警每个进程只打一次，避免每 60 秒重复刷屏 */
let globalPromptWarned = false;

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

/** 全局提示词：独立于角色，读原始配置（随 Config 60s 缓存，无需重载 JS） */
function readGlobalPrompt(): string {
    try {
        const text = seal.ext.getStringConfig(ext, GLOBAL_PROMPT_CONFIG_KEY) ?? '';
        if (text.length > GLOBAL_PROMPT_WARN_LENGTH && !globalPromptWarned) {
            globalPromptWarned = true;
            Logger.warning(`「${GLOBAL_PROMPT_CONFIG_KEY}」长度 ${text.length}，会占用较多 system prompt 预算。`);
        }
        return text;
    } catch (e) {
        Logger.error(`读取配置项「${GLOBAL_PROMPT_CONFIG_KEY}」失败: ${e instanceof Error ? e.message : String(e)}`);
        return '';
    }
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
            GENERATOR_CONFIG_HINT,
            '角色设定',
        );
        // 公共提示词：所有角色共用，切换角色时不变；留空 = 不注入
        seal.ext.registerStringConfig(
            ext,
            GLOBAL_PROMPT_CONFIG_KEY,
            '',
            '对所有角色生效的公共提示词（system prompt 段 core:global）；切换角色时不变，留空则不注入；内容保持原语言；修改后约 1 分钟内自动生效，可用 .ai prompt sections 确认',
            '角色设定',
        );
    }

    static get() {
        const roleParse = getRoleParse();
        return {
            INSTRUCTIONS: roleParse.instructions,
            ROLE_NAMES: roleParse.names,
            ROLE_SETTINGS: roleParse.settings,
            GLOBAL_PROMPT: readGlobalPrompt(),
        }
    }
}

