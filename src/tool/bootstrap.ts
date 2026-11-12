// 工具装配入口：只被 src/index.ts 调用。
// 拆分前 Tool.registerTool() 写在 tool/tool.ts 里，导致「注册表 → 全部工具实现 → 注册表」
// 的注册副作用环（实测为全仓最大强桥）。现在实现侧只依赖 registry，装配侧只依赖入口。
import Logger from "../logger";

import { registerMCPTools } from "./mcp";
import { registerSkills } from "./skills";
import { nativeRequestToolsJson } from "./tool";
import { registerTools } from "./tools/init";

const log = Logger.withTag('tool');

/** 注册内置工具、技能工具与 MCP 工具（MCP 异步注册失败只记日志，不阻断启动） */
export function registerAllTools(): void {
    registerTools();
    registerSkills();
    registerMCPTools().catch(e => log.exception('注册MCP工具失败', e));
}

/**
 * 原生工具 schema 的稳定指纹（#163 REQ-D7-06 ⑧）。
 *
 * 由装配层再导出而不是让 `index.ts` 直接 import `tool/tool.ts`：
 * 入口只需要"注册后取指纹"这一个动作，不应因此增加一条到工具注册表的直接边。
 * 必须在 `registerAllTools()` **之后**调用（元工具注册后 schema 才稳定）。
 */
export function nativeToolsJsonForBoot(): string {
    return nativeRequestToolsJson();
}
