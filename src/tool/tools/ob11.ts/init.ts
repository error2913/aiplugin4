// ob11.ts 子目录工具注册统一入口
import { registerBan } from "./tool_ban";
import { registerEssenceMsg } from "./tool_essence_msg";
import { registerGroupSign } from "./tool_group_sign";
import { registerGetPersonInfo } from "./tool_person_info";
import { registerQQList } from "./tool_qq_list";
import { registerRename } from "./tool_rename";

/** 注册 ob11.ts 下全部 ob11 相关工具 */
export function registerOb11Tools() {
    registerBan();
    registerEssenceMsg();
    registerGroupSign();
    registerQQList();
    registerGetPersonInfo();
    registerRename();
}
