// 可观测性：一次 Agent.run 的观测上下文（runId/轮次/工具调用/耗时）
import { generateId } from "../utils/utils";

export interface ToolCallEvent {
    name: string;
    durationMs: number;
    ok: boolean;
    error?: string;
}

export class AgentRunContext {
    readonly runId: string;
    turns: number;
    toolCalls: number;
    toolEvents: ToolCallEvent[];
    startedAt: number;

    constructor() {
        this.runId = generateId();
        this.turns = 0;
        this.toolCalls = 0;
        this.toolEvents = [];
        this.startedAt = Date.now();
    }

    beginTurn() {
        this.turns++;
    }

    recordToolCall(name: string, durationMs: number, ok: boolean, error?: string) {
        this.toolCalls++;
        this.toolEvents.push({ name, durationMs, ok, error });
    }

    summary(): string {
        const cost = Date.now() - this.startedAt;
        const failed = this.toolEvents.filter(e => !e.ok).length;
        return `run=${this.runId} turns=${this.turns} toolCalls=${this.toolCalls} failed=${failed} cost=${cost}ms`;
    }
}
