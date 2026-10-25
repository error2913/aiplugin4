// spawn / fork provider 工厂（≈ dsh-subagent-spawn-in-process / fork-in-process）。
// 实际 child 运行（模型请求/工具执行）由对接层 executor 提供；本层只固定 provider 语义：
// - spawn：inheritsParentContext=false，全新上下文
// - fork：inheritsParentContext=true，prepareContinuable 可给出 seed（由 executor 实现）
// seed 切点规则（rules.completedTurnPrefixCount）由 executor 在取父消息时使用，保持单点口径。
import type { SubAgentProvider } from './types';

export interface SubAgentExecutor {
    /** 前台运行一个 child；req 已含 parent/深度等，seed 已由 executor 按需计算 */
    start(req: Parameters<SubAgentProvider['start']>[0]): ReturnType<SubAgentProvider['start']>;
    /** continuable：返回可持久化的 seed 信息（executor 实现） */
    prepareContinuable?(req: Parameters<NonNullable<SubAgentProvider['prepareContinuable']>>[0]):
        ReturnType<NonNullable<SubAgentProvider['prepareContinuable']>>;
}

export function createSpawnProvider(name: string, executor: SubAgentExecutor): SubAgentProvider {
    return {
        name,
        inheritsParentContext: false,
        start: executor.start.bind(executor),
        ...(executor.prepareContinuable ? { prepareContinuable: executor.prepareContinuable.bind(executor) } : {}),
    };
}

export function createForkProvider(name: string, executor: SubAgentExecutor): SubAgentProvider {
    return {
        name,
        inheritsParentContext: true,
        start: executor.start.bind(executor),
        ...(executor.prepareContinuable ? { prepareContinuable: executor.prepareContinuable.bind(executor) } : {}),
    };
}
