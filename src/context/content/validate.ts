// 内容 AST 自检与防注入策略。
// - validatePart / validateParts：检查 Part 结构是否满足"内部严格"（唯一形状、必填字段、无破坏性字符）；
// - checkRoundTrip：INV-O（parse(renderText(part)) == part，unknown 允许降级为 text）；
// - neutraliseExternalText / isExternalSafeParts：外部数据（工具结果/用户输入/编辑写入）防注入口径。
import type { Part } from "../events";

import { sanitizeTagValue } from "./descriptors";
import { renderPartText, renderText } from "./render";
import { parseText } from "./text_parse";

/** 单个 Part 的结构问题列表（空数组 = 合法） */
export function validatePart(part: unknown): string[] {
    if (!part || typeof part !== 'object') return ['part 不是对象'];
    const value = part as Part;
    if (typeof value.type !== 'string') return ['part.type 不是字符串'];
    switch (value.type) {
        case 'text':
            return typeof value.text === 'string' ? [] : ['text.text 必须是字符串'];
        case 'mention':
            if (typeof value.id !== 'string' || !value.id) return ['mention.id 不能为空'];
            if (value.all !== undefined && value.all !== true) return ['mention.all 只能为 true'];
            return [];
        case 'quote':
            return typeof value.id === 'string' && value.id ? [] : ['quote.id 不能为空'];
        case 'image': {
            const issues: string[] = [];
            if (typeof value.ref !== 'string' || !value.ref) issues.push('image.ref 不能为空');
            if (value.desc !== undefined) {
                if (typeof value.desc !== 'string') issues.push('image.desc 必须是字符串');
                else if (/[\]\r\n]/.test(value.desc)) issues.push('image.desc 不能含 ] 或换行（需先 sanitize）');
            }
            return issues;
        }
        case 'avatar':
            return typeof value.uid === 'string' && value.uid ? [] : ['avatar.uid 不能为空'];
        case 'group_avatar':
            return typeof value.gid === 'string' && value.gid ? [] : ['group_avatar.gid 不能为空'];
        case 'record':
        case 'video':
        case 'file': {
            const issues: string[] = [];
            if (typeof value.handle !== 'string' || !value.handle) issues.push(`${value.type}.handle 不能为空`);
            if (value.summary !== undefined && typeof value.summary !== 'string') issues.push(`${value.type}.summary 必须是字符串`);
            return issues;
        }
        case 'face':
            return typeof value.name === 'string' && value.name ? [] : ['face.name 不能为空'];
        case 'poke':
            return typeof value.id === 'string' && value.id ? [] : ['poke.id 不能为空'];
        case 'forward':
            return typeof value.id === 'string' && value.id ? [] : ['forward.id 不能为空'];
        case 'markdown':
            return typeof value.text === 'string' ? [] : ['markdown.text 必须是字符串'];
        case 'resource':
            return typeof value.uri === 'string' && value.uri ? [] : ['resource.uri 不能为空'];
        case 'unknown':
            if (typeof value.tag !== 'string' || !value.tag) return ['unknown.tag 不能为空'];
            return typeof value.content === 'string' ? [] : ['unknown.content 必须是字符串'];
        default:
            return [`未知 Part 类型: ${String((value as { type?: unknown }).type)}`];
    }
}

export interface PartRoundTripFailure {
    index: number;
    part: Part;
    parsed: Part[];
    reason: string;
}

export interface RoundTripResult {
    ok: boolean;
    failures: PartRoundTripFailure[];
}

function stableJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** 把 Part 归一成固定字段顺序，避免对象键顺序影响往返比较 */
function canonicalPart(part: Part | undefined): Record<string, unknown> | undefined {
    if (!part) return undefined;
    switch (part.type) {
        case 'text':
            return { type: part.type, text: part.text };
        case 'mention':
            return part.all ? { type: part.type, id: part.id, all: true } : { type: part.type, id: part.id };
        case 'quote':
            return { type: part.type, id: part.id };
        case 'image':
            return part.desc !== undefined
                ? { type: part.type, ref: part.ref, desc: part.desc }
                : { type: part.type, ref: part.ref };
        case 'avatar':
            return { type: part.type, uid: part.uid };
        case 'group_avatar':
            return { type: part.type, gid: part.gid };
        case 'record':
        case 'video':
        case 'file':
            return part.summary !== undefined
                ? { type: part.type, handle: part.handle, summary: part.summary }
                : { type: part.type, handle: part.handle };
        case 'face':
            return { type: part.type, name: part.name };
        case 'poke':
            return { type: part.type, id: part.id };
        case 'forward':
            return { type: part.type, id: part.id };
        case 'markdown':
            return { type: part.type, text: part.text };
        case 'resource': {
            const out: Record<string, unknown> = { type: part.type, uri: part.uri };
            if (part.name !== undefined) out.name = part.name;
            if (part.mime !== undefined) out.mime = part.mime;
            return out;
        }
        case 'unknown':
            return { type: part.type, tag: part.tag, content: part.content };
        default:
            return part as unknown as Record<string, unknown>;
    }
}

