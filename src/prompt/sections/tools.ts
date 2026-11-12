// 工具与能力段：工具获取/调用格式 + 按工具可见性门控的指导段
//
// #163 D1-11：`core:tool-call-format` 已**常量化** —— 不再渲染元工具的完整 parameters JSON，
// 只列 `META_TOOL_SUMMARIES`（名字 + 一句话用途），参数 schema 由 `search_tools` 现场返回。
// 这样 S 不再随工具注册/开关/平台过滤变化。
import {
    COMMANDS_GUIDANCE,
    IMAGE_TOOLS_GUIDANCE,
    KNOWLEDGE_GUIDANCE,
    OB11_GUIDANCE,
    READ_RAW_GUIDANCE,
    RESOLVE_CONTEXT_GUIDANCE,
    RESOURCES_GUIDANCE,
    SKILLS_GUIDANCE,
    TOOL_ACCESS,
    toolCallFormat,
} from '../texts/en';
import type { PromptSection } from '../types';

export function registerToolSections(): PromptSection[] {
    return [
        {
            name: 'tool:image',
            order: 210,
            channel: 'system',
            maxChars: 1200,
            // 常驻常量（#163 REQ-D1-09）：不按 c.tool(...) 门控 —— 工具开关变化不得改变 S
            cache: { deps: () => [] },
            build: () => IMAGE_TOOLS_GUIDANCE,
        },
        {
            name: 'tool:ob11',
            order: 310,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: () => [] },
            build: () => OB11_GUIDANCE,
        },
        {
            name: 'core:tool-access',
            order: 500,
            channel: 'system',
            maxChars: 1500,
            // 模式门控保留：STATUS / 提示词工程切换 = 白名单 rebase（REQ-D8-10）
            cache: { deps: c => [c.flags.status, c.flags.promptEngineering] },
            build: c => (c.flags.status && !c.flags.promptEngineering ? TOOL_ACCESS : ''),
        },
        {
            name: 'core:tool-call-format',
            order: 510,
            channel: 'system',
            maxChars: 6000,
            // 常量段：只随「模式」变化（STATUS / 提示词工程），不随工具开关/注册/平台变化
            cache: { deps: c => [c.flags.status, c.flags.promptEngineering] },
            build: c => {
                if (!c.flags.status || !c.flags.promptEngineering) return '';
                return toolCallFormat();
            },
        },
        {
            name: 'tool:read-raw',
            order: 520,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: () => [] },
            build: () => READ_RAW_GUIDANCE,
        },
        {
            name: 'tool:resolve-context',
            order: 525,
            channel: 'system',
            maxChars: 900,
            cache: { deps: () => [] },
            build: () => RESOLVE_CONTEXT_GUIDANCE,
        },
        {
            name: 'tool:resources',
            order: 530,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: () => [] },
            build: () => RESOURCES_GUIDANCE,
        },
        {
            name: 'tool:commands',
            order: 540,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: () => [] },
            build: () => COMMANDS_GUIDANCE,
        },
    ];
}

/**
 * 技能/知识库的常量说明段（#163 D1-10）。
 *
 * 原 `core:skills`（order 600）与 `core:knowledge`（order 700）会枚举当前技能/知识库清单，
 * 清单随配置与安装变化 ⇒ S 漂移。改为常量说明 + 工具现场查询。
 */
export function registerDiscoverySections(): PromptSection[] {
    return [
        {
            name: 'core:skills',
            order: 600,
            channel: 'system',
            maxChars: 2000,
            cache: { deps: c => [c.flags.status] },
            build: c => (c.flags.status ? SKILLS_GUIDANCE : ''),
        },
        {
            name: 'core:knowledge',
            order: 700,
            channel: 'system',
            maxChars: 3000,
            cache: { deps: c => [c.flags.status, c.flags.knowledge] },
            build: c => (c.flags.status && c.flags.knowledge ? KNOWLEDGE_GUIDANCE : ''),
        },
    ];
}
