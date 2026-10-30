// 图床段（`core:image-host`，order 221）：图库规则 + 图床数量/最近 ID。
//
// 只读 aux 注册表里的 `image-host` 片段与 texts 文案；flag `imageHost` 由 builder 从
// `auxRegistry.hasSnippet('image-host')` 派生（适配器注册条件已保证 = 后端图床或 image-host MCP 存在），
// 本段不直接 import ImageHost/MCP，也不 import 图床适配器实现（§13.1）。
// 旧 order 220 与 `tool:image`（sections/tools.ts:29 的 210）邻近，方案改用 221 避免同值排序脆弱。
import { auxRegistry } from '../../core/ports/aux_tools';
import { IMAGE_HOST_RULES, imageHostSnippetLines } from '../texts/en';
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

export function registerImageHostSections(): PromptSection[] {
    return [
        {
            name: 'core:image-host',
            order: 221,
            channel: 'system',
            maxChars: SECTION_MAX_CHARS,
            cache: {
                deps: c => [c.flags.imageHost, c.flags.imageHostBudget, auxRegistry.revision()],
            },
            build: c => {
                if (!c.flags.imageHost) return '';
                const snippet = auxRegistry.snippet('image-host');
                if (!snippet) return '';
                const data = snippet.data || {};
                const text = [
                    IMAGE_HOST_RULES,
                    imageHostSnippetLines({
                        server: typeof data.server === 'string' ? data.server : '',
                        backend: data.backend === true,
                        galleryCount: Number(data.galleryImageCount) || 0,
                        recentIds: stringList(data.recentHostedImages),
                    }),
                ].filter(Boolean).join('\n');
                return truncateTo(text, budgetOf(c.flags.imageHostBudget));
            },
        },
    ];
}
