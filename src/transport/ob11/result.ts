import { Ob11BackendName, Ob11Failure, Ob11Result, Ob11Success } from "./types";

export function success(
    backend: Ob11BackendName,
    action: string,
    data?: any,
    messageId: string | number | null = null
): Ob11Success {
    return {
        ok: true,
        backend,
        action,
        data,
        message_id: messageId
    };
}

export function failure(
    backend: Ob11BackendName,
    action: string,
    code: string,
    message: string,
    extra: Partial<Ob11Failure["error"]> = {}
): Ob11Failure {
    return {
        ok: false,
        backend,
        action,
        error: {
            code,
            message,
            ...extra
        }
    };
}

export function serializeResult(result: Ob11Result): string {
    return JSON.stringify(result);
}
