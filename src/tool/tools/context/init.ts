// 上下文工具注册统一入口（分类：上下文编辑 / 原文检索）
import Tool from "../../tool";

import { registerContextEditTools } from "./tool_context";
import { registerResolveContextRef } from "./tool_resolve";

/** 注册上下文编辑工具（context_edit_list / context_edit_replace） */
export function registerContextTools() {
    Tool.withCategory('Context editing', registerContextEditTools);
    // 引用解析与 read_raw/grep_raw 同属“原文检索”域，避免新增工具组
    Tool.withCategory('Raw search', registerResolveContextRef);
}
