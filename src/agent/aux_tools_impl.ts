// 辅助工具装配（L3）：把各来源适配器注册进 L0 注册表。
// 由组合根在「工具注册之后、提示词段注册之前」调用（方案 M2 装配）；重复调用幂等（force=true 可重装）。
// 只依赖 config/tool/resource + adapters，不 import prompt（deps 规则：agent 层不反向依赖 prompt 运行时）。
import Config from '../config/config';
import { auxRegistry } from '../core/ports/aux_tools';

import { createBuiltinAdapter } from './adapters/builtin';
import { createGenericMcpAdapter } from './adapters/generic_mcp';
import { createImageHostAdapter, shouldRegisterImageHost } from './adapters/image_host';
import { createResourceAdapter } from './adapters/resource';

/** 是否已安装（幂等标记；MCP 热同步不需要重装，适配器每次动态读快照） */
let installed = false;

/** 资源清单注入开关（默认关）：读配置失败按关处理，避免提示词装配因配置未注册而崩 */
function resourcePromptEnabled(): boolean {
    try {
        return !!(Config as unknown as { resource?: { RESOURCE_LIBRARY?: boolean } }).resource?.RESOURCE_LIBRARY;
    } catch {
        return false;
    }
}

/**
 * 注册全部适配器：
 * - builtin：始终注册（摘要工具默认关，由 aux_agent_impl 读「启用摘要智能体工具」决定是否下发）；
 * - resource：资源清单注入开关开 **且** 确有内置图片/本地资源时注册（默认关 = 与旧版一致）；
 * - image-host：后端图床已配置 **或** 存在 image-host capability 的 MCP 时注册（图床段默认开）；
 * - mcp-generic：默认不选任何服务器（M2 装配时传用户勾选；本层不替用户开口子）。
 */
export function installAuxTools(force = false): void {
    if (installed && !force) return;
    auxRegistry.clear();
    auxRegistry.register(createBuiltinAdapter());

    if (resourcePromptEnabled()) {
        const resource = createResourceAdapter();
        // 无内容时注册会让 hasSnippet('resource') 恒 false，但空适配器只是噪音；这里按方案 §10.4 条件注册
        if (resource.snippet()) auxRegistry.register(resource);
    }

    if (shouldRegisterImageHost()) {
        auxRegistry.register(createImageHostAdapter());
    }

    auxRegistry.register(createGenericMcpAdapter({ servers: [] }));
    installed = true;
}

/** 测试/重载用：清空注册表并复位安装标记（生产由组合根在重载时调用） */
export function resetAuxToolsForTest(): void {
    auxRegistry.clear();
    installed = false;
}

/** 当前是否已安装（诊断用） */
export function isAuxToolsInstalled(): boolean {
    return installed;
}
