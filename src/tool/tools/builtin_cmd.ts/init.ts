// builtin_cmd.ts 子目录工具注册统一入口
import { registerJrrp } from "./jrrp";
import { registerAttr } from "./tool_attr";
import { registerModu } from "./tool_modu";
import { registerRollCheck } from "./tool_roll_check";

/** 注册 builtin_cmd.ts 下全部内置指令工具 */
export function registerBuiltinTools() {
    registerJrrp();
    registerAttr();
    registerModu();
    registerRollCheck();
}
