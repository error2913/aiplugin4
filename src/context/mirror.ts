// 旧 Context 写入 → Context v2 的受控镜像（P2 切换前的影子路径）。
//
// 默认关闭（setV2MirrorEnabled(false)）：只有显式开启时才把旧写入同步成 v2 事件，
// 用于切换前对比/校验，不是生产双写方案；正式切换后旧 Context 写入会被移除。
import type { ToolCall, ToolContentPart } from "../tool/types";

import { parseText } from "./content/text_parse";
import { normalizeToolResult } from "./content/tool_result";
import type { Part } from "./events";
import type { ContextService } from "./service";

let enabled = false;

export function setV2MirrorEnabled(value: boolean): void {
    enabled = value;
}

export function isV2MirrorEnabled(): boolean {
    return enabled;
}

// 旧 Context 实例 → 镜像服务；用 WeakMap 避免进入序列化/持久化字段。
const attachedServices = new WeakMap<object, ContextService>();

export function attachV2Mirror(target: object, service: ContextService | null): void {
    if (service) attachedServices.set(target, service);
    else attachedServices.delete(target);
}

export function mirrorServiceFor(target: object): ContextService | null {
    return attachedServices.get(target) ?? null;
}

/** 只有显式开启且已挂载服务时才镜像 */
export function canMirror(target: object): boolean {
    return enabled && !!attachedServices.get(target);
}

function nowSec(at?: number): number {
    return Number.isFinite(at) ? Number(at) : Math.floor(Date.now() / 1000);
}

function safeParts(text: string, mode: 'user' | 'internal' | 'model-output'): Part[] {
    try {
        const parts = parseText(text, mode);
        if (parts.length > 0) return parts;
    } catch {
        // 解析失败保留纯文本，不丢内容
    }
    return text ? [{ type: 'text', text }] : [];
}

export function mirrorUser(service: ContextService, input: { uid: string; msgId: string; text: string; at?: number }): number[] {
    return service.appendUser(input.uid, input.msgId, safeParts(input.text, 'user'), { at: nowSec(input.at) });
}

export function mirrorAssistant(service: ContextService, input: { msgId: string; text: string; reasoning?: string; at?: number }): number[] {
    return service.appendAssistant(input.msgId, safeParts(input.text, 'model-output'), {
        at: nowSec(input.at),
        ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    });
}

export function mirrorSystem(service: ContextService, input: { text: string; systemName: string; eventType?: string; raw?: unknown; at?: number }): number[] {
    return service.appendSystem({
        systemName: input.systemName,
        eventType: input.eventType,
        raw: input.raw,
        parts: safeParts(input.text, 'internal'),
        at: nowSec(input.at),
    });
}

/** 把旧 ToolCall[] 镜像成 v2 tool_call 事件；返回 callId → 分组信息（供结果镜像配对） */
export function mirrorToolCalls(
    service: ContextService,
    input: { toolCalls: readonly ToolCall[]; reasoning?: string; turnId: string; at?: number },
): Map<string, { turnId: string; groupId: string }> {
    const map = new Map<string, { turnId: string; groupId: string }>();
    const at = nowSec(input.at);
    input.toolCalls.forEach((call, index) => {
        const callId = String(call.id ?? '');
        if (!callId) return;
        const groupId = `${input.turnId}:${index}`;
        const fn = call.function ?? { name: '', arguments: '{}' };
        service.appendToolCall({
            turnId: input.turnId,
            groupId,
            callId,
            name: String(fn.name ?? ''),
            args: String(fn.arguments ?? '{}'),
            ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
            at,
        });
        map.set(callId, { turnId: input.turnId, groupId });
    });
    return map;
}

export function mirrorToolResult(
    service: ContextService,
    input: {
        callId: string;
        toolName?: string;
        text: string;
        contentParts?: ToolContentPart[];
        group: { turnId: string; groupId: string } | null;
        at?: number;
    },
): number[] {
    let parts: Part[] = [];
    try {
        parts = normalizeToolResult(
            { text: input.text, contentParts: input.contentParts },
            { allowImageRefs: true, noteUnregisteredMedia: false },
        );
    } catch {
        parts = [];
    }
    if (parts.length === 0 && input.text) parts = safeParts(input.text, 'internal');
    return service.appendToolResult({
        turnId: input.group?.turnId ?? `orphan:${input.callId}`,
        groupId: input.group?.groupId ?? `orphan:${input.callId}`,
        callId: input.callId,
        name: input.toolName,
        parts,
        at: nowSec(input.at),
    });
}

/** 工具调用/结果的短期配对表（仅镜像用；不参与旧行为） */
export class MirrorToolGroups {
    private readonly map = new Map<string, { turnId: string; groupId: string }>();
    private turn = 0;

    nextTurnId(): string {
        this.turn++;
        return `mirror-t:${this.turn}`;
    }

    register(calls: Map<string, { turnId: string; groupId: string }>): void {
        for (const [callId, group] of calls) this.map.set(callId, group);
    }

    get(callId: string): { turnId: string; groupId: string } | null {
        return this.map.get(callId) ?? null;
    }
}
