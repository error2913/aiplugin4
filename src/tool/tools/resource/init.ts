// resource 子目录工具注册统一入口（本地文件/视频/点歌/语音）
import { registerMusicPlay } from "./tool_music";
import { registerResourceTools as registerResourceSend } from "./tool_resource";
import { registerRecord } from "./tool_voice";

/** 注册 resource 下全部资源与媒体工具 */
export function registerResourceTools() {
    registerResourceSend();
    registerMusicPlay();
    registerRecord();
}
