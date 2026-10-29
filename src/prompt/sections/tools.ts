// 工具与能力段：工具获取/调用格式 + 按工具可见性门控的指导段
import Tool from '../../tool/tool';
import type { ToolInfo } from '../../tool/types';
import {
    COMMANDS_GUIDANCE,
    IMAGE_TOOLS_GUIDANCE,
    OB11_GUIDANCE,
    READ_RAW_GUIDANCE,
    RESOLVE_CONTEXT_GUIDANCE,
    RESOURCES_GUIDANCE,
    TOOL_ACCESS,
    toolCallFormat,
} from '../texts/en';
import type { PromptSection } from '../types';

/** 元工具参数（提示词工程模式使用；参数 JSON 直接展示） */
function formatMetaTools(infos: ToolInfo[]): Array<{ name: string; description: string; parameters: unknown }> {
    return infos.map(info => ({
        name: info.function.name,
        description: String(info.function.description || ''),
        parameters: info.function.parameters ?? { type: 'object', properties: {} },
    }));
}

export function registerToolSections(): PromptSection[] {
    return [
        {
            name: 'tool:image',
            order: 210,
            channel: 'system',
            maxChars: 1200,
            cache: {
                deps: c => [c.tool('image_view'), c.tool('image_to_text')],
            },
            build: c => (c.tool('image_view') || c.tool('image_to_text') ? IMAGE_TOOLS_GUIDANCE : ''),
        },
        {
            name: 'tool:ob11',
            order: 310,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: c => [c.tool('call_ob11_api')] },
            build: c => (c.tool('call_ob11_api') ? OB11_GUIDANCE : ''),
        },
        {
            name: 'core:tool-access',
            order: 500,
            channel: 'system',
            maxChars: 1500,
            cache: { deps: c => [c.flags.status, c.flags.promptEngineering, c.platform] },
            build: c => (c.flags.status && !c.flags.promptEngineering ? TOOL_ACCESS : ''),
        },
        {
            name: 'core:tool-call-format',
            order: 510,
            channel: 'system',
            maxChars: 6000,
            cache: {
                deps: c => {
                    const infos: ToolInfo[] = c.flags.status && c.flags.promptEngineering
                        ? Tool.getMetaToolInfos(c.session, c.platform)
                        : [];
                    return [c.flags.status, c.flags.promptEngineering, infos.map(info => info.function.name).join(',')];
                },
            },
            build: c => {
                if (!c.flags.status || !c.flags.promptEngineering) return '';
                return toolCallFormat(formatMetaTools(Tool.getMetaToolInfos(c.session, c.platform)));
            },
        },
        {
            name: 'tool:read-raw',
            order: 520,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: c => [c.tool('read_raw'), c.tool('grep_raw')] },
            build: c => (c.tool('read_raw') || c.tool('grep_raw') ? READ_RAW_GUIDANCE : ''),
        },
        {
            name: 'tool:resolve-context',
            order: 525,
            channel: 'system',
            maxChars: 900,
            cache: { deps: c => [c.tool('resolve_context_ref')] },
            build: c => (c.tool('resolve_context_ref') ? RESOLVE_CONTEXT_GUIDANCE : ''),
        },
        {
            name: 'tool:resources',
            order: 530,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: c => [c.tool('resolve_special_id'), c.tool('list_resources')] },
            build: c => (c.tool('resolve_special_id') || c.tool('list_resources') ? RESOURCES_GUIDANCE : ''),
        },
        {
            name: 'tool:commands',
            order: 540,
            channel: 'system',
            maxChars: 1200,
            cache: { deps: c => [c.tool('run_core_command'), c.tool('run_ext_command')] },
            build: c => (c.tool('run_core_command') || c.tool('run_ext_command') ? COMMANDS_GUIDANCE : ''),
        },
    ];
}
