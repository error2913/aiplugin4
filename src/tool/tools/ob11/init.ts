import Tool from "../../tool";

import { registerCallOb11Api } from "./tool_call_api";
import { registerResolveSpecialId } from "./tool_resolve_id";

/** 注册统一的 call_ob11_api 与特殊 ID/句柄解析工具（分类：OB11）；旧的按 action 工具已经删除。 */
export function registerOb11Tools() {
    Tool.withCategory('OB11', () => {
        registerCallOb11Api();
        registerResolveSpecialId();
    });
}
