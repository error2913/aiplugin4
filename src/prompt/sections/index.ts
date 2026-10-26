// 内置段注册入口：bootstrap 时调用一次（registerAllTools 之后）。
import { registerPromptSections } from '../registry';

import { registerCapabilitySections } from './capabilities';
import { registerCoreGeneralSections } from './core_general';
import { registerDynamicSections } from './dynamic';
import { registerMcpSections } from './mcp';
import { registerSkillKnowledgeSections } from './skills_knowledge';
import { registerToolSections } from './tools';

/** 注册全部内置段（幂等：重复注册会抛重名错误，测试/重载前需 resetPromptSections）。 */
export function registerBuiltinSections(): void {
    registerPromptSections([
        ...registerCoreGeneralSections(),
        ...registerCapabilitySections(),
        ...registerToolSections(),
        ...registerSkillKnowledgeSections(),
        ...registerDynamicSections(),
        ...registerMcpSections(),
    ]);
}
