// 工具注册表：只保存「工具名 → Tool 实例」，不 import 任何工具实现。
// 拆出本文件的目的：让 tool/tool.ts（Tool 类）与各工具实现都不再反向依赖对方，
// 注册装配统一由 src/tool/bootstrap.ts 在入口处完成。
// 注意：这里用 import type，esbuild 会剔除，运行时不存在 registry → tool 的依赖边。
import type Tool from "./tool";

export const toolMap: { [key: string]: Tool } = {};

/** 工具是否已注册 */
export function hasTool(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(toolMap, name);
}

/** 取工具实例；未注册返回 undefined */
export function getTool(name: string): Tool | undefined {
    return toolMap[name];
}

/** 清空注册表（用于测试/热重载；替代直接遍历 toolMap 的样板） */
export function clearToolMap(): void {
    for (const key of Object.keys(toolMap)) delete toolMap[key];
}
