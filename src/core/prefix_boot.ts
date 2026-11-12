// 引导期前缀 rebase 归因（#163 REQ-D7-06 ⑥⑦⑧）：reload / upgrade / tools。
//
// 为什么需要：进程重启后 `session.prefixSnapshot` 必然为空（它是纯运行时字段），
// 因此本次启动的首次编译一定换掉前缀。这是设计允许的 rebase，但必须显式归因 ——
// 否则它会被当成"非白名单漂移"污染观测，也无法区分「热重载」与「版本升级」。
//
// 为什么放 L0（core/）而不是 session/persistence.ts：
// 读它的是 `utils/message.ts`（L2）与 `index.ts`（L4）。若放在 session（L3），
// 就产生 L2 → L3 的反向依赖（deps:check 直接判退化）；本模块只依赖 L0 的宿主端口，
// 两边都只做 L? → L0 的下行依赖。
import { getHost } from "./host";

/** 引导期归因存储键：记录「上次启动时的插件版本 + 原生工具 schema 指纹」 */
const BOOT_KEY = 'ctx_prefix_boot';

/** 引导期 rebase 原因：热重载 / 版本升级 / 原生工具 schema 变化 */
export type BootRebaseCause = 'reload' | 'upgrade' | 'tools';

let bootCause: BootRebaseCause | null = null;

/**
 * 启动时调用一次：比较版本与原生工具 schema 指纹，决定「本次启动首编译」的 rebase 归因。
 *
 * @param version 插件版本（`meta.VERSION`）
 * @param toolsJson 原生工具 schema 的稳定 JSON（由装配层传入，避免本模块依赖 tool 层）
 */
export function initBootRebaseCause(version: string, toolsJson: string): void {
    const fingerprint = JSON.stringify({ version, tools: toolsJson });
    let prev: { version?: string; tools?: string } | null = null;
    try {
        prev = JSON.parse(getHost().storage.get(BOOT_KEY) || 'null');
    } catch {
        prev = null;
    }
    if (prev && typeof prev === 'object') {
        if (prev.version !== version) bootCause = 'upgrade';
        else if (prev.tools !== toolsJson) bootCause = 'tools';
        else bootCause = 'reload';
    } else {
        // 首次安装：没有"上一份前缀"可污染，不记 rebase（否则第一次启动就有一条假 rebase）
        bootCause = null;
    }
    try {
        getHost().storage.set(BOOT_KEY, fingerprint);
    } catch {
        // 存储不可用时静默：归因缺失只影响观测，不影响正确性
    }
}

/** 取走引导期归因（一次性；取走后返回 null，后续首编译不再归因） */
export function takeBootRebaseCause(): BootRebaseCause | null {
    const cause = bootCause;
    bootCause = null;
    return cause;
}

/** 仅测试用：重置引导期归因与存储键 */
export function resetBootRebaseCauseForTest(): void {
    bootCause = null;
    try {
        getHost().storage.set(BOOT_KEY, '');
    } catch {
        // ignore
    }
}
