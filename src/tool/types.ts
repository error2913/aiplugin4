// 工具类型定义
export interface ToolInfoProperties {
    [key: string]: ToolInfoItem;
}

export interface ToolInfoObject {
    type: "object";
    description?: string;
    properties?: ToolInfoProperties;
    required?: (keyof ToolInfoProperties)[];
    additionalProperties?: boolean | ToolInfoItem;
    minProperties?: number;
    maxProperties?: number;
}

export interface ToolInfoString {
    type: "string";
    description?: string;
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    pattern?: string; // 正则表达式
    format?: "date-time" | "email" | "uri" | "uuid" | "hostname" | "ipv4" | "ipv6";
}

export interface ToolInfoNumber {
    type: "number";
    description?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
}

export interface ToolInfoInteger {
    type: "integer";
    description?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
}

export interface ToolInfoArray {
    type: "array";
    description?: string;
    items: ToolInfoItem;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
}

export interface ToolInfoBoolean {
    type: "boolean";
    description?: string;
}

export interface ToolInfoNull {
    type: "null";
    description?: string;
}

export type ToolInfoItem =
    | ToolInfoString
    | ToolInfoNumber
    | ToolInfoInteger
    | ToolInfoBoolean
    | ToolInfoNull
    | ToolInfoArray
    | ToolInfoObject;

export interface ToolInfo {
    type: "function",
    function: {
        name: string,
        description: string,
        parameters: ToolInfoObject
    }
}

export interface ToolCall {
    index: number,
    id: string,
    type: "function",
    function: {
        name: string,
        arguments: string
    }
}

export type ToolContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export interface ToolSolveContent {
    text: string;
    contentParts?: ToolContentPart[];
}

export interface ToolCallResult {
    tool_call_id: string,
    content: string,
    contentParts?: ToolContentPart[], // 多模态内容块，供多模态模型直接消费
    toolName?: string,     // 工具名（回调压缩/审计用）
    searchTarget?: string, // web_search 的搜索目标（压缩时附带，保留与问题相关的信息）
    callBack?: boolean     // 是否把结果回调给智能体（写回上下文继续对话），false 时工具静默执行
}

export interface ToolWaitHandle {
    promise: Promise<string[]>;
    cancel: () => void;
}

export interface ToolListen {
    timeoutId: number | null,
    resolve: ((content: string) => void) | null,
    reject: ((err: Error) => void) | null,
    cleanup: () => void,
    /** 将机器人消息分发给所有正在等待的调用，避免单一 resolve 丢消息。 */
    push?: (content: string) => void,
    /** 收集一段空闲窗口内的多条机器人消息；返回可单独取消的句柄。 */
    waitFor?: (timeoutMs?: number, settleMs?: number, maxMessages?: number) => ToolWaitHandle
}
