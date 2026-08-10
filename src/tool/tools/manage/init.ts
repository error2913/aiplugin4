// manage 子目录工具注册统一入口（黑名单管理）
import { registerBlockTool } from "./tool_block";

/** 注册 manage 下全部管理工具 */
export function registerManageTools() {
    registerBlockTool();
}
