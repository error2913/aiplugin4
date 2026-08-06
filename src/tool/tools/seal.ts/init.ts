// seal.ts 子目录工具注册统一入口
import { registerDeck } from "./tool_deck";

/** 注册 seal.ts 下全部海豹牌堆相关工具 */
export function registerSealTools() {
    registerDeck();
}
