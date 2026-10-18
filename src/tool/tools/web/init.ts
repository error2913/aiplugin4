// web 子目录工具注册统一入口（联网搜索/阅读 + 论坛）
import Tool from "../../tool";

import { registerWebFetch } from "./tool_fetch";
import { registerForum } from "./tool_forum";
import { registerWebSearch } from "./tool_search";

/** 注册 web 下全部联网工具（分类：网页） */
export function registerWebTools() {
    Tool.withCategory('网页', () => {
        registerWebSearch();
        registerWebFetch();
        registerForum();
    });
}
