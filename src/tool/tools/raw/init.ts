// raw 子目录工具注册统一入口（工具原文检索）
import Tool from "../../tool";

import { registerRawTools } from "./tool_raw";

/** 注册 raw 下全部工具原文读取工具（分类：原文检索） */
export function registerRawToolSet() {
    Tool.withCategory('原文检索', registerRawTools);
}
