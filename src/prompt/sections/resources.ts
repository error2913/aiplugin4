// 资源段（`core:resources`，order 211）：内置图片数量/最近 ID + `resource:<name>` 清单。
//
// 只读 aux 注册表里的 `resource` 片段（结构化数据）与 texts 文案，不 import 资源适配器实现
//（§13.1：prompt/sections 只允许 `core/ports/aux_tools` 元数据 + texts）。
// 开关与预算：资源页「资源清单注入」（默认关）/「资源清单预算」（缺省 600）；
// 缓存依赖含 auxRegistry.revision()，避免缓存住动态 ID 列表（§10.5）。
import { auxRegistry } from '../../core/ports/aux_tools';
import { RESOURCE_USAGE, resourceSnippetLines } from '../texts/en';
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

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

export function registerResourceSections(): PromptSection[] {
    return [
        {
            name: 'core:resources',
            order: 211,
            channel: 'system',
            maxChars: SECTION_MAX_CHARS,
            cache: {
                deps: c => [c.flags.resourceLibrary, c.flags.resourceBudget, auxRegistry.revision()],
            },
            build: c => {
                if (!c.flags.resourceLibrary) return '';
                const snippet = auxRegistry.snippet('resource');
                if (!snippet) return '';
                const data = snippet.data || {};
                const text = [
                    RESOURCE_USAGE,
                    resourceSnippetLines({
                        imageCount: Number(data.builtinImageCount) || 0,
                        recentImages: stringList(data.recentImages),
                        localResources: stringList(data.localResources),
                    }),
                ].filter(Boolean).join('\n');
                return truncateTo(text, budgetOf(c.flags.resourceBudget));
            },
        },
    ];
}
