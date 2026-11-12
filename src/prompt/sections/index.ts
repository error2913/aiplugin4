// 内置段注册入口：bootstrap 时调用一次（registerAllTools 之后）。
//
// #163 改造后，本目录下**所有** channel='system' 的段都是常量或只依赖配置快照：
// 不再读 aux 注册表、不再枚举会话工具/技能/知识库、不再写时间戳。
// #163 D1c（PR-08）起内置 runtime 段数 = 0（core:time / core:memory / tool:mcp-instructions 全删）。
import { registerPromptSections } from '../registry';

import { registerCapabilitySections } from './capabilities';
import { registerCoreGeneralSections } from './core_general';
import { registerDynamicSections } from './dynamic';
import { registerImageHostSections } from './image_host';
import { registerResourceSections } from './resources';
import { registerDiscoverySections, registerToolSections } from './tools';

/** 注册全部内置段（幂等：重复注册会抛重名错误，测试/重载前需 resetPromptSections）。 */
export function registerBuiltinSections(): void {
    registerPromptSections([
        ...registerCoreGeneralSections(),
        ...registerCapabilitySections(),
        ...registerToolSections(),
        // 技能/知识库常量说明（order 600/700）：原 skills_knowledge.ts 的清单枚举已废止
        ...registerDiscoverySections(),
        ...registerDynamicSections(),
        // tool:mcp-instructions 已删除：MCP instructions 改由 D3 的 kind:'mcp' 注入块承载
        ...registerResourceSections(),
        ...registerImageHostSections(),
    ]);
}
