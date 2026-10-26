// P0 快照入口：用测试宿主装配出真实的 system/runtime 文本与段统计，供 scripts/prompt-snapshot.cjs 落盘对比。
import "./test-host";
// 副作用导入：注册默认 MemoryEngine 工厂（快照里尽量还原生产环境的记忆段）
import "../src/memory/v2";

import Config from "../src/config/config";
import { renderSectionTable } from "../src/prompt/assemble";
import { buildPromptParts } from "../src/prompt/builder";
import { registerAllTools } from "../src/tool/bootstrap";
import { toolMap } from "../src/tool/registry";

/** 真实会话的 toolState 由 Session getter 按配置填充；快照里按「全部工具开启」模拟上限场景 */
function allToolsEnabled(): Record<string, boolean> {
    const state: Record<string, boolean> = {};
    for (const name of Object.keys(toolMap)) state[name] = true;
    return state;
}

interface Scenario {
    name: string;
    isPrivate: boolean;
    sessionType: 'user' | 'group';
    sessionId: string;
    sessionName: string;
}

const SCENARIOS: Scenario[] = [
    { name: 'group', isPrivate: false, sessionType: 'group', sessionId: 'QQ-Group:1', sessionName: 'TestGroup' },
    { name: 'private', isPrivate: true, sessionType: 'user', sessionId: 'QQ:1', sessionName: 'Tester' },
];

export async function snapshot(): Promise<Array<{ scenario: string; system: string; runtime: string; table: string }>> {
    Config.registerConfig();
    registerAllTools();
    const out: Array<{ scenario: string; system: string; runtime: string; table: string }> = [];
    for (const scenario of SCENARIOS) {
        const ctx = {
            isPrivate: scenario.isPrivate,
            player: { name: scenario.sessionName, userId: scenario.sessionId },
            group: scenario.isPrivate ? undefined : { groupId: scenario.sessionId, groupName: scenario.sessionName },
            endPoint: { userId: 'QQ:10000' },
        } as any;
        const session = {
            sessionId: scenario.sessionId,
            sessionType: scenario.sessionType,
            toolState: allToolsEnabled(),
            skillState: {},
            kbState: {},
            memory: { persona: '' },
            context: { messages: [] },
            setting: null,
        } as any;
        const parts = await buildPromptParts(ctx, session);
        out.push({ scenario: scenario.name, system: parts.system, runtime: parts.runtime, table: renderSectionTable(parts) });
    }
    return out;
}
