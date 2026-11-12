// 注入 provider 注册表：内置与外部插件统一注册有序 provider。
// 只做「注册 / 校验 / 解析」，不 import 领域模块（与 prompt/registry.ts 同构）。
import Logger from "../logger";

import type { InjectionProvider } from "./types";

const log = Logger.withTag('prompt');

/** provider 名字：core:* / ext:<plugin>:<id>（小写字母数字与 :_-） */
const INJECTION_NAME_RE = /^(core|ext):[a-z0-9][a-z0-9:_-]*$/;
/** kind：小写字母开头，数字/下划线/连字符，≤32 字符 */
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 外部插件 provider 默认 order 下限：永远排在内置之后 */
export const EXTENSION_INJECTION_ORDER_BASE = 10000;
/** 外部插件单块字符上限（写块时由框架 clamp） */
export const EXTENSION_INJECTION_MAX_CHARS = 2000;

export type { InjectionContext, InjectionProvider } from "./types";

const registry = new Map<string, InjectionProvider>();

function isExtension(p: InjectionProvider): boolean {
    return p.name.startsWith('ext:');
}

/** 校验 provider 定义；非法返回错误串（内置 fail fast，外部注册转 false） */
export function validateInjectionProvider(p: InjectionProvider): string {
    if (!p || typeof p !== 'object') return 'provider 不能为空';
    if (typeof p.name !== 'string' || !INJECTION_NAME_RE.test(p.name)) {
        return `非法 provider 名：${String(p.name)}（需匹配 core:* / ext:<plugin>:<id>）`;
    }
    if (!Number.isFinite(p.order)) return `provider ${p.name} 的 order 必须是数字`;
    if (typeof p.kind !== 'string' || !KIND_RE.test(p.kind)) return `provider ${p.name} 的 kind 非法`;
    if (typeof p.build !== 'function') return `provider ${p.name} 缺少 build()`;
    return '';
}

function normalizeExtensionProvider(p: InjectionProvider): InjectionProvider {
    return { ...p, order: Math.max(EXTENSION_INJECTION_ORDER_BASE, Math.floor(p.order)), optional: p.optional !== false };
}

/** 注册一个 provider。内置（core）重名直接抛错；外部（ext）同名覆盖并 warning。 */
export function registerInjectionProvider(p: InjectionProvider): void {
    const error = validateInjectionProvider(p);
    if (error) throw new Error(error);
    const normalized = isExtension(p) ? normalizeExtensionProvider(p) : { ...p, optional: p.optional === true };
    const existing = registry.get(normalized.name);
    if (existing) {
        if (isExtension(existing)) {
            log.warning(`外部注入 provider 重名覆盖：${normalized.name}`);
            registry.set(normalized.name, normalized);
            return;
        }
        throw new Error(`注入 provider 重名：${normalized.name}`);
    }
    registry.set(normalized.name, normalized);
}

/** 批量注册（内置 bootstrap 使用） */
export function registerInjectionProviders(providers: InjectionProvider[]): void {
    for (const p of providers) registerInjectionProvider(p);
}

/** 清空注册表（测试 / JS 重载用） */
export function resetInjectionProviders(): void {
    registry.clear();
}

/** 全部已注册 provider（未排序） */
export function listInjectionProviders(): InjectionProvider[] {
    return Array.from(registry.values());
}

/** 本轮调度顺序：order 升序、同值按 name 排序 */
export function resolveInjectionProviders(): InjectionProvider[] {
    return Array.from(registry.values()).sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

/** 外部插件注册入口（对外 API 用，返回 false 而不是抛错） */
export function registerExtensionInjectionProvider(p: InjectionProvider): boolean {
    try {
        registerInjectionProvider({ ...p, optional: p.optional !== false });
        return true;
    } catch (error) {
        log.warning(`外部注入 provider 注册失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
