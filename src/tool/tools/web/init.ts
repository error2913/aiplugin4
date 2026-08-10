// web 子目录工具注册统一入口（联网搜索/阅读 + 论坛）
import { registerForum } from "./tool_forum";
import { registerWeb } from "./tool_web";

/** 注册 web 下全部联网工具 */
export function registerWebTools() {
    registerWeb();
    registerForum();
}
