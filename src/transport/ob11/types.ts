import { MessageSegment } from "../../utils/string";

import { SendSessionLike } from "./message_segments";

export type Ob11BackendName = "ob11-net" | "seal-native";

export interface Ob11CallContext {
    ctx?: seal.MsgContext;
    msg?: seal.Message;
    endpointId: string;
    session?: SendSessionLike;
}

export interface Ob11Success {
    ok: true;
    backend: Ob11BackendName;
    action: string;
    data?: any;
    message_id?: string | number | null;
}

export interface Ob11Failure {
    ok: false;
    backend: Ob11BackendName;
    action: string;
    error: {
        code: string;
        message: string;
        retryable?: boolean;
        install_hint?: string;
        segment_type?: string;
    };
}

export type Ob11Result = Ob11Success | Ob11Failure;

export interface Ob11Backend {
    readonly name: Ob11BackendName;
    canHandle(action: string): boolean;
    call(context: Ob11CallContext, action: string, params: Record<string, any>): Promise<Ob11Result>;
}

export interface Ob11MessageParams {
    user_id?: string | number;
    group_id?: string | number;
    message?: MessageSegment[] | string;
    auto_escape?: boolean;
}
