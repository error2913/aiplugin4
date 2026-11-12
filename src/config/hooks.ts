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
    let out = data;
    const hook = hooks.get(key);
    if (hook) {
        try {
            out = hook(key, data) ?? data;
        } catch (e) {
            logger.error(`配置「${key}」应用失败: ${e instanceof Error ? e.message : String(e)}`);
            out = data;
        }
    }
    // 指纹判定放在钩子之后、返回之前：既覆盖"有钩子"也覆盖"无钩子"的分区（REQ-D7-06 ⑤）
    observeConfigFingerprint(key, data);
    return out;
}

/** 是否已注册钩子（测试断言用） */
export function hasConfigHook(key: string): boolean {
    return hooks.has(key);
}

// ---------------------------------------------------------------------------
// 配置变更监听（#163 REQ-D7-06 ⑤ `config:<key>` rebase 归因）
// ---------------------------------------------------------------------------

/** 配置分区内容变化回调（只在"分区数据 JSON 指纹"变化时触发） */
export type ConfigChangeListener = (key: string) => void;

/** 上次读取到的分区指纹（key = 配置分区名） */
const fingerprints = new Map<string, string>();
let changeListener: ConfigChangeListener | null = null;

/**
 * 注册/覆盖配置变更监听器。
 *
 * ⚠️ 必须在 `Config.registerConfig()` **之后**注册：`runConfigHook` 的首次读取也会建立指纹，
 * 若监听器在装配前就位，启动期所有分区的首次读取都会被当成"变更"从而误记 rebase。
 */
export function setConfigChangeListener(fn: ConfigChangeListener | null): void {
    changeListener = fn;
}

/** 清空指纹表（仅测试用：模拟"新进程重新读取配置"） */
export function resetConfigFingerprints(): void {
    fingerprints.clear();
}

/**
 * 只比较指纹并通知监听器；返回是否发生变化。
 *
 * 抽成独立函数是为了让 `runConfigHook` 的早退分支（无钩子）也能走到指纹判定 ——
 * 否则只有配置了钩子的分区才会被观察，`config:<key>` 白名单里大部分分区会被漏掉。
 *
 * **首次观察只建立基线、不通知**：`Config.registerConfig()` 只预热了 `model` 一个分区，
 * 其余分区（`context`/`tool`/`role`/…）的首次读取必然发生在监听器注册之后。
 * 若把"没有旧指纹"当成"变更"，启动期会对每个分区各广播一次假 rebase
 * ⇒ `.ai ctx` 一上线就显示"已重建 5 次"，真故障会被淹没。基线语义才是对的：
 * 没有旧值可比时，本来就不存在"变化"。
 */
function observeConfigFingerprint(key: string, data: any): void {
    let fp: string;
    try {
        fp = JSON.stringify(data);
    } catch {
        // 不可序列化的配置不参与 rebase 归因（宁可漏记，不可误记）
        return;
    }
    const previous = fingerprints.get(key);
    if (previous === fp) return;
    fingerprints.set(key, fp);
    // 首次观察：只建基线（见上方注释；否则启动期全是假 rebase）
    if (previous === undefined) return;
    if (changeListener) {
        try {
            changeListener(key);
        } catch (e) {
            // 监听器异常不得影响配置读取
            logger.error(`配置「${key}」变更通知失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

/** 读取指纹（测试/观测用） */
export function configFingerprintOf(key: string): string | undefined {
    return fingerprints.get(key);
}
