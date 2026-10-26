// MCP 标准协议类型（tools / prompts / resources 的请求结果与通用表示）

// ---------------- tools ----------------

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

/** tools/list 的 annotations（客户端安全分组用，不是提示词内容） */
export interface MCPToolAnnotations {
    title?: string;
    /** 只读提示：仅记录，不改变行为 */
    readOnlyHint?: boolean;
    /** 破坏性提示：true 时注册为敏感工具（进入审计/敏感路径） */
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface MCPCallResult {
    content?: MCPContentBlock[];
    structuredContent?: any;
    isError?: boolean;
}

// ---------------- prompts ----------------

/** prompts/list 的模板参数 */
export interface MCPPromptArgument {
    name: string;
    description?: string;
    required?: boolean;
}

/** prompts/list 的模板定义 */
export interface MCPPromptDef {
    name: string;
    description?: string;
    arguments?: MCPPromptArgument[];
}

/** prompts/get 返回的消息（role = user / assistant；content 为 text / image / resource 等） */
export interface MCPPromptMessage {
    role?: string;
    content?: any;
}

/** prompts/get 结果 */
export interface MCPPromptGetResult {
    description?: string;
    messages: MCPPromptMessage[];
}

// ---------------- resources ----------------

/** resources/list 的资源定义 */
export interface MCPResourceDef {
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
}

/** resources/read 返回的单条内容（text 或 blob 二选一） */
export interface MCPResourceContent {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}

/** resources/read 结果 */
export interface MCPResourceReadResult {
    contents: MCPResourceContent[];
}

// ---------------- 归一化表示 ----------------

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
