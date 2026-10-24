// 配置读取钩子：配置段只负责「解析出数据」；依赖实现的「应用 / 派生」逻辑由入口模块注册到这里。
// 目的：configs/* 不必 import model、resource 等实现层，配置总线不再反向依赖实现
// （这是 config ↔ 实现 大环的关键一刀；见 .dev/refactor-plan.md Phase 2b）。
import { logger } from "../logger";

/** key = 配置分区名（与 config/config.ts 的 configMap 键一致） */
export type ConfigHook = (key: string, data: any) => any;

const hooks = new Map<string, ConfigHook>();

/** 注册 / 覆盖某个配置分区的钩子（由入口 src/index.ts 与 scripts/test-host.ts 装配） */
export function registerConfigHook(key: string, hook: ConfigHook): void {
    hooks.set(key, hook);
}

/** 配置数据算完后调用：无钩子原样返回；钩子抛错记日志并回退原数据，不让读配置崩掉 */
export function runConfigHook(key: string, data: any): any {
    const hook = hooks.get(key);
    if (!hook) return data;
    try {
        return hook(key, data) ?? data;
    } catch (e) {
        logger.error(`配置「${key}」应用失败: ${e instanceof Error ? e.message : String(e)}`);
        return data;
    }
}

/** 是否已注册钩子（测试断言用） */
export function hasConfigHook(key: string): boolean {
    return hooks.has(key);
}
