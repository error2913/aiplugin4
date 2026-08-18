import { getCtxAndMsg } from "../../utils/seal";

import { encodeNativeMessage, normalizeMessageSegments } from "./message_segments";
import { failure, success } from "./result";
import { Ob11Backend, Ob11CallContext, Ob11Result } from "./types";

function stripPrefix(value: any): string {
    return String(value ?? "").replace(/^.+:/, "");
}

function sameId(left: any, right: any): boolean {
    return stripPrefix(left) === stripPrefix(right);
}

function contextSnapshot(context: Ob11CallContext, action: string, params: Record<string, any>): Ob11Result {
    const ctx: any = context.ctx;
    if (!ctx) {
        return failure("seal-native", action, "NATIVE_CONTEXT_UNAVAILABLE", "没有可用于读取原生上下文的 SealDice 消息上下文");
    }

    const endpointId = stripPrefix(context.endpointId);
    const player = ctx.player || {};
    const group = ctx.group || {};
    const requestedUser = params.user_id === undefined ? "" : stripPrefix(params.user_id);
    const requestedGroup = params.group_id === undefined ? "" : stripPrefix(params.group_id);

    switch (action) {
        case "get_login_info":
            return success("seal-native", action, { user_id: endpointId, nickname: ctx.endPoint?.userId === context.endpointId ? player.name || "" : "" });
        case "get_status":
            return success("seal-native", action, { online: true, good: true, backend: "seal-native" });
        case "get_version_info":
            return success("seal-native", action, { app_name: "SealDice", app_version: "unknown", protocol: "native" });
        case "get_group_info":
            if (!group.groupId || (requestedGroup && !sameId(group.groupId, requestedGroup))) {
                return failure("seal-native", action, "NATIVE_CONTEXT_UNAVAILABLE", "目标群不在当前 SealDice 上下文或本地缓存中");
            }
            return success("seal-native", action, {
                group_id: Number(stripPrefix(group.groupId)) || stripPrefix(group.groupId),
                group_name: group.groupName || ""
            });
        case "get_group_member_info":
            if (!group.groupId || !player.userId || (requestedGroup && !sameId(group.groupId, requestedGroup)) || (requestedUser && !sameId(player.userId, requestedUser))) {
                return failure("seal-native", action, "NATIVE_CONTEXT_UNAVAILABLE", "目标用户或群不在当前 SealDice 上下文或本地缓存中");
            }
            return success("seal-native", action, {
                group_id: Number(stripPrefix(group.groupId)) || stripPrefix(group.groupId),
                user_id: Number(stripPrefix(player.userId)) || stripPrefix(player.userId),
                nickname: player.name || "",
                card: player.name || "",
                role: player.role || "member"
            });
        case "get_stranger_info":
            if (!player.userId || (requestedUser && !sameId(player.userId, requestedUser))) {
                return failure("seal-native", action, "NATIVE_CONTEXT_UNAVAILABLE", "目标用户不在当前 SealDice 上下文或本地缓存中");
            }
            return success("seal-native", action, {
                user_id: Number(stripPrefix(player.userId)) || stripPrefix(player.userId),
                nickname: player.name || "",
                sex: "unknown",
                age: 0
            });
        default:
            return failure("seal-native", action, "NATIVE_ACTION_UNSUPPORTED", `native 后端未实现 ${action}`);
    }
}

export class SealNativeBackend implements Ob11Backend {
    readonly name = "seal-native" as const;

    canHandle(action: string): boolean {
        return action === "send_private_msg" || action === "send_group_msg" || [
            "get_login_info",
            "get_status",
            "get_version_info",
            "get_group_info",
            "get_group_member_info",
            "get_stranger_info"
        ].includes(action);
    }

    async call(context: Ob11CallContext, action: string, params: Record<string, any>): Promise<Ob11Result> {
        if (action !== "send_private_msg" && action !== "send_group_msg") {
            return contextSnapshot(context, action, params);
        }

        if (!context.ctx || !context.msg) {
            return failure(this.name, action, "NATIVE_CONTEXT_UNAVAILABLE", "原生消息发送需要 SealDice 上下文");
        }
        if (params.message === undefined) {
            return failure(this.name, action, "INVALID_PARAMS", "send_*_msg 必须提供 message");
        }

        try {
            const normalized = await normalizeMessageSegments(params.message);
            const content = encodeNativeMessage(normalized);
            if (!content) return failure(this.name, action, "INVALID_PARAMS", "message 为空");

            const targetId = action === "send_group_msg" ? params.group_id : params.user_id;
            if (targetId === undefined || targetId === null || targetId === "") {
                return failure(this.name, action, "INVALID_PARAMS", `${action} 缺少目标 ID`);
            }

            let targetCtx = context.ctx;
            let targetMsg = context.msg;
            const currentTarget = action === "send_group_msg"
                ? (context.ctx.group && context.ctx.group.groupId)
                : (context.ctx.player && context.ctx.player.userId);
            if (!sameId(currentTarget, targetId)) {
                const target = action === "send_group_msg"
                    ? getCtxAndMsg(context.endpointId, "", `QQ-Group:${stripPrefix(targetId)}`)
                    : getCtxAndMsg(context.endpointId, `QQ:${stripPrefix(targetId)}`, "");
                targetCtx = target.ctx;
                targetMsg = target.msg;
            }

            seal.replyToSender(targetCtx, targetMsg, content);
            return success(this.name, action, { sent: true, content }, null);
        } catch (error) {
            return failure(this.name, action, "NATIVE_SEND_ERROR", error instanceof Error ? error.message : String(error), { retryable: false });
        }
    }
}