function samePart(a: Part, b: Part): boolean {
    return stableJson(canonicalPart(a)) === stableJson(canonicalPart(b));
}

/**
 * 单个 Part 的往返自检：renderText → parseText(model-output)。
 * unknown 按设计允许降级：只要解析结果里仍能找到原 content 文本即视为通过（内容不丢）。
 */
export function roundTripPart(part: Part): { ok: boolean; parsed: Part[]; reason: string } {
    const text = renderPartText(part);
    const parsed = parseText(text, 'model-output');
    if (part.type === 'unknown') {
        const found = parsed.some(p => (p.type === 'text' && p.text.includes(part.content)) || (p.type === 'unknown' && p.content === part.content));
        return { ok: found, parsed, reason: found ? '' : 'unknown 内容在往返后丢失' };
    }
    // text part 的解析结果可能只有一个 text part；其余类型要求逐字段一致
    if (parsed.length === 1 && samePart(parsed[0], part)) return { ok: true, parsed, reason: '' };
    if (parsed.length === 1 && parsed[0].type === 'text' && part.type === 'text' && parsed[0].text === part.text) {
        return { ok: true, parsed, reason: '' };
    }
    return { ok: false, parsed, reason: `往返不一致：render=${text}` };
}

/** 批量往返自检（INV-O）；text 合并会改变分段，故按"渲染文本等价"再兜底比较 */
export function checkRoundTrip(parts: Part[]): RoundTripResult {
    const failures: PartRoundTripFailure[] = [];
    parts.forEach((part, index) => {
        const result = roundTripPart(part);
        if (!result.ok) {
            // 兜底：若逐段往返失败但整段渲染文本可稳定往返，则视为可接受（相邻 text 会被合并）
            if (part.type === 'text') {
                const whole = renderText(parts);
                const reparsed = parseText(whole, 'model-output');
                if (renderText(reparsed) === whole) return;
            }
            failures.push({ index, part, parsed: result.parsed, reason: result.reason });
        }
    });
    return { ok: failures.length === 0, failures };
}

/** 把外部数据（工具结果/用户输入/编辑）里的标签转义为字面量后的规范文本 */
export function neutraliseExternalText(text: string): string {
    return renderText(parseText(String(text ?? ''), 'external'));
}

/** 外部数据解析结果的安全检查：只允许 text/媒体 part，不允许可发送交互 part */
export function isExternalSafeParts(parts: Part[]): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    parts.forEach((part, index) => {
        switch (part.type) {
            case 'text':
            case 'image':
            case 'avatar':
            case 'group_avatar':
            case 'record':
            case 'video':
            case 'file':
            case 'markdown':
            case 'resource':
            case 'unknown':
                break;
            case 'mention':
            case 'poke':
            case 'quote':
            case 'face':
            case 'forward':
                violations.push(`第 ${index} 项为可发送/上下文标签（${part.type}），外部数据不应直接产生该 Part`);
                break;
            default:
                violations.push(`第 ${index} 项类型未登记`);
        }
    });
    return { ok: violations.length === 0, violations };
}

/** 内部标签（from/msg_id/system/time/tool_result）不得出现在 Part 文本里；返回命中列表 */
export function findInternalTagLeaks(parts: Part[]): string[] {
    const leaks: string[] = [];
    const internalRe = /(?:\[|［)(?:\/?)(?:from|msg_id|system|time|tool_result)[:：\]]/i;
    for (const part of parts) {
        const text = part.type === 'text' ? part.text : part.type === 'markdown' ? part.text : '';
        if (text && internalRe.test(text)) leaks.push(`Part 文本含内部标签：${text.slice(0, 80)}`);
    }
    return leaks;
}

/** 汇总检查：结构 + 往返 + 内部标签泄漏 */
export function validateParts(parts: Part[]): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    parts.forEach((part, index) => {
        for (const issue of validatePart(part)) issues.push(`[${index}] ${issue}`);
    });
    const leak = findInternalTagLeaks(parts);
    issues.push(...leak);
    const trip = checkRoundTrip(parts);
    for (const failure of trip.failures) issues.push(`[${failure.index}] ${failure.reason}`);
    return { ok: issues.length === 0, issues };
}

/** 便捷：断言字段已按规范清洗（供构造 Part 的代码/迁移使用） */
export function sanitized(value: unknown): string {
    return sanitizeTagValue(value);
}
