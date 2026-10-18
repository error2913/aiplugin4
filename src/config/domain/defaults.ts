// 四个分区的出厂默认值：静态对象（default_data.ts）+ 注册用的 JSON 字符串。
//
// 默认数据由 scripts/gen-domain-default-data.mjs 从旧版静态默认值生成；
// 生成器侧 aiplugin4-config 的 tools/sync-default-data.mjs 从同一批旧默认值生成，
// 两边单测/联测保证解析后的内容一致。
import {
    DEFAULT_KB, DEFAULT_MCP, DEFAULT_ROLES, DEFAULT_SKILLS,
} from './default_data';
import { DOMAIN_VERSION, KbEntry, McpServerEntry, RoleEntry, SkillEntry } from './types';

/** 角色配置 JSON */
export function rolesConfigJson(roles: RoleEntry[] = DEFAULT_ROLES): string {
    return JSON.stringify({
        version: DOMAIN_VERSION,
        roles: roles.map(r => ({ name: r.name, prompt: r.prompt })),
    });
}

/** 技能配置 JSON */
export function skillsConfigJson(skills: SkillEntry[] = DEFAULT_SKILLS): string {
    return JSON.stringify({
        version: DOMAIN_VERSION,
        skills: skills.map(s => {
            const out: Record<string, unknown> = { name: s.name };
            if (s.description) out.description = s.description;
            if (s.platforms.length > 0) out.platform = s.platforms;
            out.content = s.content;
            return out;
        }),
    });
}

/** 知识库配置 JSON */
export function kbConfigJson(libraries: KbEntry[] = DEFAULT_KB): string {
    return JSON.stringify({
        version: DOMAIN_VERSION,
        libraries: libraries.map(l => {
            const out: Record<string, unknown> = { name: l.name };
            if (l.description) out.description = l.description;
            if (l.platforms.length > 0) out.platform = l.platforms;
            out.content = l.content;
            return out;
        }),
    });
}

/** MCP 标准 JSON：{ mcpServers: { name: { type, url, headers, platform } } } */
export function mcpConfigJson(servers: McpServerEntry[] = DEFAULT_MCP): string {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) {
        const entry: Record<string, unknown> = { type: server.type || 'http', url: server.url };
        if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers;
        if (server.platforms.length > 0) entry.platform = server.platforms;
        mcpServers[server.name] = entry;
    }
    return JSON.stringify({ mcpServers });
}

export const DEFAULT_ROLES_JSON = rolesConfigJson();
export const DEFAULT_SKILLS_JSON = skillsConfigJson();
export const DEFAULT_MCP_JSON = mcpConfigJson();
export const DEFAULT_KB_JSON = kbConfigJson();

export { DEFAULT_KB, DEFAULT_MCP, DEFAULT_ROLES, DEFAULT_SKILLS };
