import Logger from "../../logger";

import { getActionCapability } from "./capability_catalog";
import { Ob11NetBackend } from "./ob11_net_backend";
import { failure, serializeResult } from "./result";
import { SealNativeBackend } from "./seal_native_backend";
import { Ob11CallContext, Ob11Result } from "./types";

const log = Logger.withTag('ob11');

const ob11NetBackend = new Ob11NetBackend();
const sealNativeBackend = new SealNativeBackend();

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
    params: Record<string, any> = {}
): Promise<Ob11Result> {
    return dispatchOb11Api({ ctx, msg, endpointId: ctx.endPoint.userId }, action, params);
}

export function formatOb11Result(result: Ob11Result): string {
    return serializeResult(result);
}
