// 工具注册统一入口：把 tools/ 下（含各子目录）的全部内置工具注册函数汇集于此，
// 让 tool.ts 只需引用本文件即可保持整洁
import { registerBuiltinTools } from "./builtin_cmd.ts/init";
import { registerImageTools } from "./image.ts/init";
import { registerOb11Tools } from "./ob11.ts/init";
import { registerSealTools } from "./seal.ts/init";
import { registerBlockTool } from "./tool_block";
import { registerCmdTool } from "./tool_cmd";
import { registerContext } from "./tool_context";
import { registerForum } from "./tool_forum";
import { registerMemory } from "./tool_memory";
import { registerMessage } from "./tool_message";
import { registerMusicPlay } from "./tool_music";
import { registerTime } from "./tool_time";
import { registerSetTrigger } from "./tool_trigger";
import { registerRecord } from "./tool_voice";
import { registerWeb } from "./tool_web";

/** 注册 tools/ 下全部内置工具（含子目录），调用顺序与原先 tool.ts 内一致 */
export function registerTools() {
    registerBuiltinTools();
    registerImageTools();
    registerOb11Tools();
    registerSealTools();
    registerContext();
    registerMemory();
    registerMessage();
    registerMusicPlay();
    registerTime();
    registerSetTrigger();
    registerRecord();
    registerWeb();
    registerBlockTool();
    registerCmdTool();
    registerForum();
}
