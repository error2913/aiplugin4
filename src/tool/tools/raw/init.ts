// raw 子目录工具注册统一入口（工具原文检索）
import { registerRawTools } from "./tool_raw";

/** 注册 raw 下全部工具原文读取工具 */
export function registerRawToolSet() {
    registerRawTools();
}
