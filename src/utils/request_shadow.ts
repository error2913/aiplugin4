// 请求体影子对比（utils 层）：旧 RequestMessage 与 v2 compileRequest 输出的规范化逐行比较。
// 放在 utils 是为了让 utils/message 能调用而不反向依赖 context 领域层。
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

let requestShadowEnabled = false;
let requestV2Enabled = false;
let lastRequestShadowReport: ShadowReport | null = null;

export function setRequestShadowEnabled(value: boolean): void {
    requestShadowEnabled = value;
}

export function isRequestShadowEnabled(): boolean {
    return requestShadowEnabled;
}

export function setRequestV2Enabled(value: boolean): void {
    requestV2Enabled = value;
}

export function isRequestV2Enabled(): boolean {
    return requestV2Enabled;
}

export function recordRequestShadowReport(report: ShadowReport): void {
    lastRequestShadowReport = report;
}

export function getLastRequestShadowReport(): ShadowReport | null {
    return lastRequestShadowReport;
}

export function clearRequestShadowReport(): void {
    lastRequestShadowReport = null;
}

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
