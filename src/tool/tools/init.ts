// 工具注册统一入口：把 tools/ 下（含各子目录）的全部内置工具注册函数汇集于此，
// 让 tool.ts 只需引用本文件即可保持整洁
import { registerContextTools } from "./context/init";
import { registerCoreTools } from "./core/init";
import { registerImageTools } from "./image/init";
import { registerManageTools } from "./manage/init";
import { registerMemoryTools } from "./memory/init";
import { registerMessageTools } from "./message/init";
import { registerOb11Tools } from "./ob11/init";
import { registerResourceTools } from "./resource/init";
import { registerSealTools } from "./seal/init";
import { registerWebTools } from "./web/init";

/** 注册 tools/ 下全部内置工具（含子目录），调用顺序与原先 tool.ts 内一致 */
export function registerTools() {
    registerImageTools();
    registerOb11Tools();
    registerSealTools();
    registerContextTools();
    registerMemoryTools();
    registerMessageTools();
    registerResourceTools();
    registerCoreTools();
    registerWebTools();
    registerManageTools();
}
