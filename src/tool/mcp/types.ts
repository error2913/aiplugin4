// MCP 标准调用结果类型

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
