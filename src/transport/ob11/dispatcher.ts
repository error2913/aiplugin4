import Logger from "../../logger";

import { getActionCapability } from "./capability_catalog";
import { resolveSendMessage, SendSessionLike } from "./message_segments";
import { Ob11NetBackend } from "./ob11_net_backend";
import { failure, serializeResult } from "./result";
import { SealNativeBackend } from "./seal_native_backend";
import { normalizeSpecialIdParams, validateSpecialIdParams } from "./special_id_params";
import { Ob11CallContext, Ob11Result } from "./types";

const log = Logger.withTag('ob11');

const ob11NetBackend = new Ob11NetBackend();
const sealNativeBackend = new SealNativeBackend();

/** 需要处理消息正文渲染标签的发送类 action */
const SEND_MESSAGE_ACTIONS = new Set(["send_group_msg", "send_private_msg", "send_msg"]);

export function hasOb11Network(): boolean {
    return ob11NetBackend.canHandle("");
}

export function dependencyRequired(action: string): Ob11Result {
    return failure(
        "seal-native",
        action,
        "OB11_DEPENDENCY_REQUIRED",
        `${action} 需要 ob11 网络连接依赖，当前未检测到 globalThis.net`,
        {
            install_hint: "请安装 ob11 网络连接依赖或 http 依赖插件",
            retryable: false
        }
    );
}

/** 面向工具和内部模块的统一调用入口。每次调用实时检测依赖，支持热加载/卸载。 */
export async function dispatchOb11Api(
    context: Ob11CallContext,
    action: string,
    params: Record<string, any>
): Promise<Ob11Result> {
    const normalizedAction = String(action || "").trim();
    if (!normalizedAction) {
        return failure("seal-native", "", "INVALID_PARAMS", "action 不能为空");
    }

    // 发送消息前把文本里的渲染标签解析为真实消息段（内部标签剥离、[img:] 等解析成图片/语音段），
    // 避免模型把 [msg_id]/[img:虚拟ID] 等原样发到群里；仅工具调用路径带 session 时可解析。
    if (SEND_MESSAGE_ACTIONS.has(normalizedAction) && params && params.message !== undefined && context.ctx && context.session) {
        params = { ...params, message: await resolveSendMessage(context.ctx, context.session, params.message) };
    }

    // get_image/get_record 等特殊 ID 参数 fail-fast 校验：完整 URL/未登记句柄直接短路，
    // 避免 AI 把下载 URL 或渲染标签原样发给协议端导致 file not found。
    const validated = validateSpecialIdParams(normalizedAction, params || {});
    if (validated.ok === false) {
        return failure("seal-native", normalizedAction, validated.code, validated.message, { retryable: false });
    }

    // 特殊 ID 归一化：模型可能直接使用上下文里的短 ID（[msg_id:base36]/[quote:base36]/[img:图片ID]/[voice:句柄]），
    // 调用前还原为协议端需要的原始 message_id/file/url，避免把渲染标签或 base36 短 ID 原样外发。
    params = normalizeSpecialIdParams(normalizedAction, params || {});
    if (ob11NetBackend.canHandle(normalizedAction)) {
        return ob11NetBackend.call(context, normalizedAction, params || {});
    }

    if (getActionCapability(normalizedAction) === "network" || !sealNativeBackend.canHandle(normalizedAction)) {
        return dependencyRequired(normalizedAction);
    }

    return sealNativeBackend.call(context, normalizedAction, params || {});
}

/** 只在已有 ob11 网络依赖时使用的无消息上下文调用，供上下文查询和事件展开使用。 */
export async function callOb11ApiDirect(endpointId: string, action: string, params: Record<string, any> = {}): Promise<any | null> {
    if (!ob11NetBackend.canHandle(action)) return null;
    const result = await ob11NetBackend.call({ endpointId }, action, params);
    if (result.ok === false) {
        log.warning(`OB11 API ${action} 调用失败：${result.error.message}`);
        return null;
    }
    return result.data;
}

export async function callOb11ApiForContext(
    ctx: seal.MsgContext,
    msg: seal.Message,
    action: string,
    params: Record<string, any> = {},
    session?: SendSessionLike
): Promise<Ob11Result> {
    return dispatchOb11Api({ ctx, msg, endpointId: ctx.endPoint.userId, session }, action, params);
}

export function formatOb11Result(result: Ob11Result): string {
    return serializeResult(result);
}
