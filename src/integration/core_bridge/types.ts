export interface CoreBridgeTarget {
    selfId: string;
    messageType: 'group' | 'private';
    groupId?: string;
    userId?: string;
}

/**
 * 一次核心调用的**真实来源**（standalone 专用投影输入，REQ-D7-02）。
 * 只带真实 ID/名称，桥侧负责换成虚拟世界里的 ID，插件绝不自己算虚拟号。
 */
export interface CoreBridgeSource {
    /** 骰子账号的完整端点标识（如 `QQ:10000`），桥侧只从中取尾号登记真实号。 */
    endpointId: string;
    messageType: 'group' | 'private';
    groupId?: string;
    userId: string;
    groupName?: string;
    /** OB11 只有 owner/admin/member 三值；非群聊可缺省。 */
    userRole?: string;
}

/** `hello` 握手结果：桥告知自己是 relay 中转站还是独立 OB11 协议端（REQ-D6-01 / REQ-D7-01）。 */
export interface CoreBridgeHello {
    mode: 'relay' | 'standalone';
    platform?: string;
    corePort?: number;
    virtualSelfId?: string | null;
    virtualNickname?: string;
    protocolVersion?: string;
    capabilities?: string[];
    bridgeVersion?: string;
}

export interface CoreBridgeCapture {
    mode?: 'reply_only' | 'lane';
    forward?: boolean;
    maxMessages?: number;
    settleMs?: number;
}

export interface CoreBridgeWsCommand {
    target: CoreBridgeTarget;
    /** standalone 下建议改发 `source`（真实 ID），桥侧投影成虚拟 ID 后再进核心。 */
    source?: CoreBridgeSource;
    actor: { userId: string; nickname: string; role: string };
    raw_message?: string;
    command?: { raw: string; name?: string; args?: string[] };
    capture?: CoreBridgeCapture;
    timeoutMs?: number;
    trigger?: string;
    at?: string[];
}


export interface CoreBridgeMessage {
    messageId?: string;
    action?: string;
    segments?: any[];
    text?: string;
    source?: string;
    forwarded?: boolean;
    intercepted?: boolean;
}

export interface CoreBridgeResult {
    ok: boolean;
    messages?: CoreBridgeMessage[];
    completedBy?: string;
    ambiguous?: boolean;
    forwardedCount?: number;
    interceptedCount?: number;
    /** 桥的模式（只增不改，REQ-D6-04 / REQ-D7-07）；老桥不返回。 */
    mode?: 'relay' | 'standalone';
    /** standalone 下"本次调用真正投递给调用方的消息条数"，插件文案读它。 */
    deliveredCount?: number;
    /** standalone 下本次调用被投影到的虚拟目标，便于日志/排障。 */
    virtualTarget?: CoreBridgeTarget;
    error?: string;
}
