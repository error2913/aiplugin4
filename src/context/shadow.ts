// 影子对比：旧 Context.messages 与 v2 projection 的规范化逐行文本，用于切换前校验差异。
// 只做只读归一/比较，不修改任何数据。
import type { MessageType } from "./types";

export interface ShadowDiff {
    index: number;
    legacy: string | null;
    v2: string | null;
}

export interface ShadowReport {
    equal: boolean;
    legacyLines: number;
    v2Lines: number;
    diffs: ShadowDiff[];
}

function lineOfItem(item: Record<string, unknown>): string {
    const text = String(item.text ?? '');
    if (typeof item.systemName === 'string') return `system:${item.systemName}:${text}`;
    return `user:${text}`;
}

/** 旧 MessageType[] → 规范化行（仅比较展示文本/工具调用结构，忽略 rawText/时间戳） */
export function legacyLines(messages: readonly MessageType[]): string[] {
    const lines: string[] = [];
    for (const message of messages as unknown as Array<Record<string, unknown>>) {
        const role = String(message.role ?? '');
        const items = Array.isArray(message.contentItems) ? message.contentItems : [];
        if (role === 'user') {
            for (const item of items) lines.push(lineOfItem(item as Record<string, unknown>));
            continue;
        }
        if (role === 'assistant' && Array.isArray(message.toolCalls)) {
            for (const call of message.toolCalls as Array<Record<string, unknown>>) {
                const fn = call.function as { name?: unknown; arguments?: unknown } | undefined;
                lines.push(`tool_call:${String(call.id ?? '')}:${String(fn?.name ?? '')}:${String(fn?.arguments ?? '')}`);
            }
            continue;
        }
        if (role === 'assistant') {
            for (const item of items) lines.push(`assistant:${String((item as Record<string, unknown>).text ?? '')}`);
            continue;
        }
        if (role === 'tool') {
            lines.push(`tool:${String(message.toolCallId ?? '')}:${String(message.text ?? '')}`);
            continue;
        }
        if (role === 'system') {
            lines.push(`system:${String(message.content ?? '')}`);
            continue;
        }
        lines.push(`${role}:${JSON.stringify(message)}`);
    }
    return lines;
}

/** v2 projection（旧 MessageType 形状）→ 同一规范化行 */
export function projectionLines(projection: readonly MessageType[]): string[] {
    return legacyLines(projection);
}

/**
 * 逐行比较；index 为首次差异位置，之后最多保留 maxDiffs 条。
 * 行数不一致也算不等（多出的行 legacy/v2 字段为 null）。
 */
export function compareShadow(
    legacy: readonly MessageType[],
    projected: readonly MessageType[],
    options: { maxDiffs?: number } = {},
): ShadowReport {
    const a = legacyLines(legacy);
    const b = projectionLines(projected);
    const maxDiffs = Math.max(1, Math.floor(options.maxDiffs ?? 20));
    const diffs: ShadowDiff[] = [];
    const total = Math.max(a.length, b.length);
    for (let i = 0; i < total; i++) {
        const left = a[i] ?? null;
        const right = b[i] ?? null;
        if (left !== right) {
            diffs.push({ index: i, legacy: left, v2: right });
            if (diffs.length >= maxDiffs) break;
        }
    }
    return {
        equal: diffs.length === 0 && a.length === b.length,
        legacyLines: a.length,
        v2Lines: b.length,
        diffs,
    };
}

/** 人类可读差异报告（测试/日志用） */
export function formatShadowReport(report: ShadowReport): string {
    if (report.equal) return `shadow: 一致（${report.legacyLines}/${report.v2Lines} 行）`;
    const lines = [`shadow: 不一致（旧 ${report.legacyLines} 行 / v2 ${report.v2Lines} 行）`];
    for (const diff of report.diffs) {
        lines.push(`#${diff.index}`);
        lines.push(`  旧: ${diff.legacy ?? '<无>'}`);
        lines.push(`  v2: ${diff.v2 ?? '<无>'}`);
    }
    return lines.join('\n');
}

/** 请求消息内容 → 文本（保留图片块为占位标记） */
function requestContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(block => {
        if (!block || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') return b.text;
        if (b.type === 'image_url' || b.type === 'image') return '[image]';
        return '';
    }).join('');
}

/** 请求消息 → 规范化行（用于旧请求体与 compileRequest 的对比） */
export function requestLines(messages: readonly unknown[]): string[] {
    const lines: string[] = [];
    for (const raw of messages) {
        if (!raw || typeof raw !== 'object') continue;
        const message = raw as Record<string, unknown>;
        const role = String(message.role ?? '');
        let line = `${role}:${requestContentText(message.content)}`;
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of toolCalls as Array<Record<string, unknown>>) {
            const fn = call.function as { name?: unknown; arguments?: unknown } | undefined;
            line += `|tool_call:${String(call.id ?? '')}:${String(fn?.name ?? '')}:${String(fn?.arguments ?? '')}`;
        }
        if (message.tool_call_id !== undefined) line += `|tool_call_id:${String(message.tool_call_id)}`;
        if (message.reasoning_content !== undefined) line += `|reasoning:${String(message.reasoning_content)}`;
        lines.push(line);
    }
    return lines;
}

/** 比较旧请求体与 v2 compileRequest 输出（只读、逐行） */
export function compareRequests(
    legacy: readonly unknown[],
    compiled: readonly unknown[],
    options: { maxDiffs?: number } = {},
): ShadowReport {
    const a = requestLines(legacy);
    const b = requestLines(compiled);
    const maxDiffs = Math.max(1, Math.floor(options.maxDiffs ?? 20));
    const diffs: ShadowDiff[] = [];
    const total = Math.max(a.length, b.length);
    for (let i = 0; i < total; i++) {
        const left = a[i] ?? null;
        const right = b[i] ?? null;
        if (left !== right) {
            diffs.push({ index: i, legacy: left, v2: right });
            if (diffs.length >= maxDiffs) break;
        }
    }
    return {
        equal: diffs.length === 0 && a.length === b.length,
        legacyLines: a.length,
        v2Lines: b.length,
        diffs,
    };
}

export function formatRequestShadowReport(report: ShadowReport): string {
    return formatShadowReport(report).replace(/^shadow:/, 'request-shadow:');
}
