// media 子目录工具注册统一入口（分类：多媒体）
import Tool from "../../tool";

import { registerMediaTaskTools } from "./tool_media_tasks";

/** 注册 media 下全部工具（分类：多媒体） */
export function registerMediaTools() {
    Tool.withCategory('Media', () => {
        registerMediaTaskTools();
    });
}
