// 资源段（`core:resources`，order 211）：资源清单用法（**常量段**）。
//
// #163 D1-07：本段不再读 aux 注册表里的 `resource` 片段，也不渲染内置图片数量/最近 ID/
// `resource:<name>` 清单 —— 那些是"随能力与使用情况每轮变化"的字节，会让 system 中部漂移。
// 现在只由配置开关（资源页「资源清单注入」）与预算控制；清单/数量由 list_resources 现场查询。
import { RESOURCE_USAGE } from '../texts/en';
import type { PromptSection } from '../types';

/** 段硬上限（方案 §10.5：maxChars 600）；配置预算只能在此范围内收紧 */
const SECTION_MAX_CHARS = 600;

function budgetOf(ctxBudget: number): number {
    const value = Number(ctxBudget);
    if (!Number.isFinite(value) || value <= 0) return SECTION_MAX_CHARS;
    return Math.min(SECTION_MAX_CHARS, Math.floor(value));
}

function truncateTo(text: string, max: number): string {
    if (max <= 0 || text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function registerResourceSections(): PromptSection[] {
    return [
        {
            name: 'core:resources',
            order: 211,
            channel: 'system',
            maxChars: SECTION_MAX_CHARS,
            // 常量段：只依赖配置快照（开关 + 预算），不再读 aux 注册表（图/资源数量变化不得影响 S）
            cache: {
                deps: c => [c.flags.resourceLibrary, c.flags.resourceBudget],
            },
            build: c => (c.flags.resourceLibrary
                ? truncateTo(RESOURCE_USAGE, budgetOf(c.flags.resourceBudget))
                : ''),
        },
    ];
}
