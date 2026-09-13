// resource 子目录工具注册统一入口：资源查询与资源生产，不直接注册旧的发送工具。
import Tool from "../../tool";

import { registerMusicPlay } from "./tool_music";
import { registerResourceTools as registerResourceList } from "./tool_resource";
import { registerResourcePathTool } from "./tool_resource_path";
import { registerAudioTools } from "./tool_voice";

/** 注册 resource 下全部资源工具（分类：资源） */
export function registerResourceTools() {
    Tool.withCategory('资源', () => {
        registerResourceList();
        registerResourcePathTool();
        registerAudioTools();
        registerMusicPlay();
    });
}
