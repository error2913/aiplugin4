// 工具注册统一入口：把 tools/ 下（含各子目录）的全部内置工具注册函数汇集于此，
// 让 tool.ts 只需引用本文件即可保持整洁
import registerBuiltinCmds from "./builtin_cmd.ts/init";
import { registerAttr } from "./builtin_cmd.ts/tool_attr";
import { registerModu } from "./builtin_cmd.ts/tool_modu";
import { registerRollCheck } from "./builtin_cmd.ts/tool_roll_check";
import { registerImage } from "./image.ts/tool_image";
import { registerMeme } from "./image.ts/tool_meme";
import { registerRender } from "./image.ts/tool_render";
import { registerBan } from "./ob11.ts/tool_ban";
import { registerEssenceMsg } from "./ob11.ts/tool_essence_msg";
import { registerGroupSign } from "./ob11.ts/tool_group_sign";
import { registerGetPersonInfo } from "./ob11.ts/tool_person_info";
import { registerQQList } from "./ob11.ts/tool_qq_list";
import { registerRename } from "./ob11.ts/tool_rename";
import { registerDeck } from "./seal.ts/tool_deck";
import { registerBlockTool } from "./tool_block";
import { registerContext } from "./tool_context";
import { registerMemory } from "./tool_memory";
import { registerMessage } from "./tool_message";
import { registerMusicPlay } from "./tool_music";
import { registerTime } from "./tool_time";
import { registerSetTrigger } from "./tool_trigger";
import { registerRecord } from "./tool_voice";
import { registerWeb } from "./tool_web";

/** 注册 tools/ 下全部内置工具（含子目录），调用顺序与原先 tool.ts 内一致 */
export function registerTools() {
    registerBuiltinCmds();
    registerAttr();
    registerModu();
    registerRollCheck();
    registerImage();
    registerMeme();
    registerRender();
    registerBan();
    registerEssenceMsg();
    registerGroupSign();
    registerQQList();
    registerGetPersonInfo();
    registerRename();
    registerDeck();
    registerContext();
    registerMemory();
    registerMessage();
    registerMusicPlay();
    registerTime();
    registerSetTrigger();
    registerRecord();
    registerWeb();
    registerBlockTool();
}
