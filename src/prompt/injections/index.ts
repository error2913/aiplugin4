// 内置注入 provider 注册入口（bootstrap 调用一次；测试/重载前需 resetInjectionProviders）。
//
// #163 D3a 建壳，D3 的内置 provider 由本模块统一注册：
// `core:time`（D4）、`core:memory`（D1-04 的替代）、`core:mcp`（D1-05 的替代）。
//
// **`core:wake` 不是 provider**（裁决 R-03）：零新增消息起轮（定时器/活跃时段/judge/事件/外部 API）
// 走的是普通 `SystemEvent`（`SYSTEM_NAME.wake` + `writeWakeMarker()`），时间语义由
// `renderSystemEvent` 的 `[time]` 承载，不需要也不应该变成注入块。
import { registerInjectionProviders } from "../injection_registry";
import type { InjectionProvider } from "../types";

import { createMcpProvider } from "./mcp";
import { createMemoryProvider } from "./memory";
import { createTimeProvider } from "./time";

/**
 * 内置 provider 工厂清单（出厂常量，**不可变**）。
 *
 * 与可变清单分开的原因：`resetBuiltinInjectionProviderFactories()` 必须能恢复到出厂状态。
 * 若直接在同一个数组上 `length = 0`，热重载后再注册就永久少了三个内置 provider
 * （表现为"时间/记忆/MCP 全都不注入了"，且没有任何报错）。
 */
const BUILTIN_FACTORIES: ReadonlyArray<() => InjectionProvider | null> = [
    createTimeProvider,
    createMemoryProvider,
    createMcpProvider,
];

/**
 * 当前生效的工厂清单 = 出厂清单 + 外部插件追加项。
 *
 * 用工厂而不是直接实例：provider 可能要读配置（开关关闭时不该注册），
 * 而注册发生在装配期、配置已就绪 ⇒ 在 `registerBuiltinInjectionProviders()` 时求值。
 */
let factories: Array<() => InjectionProvider | null> = BUILTIN_FACTORIES.slice();

/** 追加一个内置 provider 工厂（插件/后续切片用；未启用的工厂返回 null） */
export function addBuiltinInjectionProviderFactory(factory: () => InjectionProvider | null): void {
    if (typeof factory === 'function' && factories.indexOf(factory) < 0) factories.push(factory);
}

/** 注册全部内置注入 provider（bootstrap 调用一次） */
export function registerBuiltinInjectionProviders(): void {
    const providers: InjectionProvider[] = [];
    for (const factory of factories) {
        let provider: InjectionProvider | null = null;
        try {
            provider = factory();
        } catch {
            // 单个工厂读配置失败不能拖垮其余 provider（否则一次异常就整体失能）
            provider = null;
        }
        if (provider) providers.push(provider);
    }
    if (providers.length > 0) registerInjectionProviders(providers);
}

/** 恢复出厂工厂清单（测试 / JS 重载用） */
export function resetBuiltinInjectionProviderFactories(): void {
    factories = BUILTIN_FACTORIES.slice();
}

/** 当前生效的工厂数（观测/测试用） */
export function builtinInjectionProviderFactoryCount(): number {
    return factories.length;
}
