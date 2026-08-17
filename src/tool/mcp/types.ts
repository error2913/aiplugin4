// MCP 通用类型：服务器归一化、工具适配配置与调用结果

export interface MCPContentBlock {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    url?: string;
}

export interface MCPCallResult {
    content?: MCPContentBlock[];
    structuredContent?: any;
    isError?: boolean;
}

/** 单个 MCP 工具的本地适配配置。未配置时按通用规则注册 `<服务器名>_<工具名>`。 */
export interface MCPToolConfig {
    /** 暴露给 AI 的工具名；默认 `<服务器名>_<工具名>` */
    exposeAs?: string;
    /** 是否只作为后端远程工具，不注册为 AI 工具（如低层 screenshot_url/scrape_url） */
    hidden?: boolean;
    /** 敏感工具标记；默认 true，与通用 MCP 工具一致 */
    sensitive?: boolean;
    /** 输入/输出适配器名：text/image/web_read/render_markdown/render_html/core_bridge_core */
    adapter?: string;
    /** 覆盖 AI 可见的工具描述 */
    description?: string;
    /** 覆盖 AI 可见的参数 JSON Schema */
    parameters?: any;
    /** 调用远端工具时使用的工具名；默认取配置键名 */
    remoteTool?: string;
    /** 按场景映射到多个远端工具，如 { "screenshot": "screenshot_url", "scrape": "scrape_url" } */
    remoteTools?: Record<string, string>;
    /** 通用适配时声明输出类型：text 或 image */
    output?: 'text' | 'image';
    /** 保存 MCP 返回图片时使用的格式，如 png/unknown */
    format?: string;
}

export interface MCPServerConfig {
    name: string;
    url: string;
    token: string;
    headers: Record<string, string>;
    tools?: Record<string, MCPToolConfig>;
}
