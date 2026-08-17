export interface CoreBridgeTarget {
    selfId: string;
    messageType: 'group' | 'private';
    groupId?: string;
    userId?: string;
}

export interface CoreBridgeCapture {
    mode?: 'reply_only' | 'lane';
    forward?: boolean;
    maxMessages?: number;
    settleMs?: number;
}

export interface CoreBridgeInvocation {
    target: CoreBridgeTarget;
    actor: { userId: string; nickname: string; role: string };
    command: { raw: string; name: string; args: string[] };
    capture?: CoreBridgeCapture;
    timeoutMs?: number;
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
    error?: string;
}
