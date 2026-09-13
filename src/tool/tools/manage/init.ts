// manage 子目录工具注册统一入口（黑名单管理）
import Tool from "../../tool";

import { registerBlockTool } from "./tool_block";

/** 注册 manage 下全部管理工具（分类：黑名单） */
export function registerManageTools() {
    Tool.withCategory('黑名单', registerBlockTool);
}
