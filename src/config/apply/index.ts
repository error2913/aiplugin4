// 配置应用层装配入口：把各分区的「依赖实现」的钩子一次性注册到 config/hooks。
// 只由组合根调用：src/index.ts（产品）与 scripts/test-host.ts（单测/验收入口）。
import { registerConfigHook } from "../hooks";

import { applyModelConfig } from "./model";

export function registerConfigAppliers(): void {
    registerConfigHook('model', (_key, data) => applyModelConfig(data));
}
