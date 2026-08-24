// MCP 标准调用结果类型

export interface MCPContentBlock {
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    url?: string;
    uri?: string;
    name?: string;
    resource?: {
        uri?: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        name?: string;
    };
}

export interface MCPCallResult {
    content?: MCPContentBlock[];
    structuredContent?: any;
    isError?: boolean;
}

/** MCP 结果归一化后的通用表示：文本 + 图片引用 + 资源引用 */
export interface MCPNormalizedResult {
    text: string;
    images: MCPImageReference[];
    resources: MCPResourceReference[];
}

export interface MCPImageReference {
    imageId: string;
    src: string;
    mimeType?: string;
    description?: string;
}

export interface MCPResourceReference {
    uri: string;
    mimeType?: string;
    name?: string;
}
