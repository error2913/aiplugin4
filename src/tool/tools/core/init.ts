// core 子目录工具注册统一入口（调度/触发/时间/指令）
import Tool from "../../tool";

import { registerCmdTool } from "./tool_cmd";
import { registerCoreCommandTool } from "./tool_core_command";
import { registerDispatchTools } from "./tool_dispatch";
import { registerTime } from "./tool_time";
import { registerSetTrigger } from "./tool_trigger";

/** 注册 core 下全部核心基础工具（按分类批次包装，供 .ai tool 组概览与组开关使用） */
export function registerCoreTools() {
    Tool.withCategory('基础调度', registerDispatchTools);
    Tool.withCategory('指令', registerCmdTool);
    Tool.withCategory('指令', registerCoreCommandTool);
    Tool.withCategory('定时', registerTime);
    Tool.withCategory('触发', registerSetTrigger);
}
