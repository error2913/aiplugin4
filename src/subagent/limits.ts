// 子代理运行时决策纯函数：委派深度/工具禁用列表/委派指引节可见性。可单测。
export interface SubAgentSettings {
    enabled: boolean;
    maxDepth: number;
    denyTools: string[];
}

/**
 * 生效委派深度：主会话（depth 0）用配置值；子代理再委派默认关闭（0=禁止），
 * 避免“子代理的根归属无法从消息内解析”时把整棵树算错根（后续放开需补根透传）。
 */
export function effectiveMaxDepth(cfgMaxDepth: number, callerDepth: number): number {
    if (callerDepth === 0) {
        return cfgMaxDepth > 0 ? cfgMaxDepth : 0;
    }
    return 0;
}

/** 禁用名单清洗：去空、去重；无有效项返回 null（= 不设 deny，全量继承） */
export function effectiveDeny(denyTools: readonly string[]): string[] | null {
    const seen = new Set<string>();
    for (const raw of denyTools) {
        const t = (raw ?? '').trim();
        if (t !== '') seen.add(t);
    }
    return seen.size > 0 ? Array.from(seen) : null;
}

/** 委派指引文本（对齐 docs/03 子代理框架） */
export const DELEGATION_GUIDE = [
    '## Sub-agent delegation',
    '- Long independent work (research, summarization, rewriting, reading large content down to essentials) can be delegated to a sub-agent.',
    '- A spawn sub-agent cannot see this conversation\'s history: the task must be self-contained. A fork sub-agent sees completed turns but not the turn currently in flight.',
    '- Start independent tasks together in the same message when possible; a sub-agent returns only the final conclusion, so intermediate work does not consume this conversation\'s context.',
    '- Answer simple questions directly to avoid needless cost.',
].join('\n');

/** 当会话开启了任一委派工具时，指引节才可见 */
export function delegationGuideVisible(toolState: Record<string, boolean> | null | undefined): boolean {
    if (!toolState) return false;
    return toolState['subagent'] === true || toolState['subagent_fork'] === true;
}

/** 指引节内容：不可见返回空串 */
export function buildDelegationGuide(toolState: Record<string, boolean> | null | undefined): string {
    return delegationGuideVisible(toolState) ? DELEGATION_GUIDE : '';
}
