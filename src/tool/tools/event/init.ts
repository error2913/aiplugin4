// event 子目录工具注册统一入口（事件原始数据读取）
import { registerEventTools } from "./tool_event";

/** 注册 event 下全部事件工具 */
export function registerEventToolSet() {
    registerEventTools();
}
