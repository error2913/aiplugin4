// resource 子目录工具注册统一入口：资源查询与资源生产，不直接注册旧的发送工具。
import { registerMusicPlay } from "./tool_music";
import { registerResourceTools as registerResourceList } from "./tool_resource";
import { registerResourcePathTool } from "./tool_resource_path";
import { registerAudioTools } from "./tool_voice";

export function registerResourceTools() {
    registerResourceList();
    registerResourcePathTool();
    registerAudioTools();
    registerMusicPlay();
}
