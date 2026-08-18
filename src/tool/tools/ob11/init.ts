import { registerCallOb11Api } from "./tool_call_api";

/** 仅注册统一的 call_ob11_api；旧的按 action 工具已经删除。 */
export function registerOb11Tools() {
    registerCallOb11Api();
}
