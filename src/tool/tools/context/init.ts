// 上下文编辑工具注册统一入口（分类：上下文编辑）
import Tool from "../../tool";

import { registerContextEditTools } from "./tool_context";

/** 注册上下文编辑工具（context_edit_list / context_edit_replace） */
export function registerContextTools() {
    Tool.withCategory('Context editing', registerContextEditTools);
}
