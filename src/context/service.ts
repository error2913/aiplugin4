// Context v2 门面：对外只暴露"会话上下文"这一件事。
// 上层（Session/Agent/命令/工具/子代理）通过这里写入、取投影、编译请求、召回、压缩；
// 不直接碰 store/page 细节。
import { estimateTextTokens } from "../utils/token_estimate";

import type { ConversationEvent, EventInput, Part, QuoteDraft, RecordEntry } from "./events";
import {
    assistantEventId,
    systemEventId,
    toolCallEventId,
    toolResultEventId,
    userEventId,
} from "./events";
import type { ContextHead } from "./head";
import { clampAnchor, INJECTION_WRAP_TOKENS, injectionEventId } from "./injections";
import type { InjectionItem, InjectionMeta } from "./injections";
import { buildProjection, ProjectionOptions } from "./projection";
import { findEventByMsgId, GrepOptions, grepRaw, GrepRawResult, readRaw, ReadRawOptions, ReadRawResult } from "./recall";
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

    /**
     * 追加 user 事件。
     *
     * `meta.fromName`（#163 REQ-D2-04）：**写入时冻结**的显示名，随事件落盘，渲染层只读它。
     * 调用方（`Context.appendV2User`）负责取 `User.get(uid).userName` 快照；这里只透传，
     * 不做任何 IO —— 保持 service 层"纯写入"的性质，也避免在测试里需要 mock User。
     */
    appendUser(
        uid: string,
        msgId: string,
        parts: Part[],
        meta: AppendMeta & { origin?: 'self'; fromName?: string } = {},
    ): number[] {
        const input: EventInput = {
            kind: 'user',
            uid,
            msgId,
            parts,
            ...(meta.fromName ? { fromName: meta.fromName } : {}),
            eventId: meta.eventId ?? (msgId ? userEventId(msgId, '') : undefined),
            at: meta.at,
            recvAt: meta.recvAt,
            ...(meta.origin ? { origin: meta.origin } : {}),
        };
        return this.store.append([input]);
    }

    /**
     * 追加「引用事件 + 回复事件」（REQ-D6-04/06/07）：引用回复展开的唯一写入口。
     *
     * - 引用事件 eventId 固定 `q:<被引 msgId>`（不用 `userEventId`，避免与普通 user 事件 `u:<msgId>` 撞车）；
     * - 两条事件在**同一次** `store.append` 内连续分配 seq ⇒ seq 必然相邻（中间不可能插入并发收信事件）；
     * - 同一条被引消息第二次出现时（`hasEvent('q:<msgId>')` 为真）不再写引用事件，
     *   只在回复事件上带 `quoteOf` 指针（渲染层据此输出 `[quote_of:<msgId>]`）；
     * - 调用方负责 `parts` 的拷贝（两条事件不能共享同一 parts 数组引用）。
     */
    appendUserWithQuote(params: {
        uid: string;
        msgId: string;
        parts: Part[];
        meta?: AppendMeta & { quoteOf?: string; fromName?: string };
        quote?: QuoteDraft | null;
    }): { quoteAccepted: boolean } {
        const meta = params.meta ?? {};
        const userInput: EventInput = {
            kind: 'user',
            uid: params.uid,
            msgId: params.msgId,
            parts: params.parts,
            // #163 REQ-D2-04：回复事件同样冻结显示名（两处写入点都必须冻结，否则改名会改写已发送区）
            ...(meta.fromName ? { fromName: meta.fromName } : {}),
            eventId: meta.eventId ?? (params.msgId ? userEventId(params.msgId, '') : undefined),
            at: meta.at,
            recvAt: meta.recvAt,
            ...(meta.quoteOf ? { quoteOf: meta.quoteOf } : {}),
        };
        const quote = params.quote ?? null;
        if (!quote) {
            this.store.append([userInput]);
            return { quoteAccepted: false };
        }
        const quoteEventId = `q:${quote.msgId}`;
        if (this.store.hasEvent(quoteEventId)) {
            // 已展开过：不重复写引用事件（调用方一般已在 meta.quoteOf 带上指针）
            this.store.append([userInput]);
            return { quoteAccepted: false };
        }
        const quoteInput: EventInput = {
            kind: 'user',
            uid: quote.uid || 'unknown',
            msgId: quote.msgId,
            parts: quote.parts,
            eventId: quoteEventId,
            origin: 'quote',
            fromName: quote.fromName,
            quoteOf: quote.msgId,
        };
        const accepted = this.store.append([quoteInput, userInput]);
        return { quoteAccepted: accepted.length === 2 };
    }

    /** 事件 id 是否已存在（REQ-D6-06 去重判定；供引用展开"只写一次"） */
    hasEvent(eventId: string): boolean {
        return this.store.hasEvent(eventId);
    }

    /**
     * 按 msg_id 找事件（REQ-D6-01：内存快照 + 落盘事件页；与 read_raw 同一实现）。
     * 供引用回复展开复用，不新增第二套查找逻辑。
     */
    findEventByMsgId(msgId: string): ConversationEvent | null {
        const id = String(msgId || '').trim();
        if (!id) return null;
        return findEventByMsgId(this.store, this.store.snapshot(), id, []);
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
        /** 显式 eventId（注入块用确定性 id；优先于 dedupKey） */
        eventId?: string;
        at?: number;
    }): number[] {
        const eventId = input.eventId ?? (input.dedupKey ? systemEventId(input.dedupKey, '') : undefined);
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

    /**
     * 写入一个增量注入块（#163 D3 **唯一写入口**；调用方只给冻结正文与条目明细）。
     *
     * 约束：
     * - 只 append 一个 `kind:'event'` 的 SystemEvent，`raw.injection` 携带元数据（不新增 event kind、
     *   不新增 `RecordEntry.kind`、不新增 `ContextHead` 字段、`CONTEXT_SCHEMA_VERSION` 保持 2）；
     * - `afterSeq` 经 `clampAnchor` 夹紧后**冻结**，永不改写（释放判定与渲染定位都读它）；
     * - `tokens` 落盘冻结（`Σ estimateTextTokens(正文) + INJECTION_WRAP_TOKENS`），
     *   因为 provider 与渲染侧的估算口径必须一致，且释放后仍要能算出"释放了多少"。
     *
     * 返回值：写入的 seq 列表（被 eventId 去重时为空数组）。
     */
    appendInjection(input: {
        kind: string;
        items: InjectionItem[];
        afterSeq: number;
        at?: number;
        banks?: string[];
    }): number[] {
        const items = (input.items || []).filter(item => item && item.k.trim() !== '' && item.text.trim() !== '');
        if (items.length === 0) return [];
        const head = this.head();
        const afterSeq = clampAnchor(input.afterSeq, head.nextSeq, head.archivedThrough);
        const body = items.map(item => item.text).join('\n');
        const tokens = items.reduce((sum, item) => sum + estimateTextTokens(item.text), 0) + INJECTION_WRAP_TOKENS;
        const meta: InjectionMeta = {
            v: 1,
            kind: input.kind,
            afterSeq,
            tokens,
            items,
            createdAt: Date.now(),
            ...(input.banks && input.banks.length > 0 ? { banks: input.banks } : {}),
        };
        return this.appendSystem({
            systemName: `inject-${input.kind}`,
            eventType: 'inject',
            raw: { injection: meta },
            parts: [{ type: 'text', text: body }],
            eventId: injectionEventId(input.kind, afterSeq, items),
            at: input.at,
        });
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
