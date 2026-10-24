// Context v2 门面：对外只暴露"会话上下文"这一件事。
// 上层（Session/Agent/命令/工具/子代理）通过这里写入、取投影、编译请求、召回、压缩；
// 不直接碰 store/page 细节。
import {
    CompactDeps,
    compactOnce,
    CompactOptions,
    CompactResult,
    shouldCompact,
} from "./compact/compactor";
import type { ConversationEvent, EventInput, Part, RecordEntry } from "./events";
import {
    assistantEventId,
    systemEventId,
    toolCallEventId,
    toolResultEventId,
    userEventId,
} from "./events";
import type { ContextHead } from "./head";
import { buildProjection, ProjectionOptions } from "./projection";
import { GrepOptions, grepRaw, GrepRawResult, readRaw, ReadRawOptions, ReadRawResult } from "./recall";
import { ContextSnapshot, ContextStore, ContextStoreOptions } from "./store";
import type { MessageType } from "./types";
import { CompileOptions, compileRequest, CompileResult } from "./view/compile";

export interface AppendMeta {
    at?: number;
    recvAt?: number;
    eventId?: string;
}

export type ContextServiceOptions = ContextStoreOptions;

export class ContextService {
    readonly sessionId: string;
    private readonly store: ContextStore;

    private constructor(sessionId: string, store: ContextStore) {
        this.sessionId = sessionId;
        this.store = store;
    }

    /** 打开会话：读 head/页/记录；不存在则返回空（迁移由调用方先做） */
    static async open(sessionId: string, options: ContextServiceOptions = {}): Promise<ContextService> {
        const store = await ContextStore.open(sessionId, options);
        return new ContextService(sessionId, store);
    }

    /** 同步打开：Session 恢复路径（存储读取本身是同步的） */
    static openSync(sessionId: string, options: ContextServiceOptions = {}): ContextService {
        return new ContextService(sessionId, ContextStore.openSync(sessionId, options));
    }

    getStore(): ContextStore {
        return this.store;
    }

    snapshot(): ContextSnapshot {
        return this.store.snapshot();
    }

    head(): Readonly<ContextHead> {
        return this.store.getHead();
    }

    /** 同步追加事件；返回采纳的 seq */
    appendUser(uid: string, msgId: string, parts: Part[], meta: AppendMeta & { origin?: 'self' } = {}): number[] {
        const input: EventInput = {
            kind: 'user',
            uid,
            msgId,
            parts,
            eventId: meta.eventId ?? userEventId(msgId, ''),
            at: meta.at,
            recvAt: meta.recvAt,
            ...(meta.origin ? { origin: meta.origin } : {}),
        };
        return this.store.append([input]);
    }

    appendAssistant(msgId: string, parts: Part[], meta: AppendMeta & { reasoning?: string } = {}): number[] {
        const input: EventInput = {
            kind: 'assistant',
            msgId,
            parts,
            eventId: meta.eventId ?? assistantEventId(msgId, ''),
            at: meta.at,
            recvAt: meta.recvAt,
            ...(meta.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
        };
        return this.store.append([input]);
    }

    appendToolCall(input: {
        turnId: string;
        groupId: string;
        callId: string;
        name: string;
        args: string;
        reasoning?: string;
        at?: number;
    }): number[] {
        return this.store.append([{
            kind: 'tool_call',
            turnId: input.turnId,
            groupId: input.groupId,
            callId: input.callId,
            name: input.name,
            args: input.args,
            eventId: toolCallEventId(input.groupId, input.callId),
            at: input.at,
            ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
        }]);
    }

    appendToolResult(input: {
        turnId: string;
        groupId: string;
        callId: string;
        name?: string;
        parts: Part[];
        at?: number;
    }): number[] {
        return this.store.append([{
            kind: 'tool_result',
            turnId: input.turnId,
            groupId: input.groupId,
            callId: input.callId,
            name: input.name,
            parts: input.parts,
            eventId: toolResultEventId(input.groupId, input.callId),
            at: input.at,
        }]);
    }

    appendSystem(input: {
        systemName: string;
        parts: Part[];
        eventType?: string;
        raw?: unknown;
        dedupKey?: string;
        at?: number;
    }): number[] {
        const eventId = input.dedupKey ? systemEventId(input.dedupKey, '') : undefined;
        return this.store.append([{
            kind: 'event',
            systemName: input.systemName,
            eventType: input.eventType,
            raw: input.raw,
            parts: input.parts,
            eventId,
            at: input.at,
        }]);
    }

    appendRecord(record: RecordEntry): void {
        this.store.appendRecord(record);
    }

    /** 旧消费者只读投影（有界、冻结） */
    projection(options: ProjectionOptions = {}): MessageType[] {
        return buildProjection(this.store.snapshot(), options);
    }

    /** 请求编译（prefix/预算/能力由调用方传入） */
    compile(options: Omit<CompileOptions, 'snapshot'>): CompileResult {
        return compileRequest({ ...options, snapshot: this.store.snapshot() });
    }

    readRaw(address: string, options: ReadRawOptions = {}): ReadRawResult {
        return readRaw(this.store, this.store.snapshot(), address, options);
    }

    /** 最近 N 条事件（记忆桥/调试用；只读） */
    readRecent(limit = 20): ConversationEvent[] {
        const n = Math.max(0, Math.floor(limit));
        return this.store.snapshot().events.slice(-Math.max(0, n));
    }

    /** 按 seq 区间读原文（记忆桥/审计用；分页参数同 read_raw） */
    readRange(fromSeq: number, toSeq: number, options: ReadRawOptions = {}): ReadRawResult {
        return this.readRaw(`e:${Math.max(1, Math.floor(fromSeq))}-${Math.max(1, Math.floor(toSeq))}`, options);
    }

    /**
     * 追加通知（上下文与记忆解耦的桥接点）：只通知，不等待、不阻塞写入。
     * listener 收到 seq > 订阅时水位 的新事件；记忆系统自己维护消费水位。
     */
    onAppended(listener: (batch: { events: ConversationEvent[]; cursor: number }) => void): () => void {
        let cursor = this.store.getHead().nextSeq - 1;
        return this.store.subscribe(snapshot => {
            const events = snapshot.events.filter(e => e.seq > cursor).sort((a, b) => a.seq - b.seq);
            if (events.length === 0) return;
            cursor = Math.max(...events.map(e => e.seq));
            try {
                listener({ events, cursor });
            } catch {
                // 订阅者异常不影响上下文写入
            }
        });
    }

    grep(pattern: string, options: GrepOptions = {}): GrepRawResult {
        return grepRaw(this.store, this.store.snapshot(), pattern, options);
    }

    /** 一次压缩；成功会写入内存记录，需 flush 持久化 */
    async compact(options: CompactOptions, deps: CompactDeps): Promise<CompactResult> {
        const result = await compactOnce({
            events: this.store.snapshot().events,
            records: this.store.snapshot().records,
            head: this.store.getHead(),
        }, options, deps);
        if (result.advanced && result.record) {
            this.store.commitSummary(result.record, result.through, result.unsummarizedTokens);
        }
        return result;
    }

    /** 是否达到压缩水位 */
    shouldCompact(watermarkTokens: number): boolean {
        return shouldCompact(this.store.getHead(), watermarkTokens);
    }

    async flush(): Promise<Awaited<ReturnType<ContextStore['flush']>>> {
        return this.store.flush();
    }

    /** 当前预览（调试/命令用；不落盘） */
    preview(count = 5): ConversationEvent[] {
        return this.store.snapshot().events.slice(-Math.max(0, count));
    }
}
