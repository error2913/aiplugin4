import Logger from "../../logger";

import { normalizeFileReference, normalizeMessageSegments } from "./message_segments";
import { failure, success } from "./result";
import { Ob11Backend, Ob11CallContext, Ob11Result } from "./types";

function getNet(): NetApi | null {
    const net = globalThis.net;
    return net && typeof net.callApi === "function" ? net : null;
}

function getMessageId(data: any): string | number | null {
    return data && (data.message_id ?? data.msgid ?? data.message_seq ?? null);
}

export class Ob11NetBackend implements Ob11Backend {
    readonly name = "ob11-net" as const;

    canHandle(_action: string): boolean {
        return getNet() !== null;
    }

    async call(context: Ob11CallContext, action: string, params: Record<string, any>): Promise<Ob11Result> {
        const net = getNet();
        if (!net) {
            return failure(this.name, action, "OB11_DEPENDENCY_REQUIRED", "未检测到 ob11 网络连接依赖");
        }

        try {
            const normalizedParams = { ...params };
            if (normalizedParams.message !== undefined) {
                normalizedParams.message = await normalizeMessageSegments(normalizedParams.message);
            }
            if ((action === "upload_group_file" || action === "upload_private_file") && normalizedParams.file !== undefined) {
                normalizedParams.file = await normalizeFileReference(normalizedParams.file);
            }

            let data: any;
            if (action === "upload_group_file" || action === "upload_private_file") {
                const scene = action === "upload_group_file" ? "group" : "private";
                const peerId = scene === "group" ? normalizedParams.group_id : normalizedParams.user_id;
                const file = normalizedParams.file;
                if (typeof net.sendFile === "function" && peerId !== undefined && file) {
                    data = await net.sendFile(
                        context.endpointId,
                        scene,
                        peerId,
                        String(file),
                        String(normalizedParams.name || ""),
                        normalizedParams.folder_id
                    );
                } else {
                    data = await net.callApi(context.endpointId, action, normalizedParams);
                }
            } else {
                data = await net.callApi(context.endpointId, action, normalizedParams);
            }

            return success(this.name, action, data, getMessageId(data));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.error(`OB11 API ${action} 调用失败：${message}`);
            return failure(this.name, action, "OB11_API_ERROR", message, { retryable: true });
        }
    }
}
