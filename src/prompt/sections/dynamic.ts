// 动态段：子代理委派 / 记忆提示。
//
// #163 D1c（PR-08）后本文件**不再有 runtime 通道段**：
// - `core:time` 已删除：它每轮按 Date.now() 重建，是请求体末尾的必然违约点。
//   时间改由 D4 的 `kind:'time'` 注入块（>1h gap）+ `get_time` 工具提供。
// - `core:memory` 已删除：长期记忆改由 D3 的 `kind:'memory'` 注入块承载，
//   记忆检索/嵌入的每轮开销随之消失；`src/prompt/memory_source.ts` 端口保留给 memory provider。
// - `tool:mcp-instructions` 已删除（见 mcp.ts）：MCP 说明改由 `kind:'mcp'` 注入块承载。
import { DELEGATION_GUIDE } from '../../subagent/limits';
import { MEMORY_HINT } from '../texts/en';
import type { PromptSection } from '../types';

export function registerDynamicSections(): PromptSection[] {
    return [
        {
            name: 'core:delegation',
            order: 800,
            channel: 'system',
            maxChars: 1200,
            // 常驻常量（#163 REQ-D1-09）：不按 c.tool('subagent'/'subagent_fork') 门控
            cache: { deps: () => [] },
            build: () => DELEGATION_GUIDE,
        },
        {
            name: 'core:memory-hint',
            order: 910,
            // 内容本就是常量（en.ts 的 MEMORY_HINT），放 system 才进稳定前缀（#163 REQ-D1-06）。
            // 只有「记忆总开关」这一配置项能改变它 ⇒ 切换配置属 allowed rebase。
            channel: 'system',
            cache: { deps: c => [c.flags.memory] },
            build: c => (c.flags.memory ? MEMORY_HINT : ''),
        },
    ];
}
