// 子代理纯规则函数：停止原因→文本、深度判定、工具面合并、fork seed 切点、notice 文案。
// 全部为纯函数，便于单测；运行循环与工具层只调用这些规则，保证口径单点。
import type {
    SubAgentResult,
    SubAgentStopReason,
    ToolFilter,
    ToolState,
} from './types';

/** 终态原因：child 激活彻底结束，不可续跑 */
export const TERMINAL_REASONS: ReadonlySet<SubAgentStopReason> = new Set<SubAgentStopReason>([
    'completed',
    'error',
    'max-tokens',
    'refusal',
    'timeout',
]);

/** DSH 停止原因→错误头条映射（结算唯一口径） */
export const STOP_REASON_HEADLINE: Record<SubAgentStopReason, string> = {
    completed: '',
    aborted: 'subagent run was cancelled',
    error: 'subagent run failed',
    'max-tokens': 'subagent run hit its token limit before finishing',
    refusal: 'subagent declined the task',
    timeout: 'subagent run timed out',
};

export function isTerminal(reason: SubAgentStopReason): boolean {
    return TERMINAL_REASONS.has(reason);
}

/**
 * 非 completed 结果 → 错误文本：头条 + diagnostic + 部分输出（DSH §3.4 口径）。
 * completed 返回空字符串（由调用方走正常文本路径）。
 */
export function resultErrorText(result: SubAgentResult): string {
    if (result.stopReason === 'completed') return '';
    const headline = STOP_REASON_HEADLINE[result.stopReason];
    let text = headline;
    if (result.diagnostic !== undefined && result.diagnostic !== '') {
        text += `\nDiagnostic: ${result.diagnostic}`;
    }
    if (result.output !== undefined && result.output !== '') {
        text += `\nPartial output before the run ended:\n${result.output}`;
    }
    return text;
}

/**
 * settle/notice 文案：后台任务结束投给父会话的一段文本。
 * 对接层负责加 [system:…]/[/system] 边界与标签剥离。
 */
export function settleNoticeText(childId: string, label: string, result: SubAgentResult, maxLen = 2000): string {
    const head = result.stopReason === 'completed' ? '已完成' : `已结束（${result.stopReason}）`;
    let text = `子代理 ${childId}（${label}）${head}`;
    if (result.stopReason === 'completed') {
        text += `\n结论：${result.output}`;
    } else {
        const err = resultErrorText(result);
        if (err !== '') text += `\n${err}`;
    }
    return text.length > maxLen ? text.slice(0, maxLen) + '…（已截断，可用 read_raw 查阅）' : text;
}

/**
 * 委派深度判定：允许委派当且仅当 maxDepth 未配置或 >0 且父深度 < maxDepth。
 * maxDepth 语义对齐 DSH：0=禁委派；默认 3。
 */
export function delegationAllowed(parentDepth: number, maxDepth: number | undefined): boolean {
    if (maxDepth === undefined) return true;
    if (maxDepth <= 0) return false;
    return parentDepth < maxDepth;
}

/**
 * 工具面合并（全量继承口径）：
 * 以父会话 toolState 快照为底 → allow（若配置）只保留列表内 → deny 优先剔除。
 * 返回新对象，不改动入参。
 */
export function mergeToolFilter(parentToolState: ToolState, filter: ToolFilter | null | undefined): ToolState {
    const out: ToolState = {};
    const allow = filter?.allow;
    const deny = filter?.deny;
    for (const key of Object.keys(parentToolState)) {
        if (deny && deny.includes(key)) continue;
        if (allow && !allow.includes(key)) continue;
        out[key] = parentToolState[key];
    }
    return out;
}

/**
 * 结构化最小消息（与 src/context 消息形态兼容，避免运行循环直接耦合 Context 类型）。
 * toolCalls / tool_calls 二者其一存在即视为“工具轮”。
 */
export interface MsgLike {
    role: string;
    toolCalls?: Array<unknown> | null;
    tool_calls?: Array<unknown> | null;
}

/**
 * fork seed 切点：最近一条含 toolCalls 的 assistant 消息之前的连续前缀长度。
 * 无工具轮 → 全量（返回 msgs.length）；当前在飞工具链必在切点后，不参与回放。
 * 与 DSH“最近 turn/end 前缀”等价（docs/12 §4.2）。
 */
export function completedTurnPrefixCount(msgs: readonly MsgLike[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== 'assistant') continue;
        if ((m.toolCalls !== undefined && m.toolCalls !== null && m.toolCalls.length > 0)
            || (m.tool_calls !== undefined && m.tool_calls !== null && m.tool_calls.length > 0)) {
            return i;
        }
    }
    return msgs.length;
}

/** child 命名：sub:<父会话>:<序号>（父会话可含 ':'，只取末段无妨；ID 本身不参与解析） */
export function childIdFor(parentSessionId: string, seq: number): string {
    return `sub:${parentSessionId}:${seq}`;
}
