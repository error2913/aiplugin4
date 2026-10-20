// 角色 / 技能 / MCP / 知识库配置（JSON v1）的类型与常量。
//
// 纯类型模块，不依赖 seal / Config，便于单元测试。
// 运行时配置只读 JSON；旧的多框模板/frontmatter 不再解析。
//
// 注意：MCP 使用标准 mcpServers 结构，**没有 version 字段**；其余三份配置顶层带 version: 1。

export const DOMAIN_VERSION = 1;

export interface DomainIssue {
    /** 路径，形如 $.skills[0].name */
    path: string;
    msg: string;
}

export interface DomainParseResult<T> {
    config: T | null;
    issues: DomainIssue[];
    warnings: DomainIssue[];
}

/** 角色配置条目（JSON 字段：name / prompt） */
export interface RoleEntry {
    name: string;
    prompt: string;
}

export interface RolesConfig {
    version: number;
    roles: RoleEntry[];
}

/** 技能配置条目（JSON 字段：name / description / platform / content） */
export interface SkillEntry {
    name: string;
    description: string;
    /** 平台白名单；空数组 = 所有平台 */
    platforms: string[];
    content: string;
}

export interface SkillsConfig {
    version: number;
    skills: SkillEntry[];
}

/** MCP 服务器条目（标准 mcpServers.<name> 的运行时形态） */
export interface McpServerEntry {
    name: string;
    /** platform 扩展字段；空数组 = 所有平台 */
    platforms: string[];
    type: string;
    url: string;
    token: string;
    headers: { [key: string]: string };
    /**
     * 该服务器的工具结果是否为“图片引用生产者”：为 true 时把文本里的 [img:<sha256>]
     * 规范化为 [img:h<sha256>] 并注册虚拟图。image-host 按服务器名自动视为 true。
     */
    imageRefs?: boolean;
}

export interface McpConfig {
    servers: McpServerEntry[];
}

/** 知识库条目（JSON 字段：name / description / platform / content） */
export interface KbEntry {
    name: string;
    description: string;
    platforms: string[];
    content: string;
}

export interface KbConfig {
    version: number;
    libraries: KbEntry[];
}
