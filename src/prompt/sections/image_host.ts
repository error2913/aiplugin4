// 图床段（`core:image-host`，order 221）：图库规则（**常量段**）。
//
// #163 D1-07：本段不再读 aux 注册表里的 `image-host` 片段，也不渲染图库数量/最近宿主 ID
// ——「图床/MCP 连断」不得改变 system（T3 验收）。门控改为**纯配置**（图片页「图床提示注入」）。
// 旧 order 220 与 `tool:image`（sections/tools.ts 的 210）邻近，方案改用 221 避免同值排序脆弱。
import { IMAGE_HOST_RULES } from '../texts/en';
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

export function registerImageHostSections(): PromptSection[] {
    return [
        {
            name: 'core:image-host',
            order: 221,
            channel: 'system',
            maxChars: SECTION_MAX_CHARS,
            // 常量段：只依赖配置快照（开关 + 预算）
            cache: {
                deps: c => [c.flags.imageHost, c.flags.imageHostBudget],
            },
            build: c => (c.flags.imageHost
                ? truncateTo(IMAGE_HOST_RULES, budgetOf(c.flags.imageHostBudget))
                : ''),
        },
    ];
}
