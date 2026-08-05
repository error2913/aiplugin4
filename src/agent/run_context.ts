// 可观测性：一次 Agent.run 的观测上下文（runId/轮次/工具调用/耗时）
import { generateId } from "../utils/utils";

export class AgentRunContext {
    readonly runId: string;
    turns: number;
    toolCalls: number;
    startedAt: number;

    constructor() {
        this.runId = generateId();
        this.turns = 0;
        this.toolCalls = 0;
        this.startedAt = Date.now();
    }

    beginTurn() {
        this.turns++;
    }

    recordToolCall() {
        this.toolCalls++;
    }

    summary(): string {
        const cost = Date.now() - this.startedAt;
        return `run=${this.runId} turns=${this.turns} toolCalls=${this.toolCalls} cost=${cost}ms`;
    }
}
