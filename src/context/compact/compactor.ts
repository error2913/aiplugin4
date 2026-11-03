// 上下文摘要的共享纯工具（v7 单一路径：ArchiveController）。
//
// 历史：v6 的 compactOnce/CompactionRuntime 已删除（双流水线并存不利于维护）；
// 这里只保留「把一批单元渲染成摘要输入文本」与「两阶段草稿」的数据结构，供归档控制器使用。
import { SUMMARY_MAX_CHARS } from "../../utils/context_limits";
import { SUMMARY_TRUNCATE_MARK, SYSTEM_NAME } from "../../utils/protocol";
import { toLLMText } from "../content/llm";
import type { ConversationEvent } from "../events";
import { applyEdit, RecordIndex } from "../view/records";
import { ConversationUnit } from "../view/units";

/** 摘要文本默认硬上限（字符）：与编译注入端共用同一常量，避免生成端/注入端口径漂移 */
export const DEFAULT_SUMMARY_MAX_CHARS = SUMMARY_MAX_CHARS;
export { SUMMARY_TRUNCATE_MARK };

/** 归档段 facts 写库所需的定位信息 */
export interface ArchiveFactsInfo {
    epoch: number;
    fromSeq: number;
    toSeq: number;
}

/** 归档段的两阶段草稿（持久化在 session_runtime 的 storage key 里） */
export interface ArchiveDraft {
    info: ArchiveFactsInfo;
    summaryText: string;
    recordId: string;
    at: number;
    fromAt?: number;
    toAt?: number;
    unsummarizedTokens: number;
    facts: unknown[];
    applied: boolean;
}

function renderEventText(event: ConversationEvent, index: RecordIndex): string {
    // 工具结果不进摘要正文：只给元信息 + read_raw 指针（正文可由 read_raw/grep_raw 回查）。
    // 理由：超长工具输出若整段进入摘要输入，会挤占批次预算并被二次加工；而消费该结果的
    // assistant 回复本身会被正常摘要，结论不会丢。
    if (event.kind === 'tool_result') {
        const text = toLLMText(applyEdit(event, index), { vision: false });
        const name = event.name || event.callId || 'tool';
        return `[tool result ${name}] ${text.length} chars; read_raw id=e:${event.seq}`;
    }
    if (event.kind === 'tool_call') {
        const name = event.name || event.callId || 'tool';
        const args = String(event.args || '');
        return `[tool call ${name}] args ${args.length} chars`;
    }
    const text = toLLMText(applyEdit(event, index), { vision: false });
    switch (event.kind) {
        case 'user':
            return `[user ${event.uid || '?'} @${event.at}] ${text}`;
        case 'assistant':
            return `[AI @${event.at}] ${text}`;
        case 'event':
            return `[event ${event.systemName || SYSTEM_NAME.event}] ${text}`;
        default:
            return text;
    }
}

/** 单元 → 摘要输入文本（不依赖 renderer 的消息格式；带说话者/时间/工具名，供摘要器理解） */
function renderUnitText(unit: ConversationUnit, index: RecordIndex): string {
    const lines: string[] = [];
    for (const event of unit.events) lines.push(renderEventText(event, index));
    if (unit.kind === 'tool_group' && !unit.complete && unit.missingCallIds && unit.missingCallIds.length > 0) {
        lines.push(`[unfinished tool calls: ${unit.missingCallIds.join(', ')}]`);
    }
    return lines.join('\n');
}

/** 一组单元 → 段文本（单元之间空行分隔） */
export function renderUnitsText(units: readonly ConversationUnit[], index: RecordIndex): string {
    return units.map(unit => renderUnitText(unit, index)).join('\n\n');
}
