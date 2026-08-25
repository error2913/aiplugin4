import { registerCallOb11Api } from "./tool_call_api";
import { registerResolveSpecialId } from "./tool_resolve_id";

/** 注册统一的 call_ob11_api 与特殊 ID/句柄解析工具；旧的按 action 工具已经删除。 */
export function registerOb11Tools() {
    registerCallOb11Api();
    registerResolveSpecialId();
}
