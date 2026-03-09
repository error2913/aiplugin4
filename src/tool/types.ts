export interface ToolInfoString {
    type: "string";
    description?: string;
    enum?: string[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
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

export interface ToolInfoBoolean {
    type: "boolean";
    description?: string;
}

export interface ToolInfoNull {
    type: "null";
    description?: string;
}

export interface ToolInfoArray {
    type: "array";
    description?: string;
    items: ToolInfoItem;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
}

export interface ToolInfoObject {
    type: "object";
    description?: string;
    properties?: {
        [key: string]: ToolInfoItem;
    };
    required?: (keyof ToolInfoObject["properties"])[];
    additionalProperties?: boolean | ToolInfoItem;
    minProperties?: number;
    maxProperties?: number;
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
export interface ToolCallResult {
    tool_call_id: string,
    content: string
}

export interface ExtCmdInfo {
    extName: string, // 使用的扩展名称
    cmd: string, // 指令名称
    staticArgs: string[] // 参数
}

export interface ToolListen {
    timeoutId: number,
    resolve: (content: string) => void,
    reject: (err: Error) => void,
    cleanup: () => void
}