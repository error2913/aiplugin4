// Context v2 门面：对外只暴露"会话上下文"这一件事。
// 上层（Session/Agent/命令/工具/子代理）通过这里写入、取投影、编译请求、召回、压缩；
// 不直接碰 store/page 细节。
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
import { CompileOptions, compileRequest, CompileResult, CompileStats } from "./view/compile";

export interface AppendMeta {
    at?: number;
    recvAt?: number;
    eventId?: string;
}

export type ContextServiceOptions = ContextStoreOptions;

export class ContextService {
    readonly sessionId: string;
    private readonly store: ContextStore;
    /** 最近一次编译的统计（仅运行时状态，不持久化）：用于「预算到顶」触发压缩 */
    private lastCompileStats: CompileStats | null = null;
    /**
     * 「归档保留原文」配置提供者（装配层注入，避免 context 层 import config）。
     * 打开会话时若调用方未显式传 keepArchivedRaw，则向它取值。
     */
    private static archivedRawProvider: (() => boolean) | null = null;

    /** 装配层（index.ts）注入归档保留原文开关；不 import Config，避免跨层依赖 */
    static configureArchivedRetention(provider: () => boolean): void {
        ContextService.archivedRawProvider = provider;
    }

    private static resolveOptions(options: ContextServiceOptions): ContextServiceOptions {
        if (options.keepArchivedRaw !== undefined || !ContextService.archivedRawProvider) return options;
        let keepArchivedRaw = true;
        try { keepArchivedRaw = ContextService.archivedRawProvider() !== false; } catch { /* 配置不可用时按默认保留 */ }
        return { ...options, keepArchivedRaw };
    }

    private constructor(sessionId: string, store: ContextStore) {
        this.sessionId = sessionId;
        this.store = store;
    }

    /** 打开会话：读 head/页/记录；不存在则返回空（迁移由调用方先做） */
    static async open(sessionId: string, options: ContextServiceOptions = {}): Promise<ContextService> {
        const store = await ContextStore.open(sessionId, ContextService.resolveOptions(options));
        return new ContextService(sessionId, store);
    }

    /** 同步打开：Session 恢复路径（存储读取本身是同步的） */
    static openSync(sessionId: string, options: ContextServiceOptions = {}): ContextService {
        return new ContextService(sessionId, ContextStore.openSync(sessionId, ContextService.resolveOptions(options)));
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

    /** 提交归档水位（硬切/待机归档/总结完成共用）：只进不退，返回实际 archivedThrough */
    commitArchive(toSeq: number): number {
        return this.store.commitArchive(toSeq);
    }

    /** 提交滚动摘要（推进 summarizedThrough，并同步推进归档边界；由归档控制器调用） */
    commitSummary(record: RecordEntry, summarizedThrough: number, unsummarizedTokens: number): void {
        this.store.commitSummary(record, summarizedThrough, unsummarizedTokens);
    }

    /** 同步追加事件；返回采纳的 seq */
    appendUser(uid: string, msgId: string, parts: Part[], meta: AppendMeta & { origin?: 'self' } = {}): number[] {
        const input: EventInput = {
            kind: 'user',
            uid,
            msgId,
            parts,
            eventId: meta.eventId ?? (msgId ? userEventId(msgId, '') : undefined),
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
            eventId: meta.eventId ?? (msgId ? assistantEventId(msgId, '') : undefined),
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

    /**
     * 请求编译（prefix/预算/能力由调用方传入）。
     * `observe=false` 时不写最近编译统计：子代理 fork seed 等「只为取投影」的编译不能覆盖
     * 父/本会话的统计，否则轮末自动摘要会基于陈旧/无关的 omittedFromSeq 误触发。
     */
    compile(options: Omit<CompileOptions, 'snapshot'>, opts: { observe?: boolean } = {}): CompileResult {
        const result = compileRequest({ ...options, snapshot: this.store.snapshot() });
        if (opts.observe !== false) this.lastCompileStats = result.stats;
        return result;
    }

    /** 最近一次编译统计（触发「预算到顶」压缩用；重载后为 null） */
    lastCompile(): CompileStats | null {
        return this.lastCompileStats;
    }

    /** 清空编译统计（每轮 run 开始调用，防止上一轮/其他编译的陈旧统计误触发自动摘要） */
    resetLastCompile(): void {
        this.lastCompileStats = null;
    }

    readRaw(address: string, options: ReadRawOptions = {}): ReadRawResult {
        return readRaw(this.store, this.store.snapshot(), address, options);
    }

    /**
     * 最近 N 条事件（**调试/诊断专用**，方案 §11.2 A5：条数口径，不是「消息范围」）。
     * 生产路径已无调用（仅单测/诊断用）；消息范围统一走 projection（token 主口径）。
     * 保留签名以兼容既有诊断脚本/单测。
     */
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

    async flush(): Promise<Awaited<ReturnType<ContextStore['flush']>>> {
        return this.store.flush();
    }

    /**
     * 当前预览（**调试/命令专用**，方案 §11.2 B2：条数口径，不是「消息范围」）。
     * 不落盘、不参与 token 预算；如需范围请用 projection（token 主口径）。
     */
    preview(count = 5): ConversationEvent[] {
        return this.store.snapshot().events.slice(-Math.max(0, count));
    }
}
