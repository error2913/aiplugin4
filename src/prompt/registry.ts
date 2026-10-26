// Prompt 段注册表：内置模块与外部插件都通过这里注册有序段。
// 只做「注册 / 校验 / 解析」，不 import 任何领域模块，避免循环依赖。
import Logger from "../logger";

import type { PromptSection, SectionScope } from "./types";

const log = Logger.withTag('prompt');

/** 段名字允许：core:* / tool:* / ext:<plugin>:<id>（小写字母数字与 :_-） */
const SECTION_NAME_RE = /^(core|tool|ext):[a-z0-9][a-z0-9:_-]*$/;

/** 外部插件段默认 order 下限：永远排在内置段之后 */
export const EXTENSION_ORDER_BASE = 10000;
/** 外部插件单段字符上限 */
export const EXTENSION_SECTION_MAX_CHARS = 2000;
/** 外部插件全部段合计字符上限 */
export const EXTENSION_TOTAL_MAX_CHARS = 4000;

const registry = new Map<string, PromptSection>();

function scopeOf(section: PromptSection): SectionScope {
    return section.scope || 'core';
}

/** 校验段定义；非法抛错（内置段 fail fast），外部注册由调用方转成 false */
export function validatePromptSection(section: PromptSection): string {
    if (!section || typeof section !== 'object') return 'section 不能为空';
    if (typeof section.name !== 'string' || !SECTION_NAME_RE.test(section.name)) {
        return `非法段名：${String(section.name)}（需匹配 core:* / tool:* / ext:<plugin>:<id>）`;
    }
    if (!Number.isFinite(section.order)) return `段 ${section.name} 的 order 必须是数字`;
    if (section.channel !== 'system' && section.channel !== 'runtime') return `段 ${section.name} 的 channel 非法`;
    if (typeof section.build !== 'function') return `段 ${section.name} 缺少 build()`;
    const scope = scopeOf(section);
    if (scope === 'extension') {
        if (!section.name.startsWith('ext:')) return `外部插件段必须以 ext: 开头：${section.name}`;
        if (section.maxChars !== undefined && (!Number.isFinite(section.maxChars) || section.maxChars <= 0)) {
            return `段 ${section.name} 的 maxChars 非法`;
        }
    } else if (section.name.startsWith('ext:')) {
        return `内置段不能使用 ext: 命名空间：${section.name}`;
    }
    return '';
}

/** 归一化外部段：order 抬到 10000+、maxChars 落到 [1, 2000] */
function normalizeExtensionSection(section: PromptSection): PromptSection {
    const order = Math.max(EXTENSION_ORDER_BASE, Math.floor(section.order));
    const maxChars = Math.min(
        EXTENSION_SECTION_MAX_CHARS,
        Math.max(1, Math.floor(section.maxChars ?? EXTENSION_SECTION_MAX_CHARS)),
    );
    return { ...section, scope: 'extension', order, maxChars, sanitize: section.sanitize || 'external' };
}

/** 注册一个段。内置（core/tool）重名直接抛错；外部（ext）同名覆盖并 warning。 */
export function registerPromptSection(section: PromptSection): void {
    const error = validatePromptSection(section);
    if (error) throw new Error(error);
    const scope = scopeOf(section);
    const normalized = scope === 'extension' ? normalizeExtensionSection(section) : { ...section, scope };
    const existing = registry.get(normalized.name);
    if (existing) {
        if (scopeOf(existing) === 'extension') {
            log.warning(`外部提示词段重名覆盖：${normalized.name}`);
            registry.set(normalized.name, normalized);
            return;
        }
        throw new Error(`提示词段重名：${normalized.name}`);
    }
    registry.set(normalized.name, normalized);
}

/** 批量注册（内置段入口使用） */
export function registerPromptSections(sections: PromptSection[]): void {
    for (const section of sections) registerPromptSection(section);
}

/** 清空注册表（测试 / JS 重载用） */
export function resetPromptSections(): void {
    registry.clear();
}

/** 全部已注册段（未排序） */
export function listPromptSections(): PromptSection[] {
    return Array.from(registry.values());
}

/** 解析出本次组装要用的段：按 order 升序、同值按 name 排序。 */
export function resolvePromptSections(): PromptSection[] {
    return Array.from(registry.values()).sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

/** 外部插件段注册入口（对外 API 用，返回 false 而不是抛错） */
export function registerExtensionSection(section: PromptSection): boolean {
    try {
        registerPromptSection({ ...section, scope: 'extension' });
        return true;
    } catch (error) {
        log.warning(`外部提示词段注册失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
