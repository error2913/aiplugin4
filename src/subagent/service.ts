// 子代理编排服务（≈ ctx.subagents + dsh-tool-subagent 的服务侧行为）。
// 职责：provider 注册表、深度校验、前台/continuable 生命周期、child 记录、settle/notice、控制与中断。
// 依赖注入：store（持久化）、noticeSink（投递到父会话）、now（时钟）；可独立单测。
// 运行循环（child 激活的模型请求/工具执行）由对接层提供并调用 markRunning/finishActivation。
import {
    childIdFor,
    delegationAllowed,
    isTerminal,
    settleNoticeText,
} from './rules';
import type { SubAgentStore } from './store';
import {
    ChildRecord,
    ChildStatus,
    ParentRef,
    StartRequest,
    SubAgentProvider,
    SubAgentResult,
    SubAgentSettleSink,
} from './types';

export class SubAgentProviderNotFoundError extends Error {
    constructor(name: string) {
        super(`subagent provider not found: ${name}`);
        this.name = 'SubAgentProviderNotFoundError';
    }
}

export class SubAgentDepthLimitError extends Error {
    constructor(maxDepth: number) {
        super(`reached max subagent delegation depth (${maxDepth}); no more subagents may be started`);
        this.name = 'SubAgentDepthLimitError';
    }
}

export class SubAgentContinuableError extends Error {
    constructor(name: string) {
        super(`subagent provider "${name}" does not support continuable (no prepareContinuable)`);
        this.name = 'SubAgentContinuableError';
    }
}

export class SubAgentNotFoundError extends Error {
    constructor(childId: string) {
        super(`subagent not found: ${childId}`);
        this.name = 'SubAgentNotFoundError';
    }
}

export class SubAgentControlDeniedError extends Error {
    constructor() {
        super('only an ancestor agent may control this subagent');
        this.name = 'SubAgentControlDeniedError';
    }
}

export interface SubAgentServiceOptions {
    now?: () => number;
    /** 后台 child 终态结算后回调（已投 notice 后触发；供对接层做唤醒/记账等） */
    onSettled?: (record: ChildRecord, result: SubAgentResult) => void;
    /** 返回父上下文中仍存在的子代理结算 notice 所引用的 childId 集合（生命周期绑定用） */
    onParentNoticeIds?: (parentSessionId: string) => Set<string>;
}

export interface ForegroundOutcome {
    childId: string;
    result: SubAgentResult;
    record: ChildRecord;
}

export interface ContinuableOutcome {
    childId: string;
    seed?: unknown;
    record: ChildRecord;
}

/** 从 childId（sub:<parent>:<seq>）反解父会话；不可解析返回 null */
export function parseChildId(childId: string): { parentSessionId: string; seq: number } | null {
    if (!childId.startsWith('sub:')) return null;
    const rest = childId.slice(4);
    const idx = rest.lastIndexOf(':');
    if (idx <= 0 || idx === rest.length - 1) return null;
    const seq = Number(rest.slice(idx + 1));
    if (!Number.isFinite(seq) || seq <= 0) return null;
    return { parentSessionId: rest.slice(0, idx), seq };
}

export class SubAgentService {
    private readonly providers = new Map<string, SubAgentProvider>();
    private readonly store: SubAgentStore;
    private readonly sink: SubAgentSettleSink | null;
    private readonly onSettled: ((record: ChildRecord, result: SubAgentResult) => void) | null;
    private readonly onParentNoticeIds: ((parentSessionId: string) => Set<string>) | null;
    private readonly now: () => number;
    /** childId → 运行循环的中断回调（由对接层注册；终态后清除） */
    private readonly abortHandlers = new Map<string, () => void>();
    private msgSeq = 0;

    constructor(store: SubAgentStore, sink: SubAgentSettleSink | null = null, opts: SubAgentServiceOptions = {}) {
        this.store = store;
        this.sink = sink;
        this.onSettled = opts.onSettled ?? null;
        this.onParentNoticeIds = opts.onParentNoticeIds ?? null;
        this.now = opts.now ?? Date.now;
    }

    // —— provider 注册表 ——
    registerProvider(p: SubAgentProvider): void {
        if (this.providers.has(p.name)) throw new Error(`duplicate subagent provider: ${p.name}`);
        this.providers.set(p.name, p);
    }

    getProvider(name: string): SubAgentProvider | null {
        return this.providers.get(name) ?? null;
    }

    providerNames(): string[] {
        return Array.from(this.providers.keys());
    }

    private requireProvider(name: string): SubAgentProvider {
        const p = this.providers.get(name);
        if (!p) throw new SubAgentProviderNotFoundError(name);
        return p;
    }

    // —— 前台 / continuable 启动 ——
    private checkDepth(req: StartRequest): void {
        if (!delegationAllowed(req.parent.depth, req.maxDepth)) {
            throw new SubAgentDepthLimitError(req.maxDepth ?? 0);
        }
    }

    private rootOf(parent: ParentRef): string {
        return parent.treeRootSessionId ?? parent.sessionId;
    }

    private newRecord(providerName: string, req: StartRequest, status: ChildStatus): ChildRecord {
        const seq = this.store.allocateSeq(req.parent.sessionId);
        const childId = childIdFor(req.parent.sessionId, seq);
        const ts = this.now();
        return {
            childId,
            parentSessionId: req.parent.sessionId,
            treeRootSessionId: this.rootOf(req.parent),
            parentAgentName: '',
            provider: providerName,
            label: req.label,
            depth: req.parent.depth + 1,
            status,
            childSessionId: childId,
            agentName: req.persona ?? '',
            meta: { epId: req.parent.epId, isPrivate: req.parent.isPrivate },
            createdAt: ts,
            updatedAt: ts,
            inbox: [],
            toolFilter: req.toolFilter ?? null,
            recVer: 2,
        };
    }

    /**
     * 前台委派：运行 child 直到终态并返回结果。
     * 记录保留用于审计（status=done）；不发 settle notice（结果已随工具返回）。
     */
    async startForeground(providerName: string, req: StartRequest): Promise<ForegroundOutcome> {
        const provider = this.requireProvider(providerName);
        this.checkDepth(req);
        const record = this.newRecord(providerName, req, 'running');
        this.store.upsert(record.parentSessionId, record);
        const childReq: StartRequest = {
            ...req,
            childId: record.childId,
            childSessionId: record.childSessionId,
        };
        const run = await provider.start(childReq);
        let result: SubAgentResult;
        try {
            result = await run.result;
        } finally {
            await run.dispose();
        }
        record.status = 'done';
        record.lastResult = result;
        record.updatedAt = this.now();
        this.store.upsert(record.parentSessionId, record);
        return { childId: record.childId, result, record };
    }

    /** continuable：创建持久 child（idle），返回 childId；激活由对接层随后驱动 */
    async startContinuable(providerName: string, req: StartRequest): Promise<ContinuableOutcome> {
        const provider = this.requireProvider(providerName);
        if (!provider.prepareContinuable) throw new SubAgentContinuableError(providerName);
        this.checkDepth(req);
        const record = this.newRecord(providerName, req, 'idle');
        this.store.upsert(record.parentSessionId, record);
        const prepared = await provider.prepareContinuable({
            ...req,
            childId: record.childId,
            childSessionId: record.childSessionId,
        });
        return { childId: record.childId, seed: prepared?.seed, record };
    }

    // —— 激活生命周期（由对接层驱动）——
    /** 对接层启动激活前调用：idle/interrupted→running，注册中断回调 */
    markRunning(childId: string, onAbort: () => void): ChildRecord {
        const record = this.findChildOrThrow(childId);
        if (record.status === 'done' || record.status === 'stopped') {
            throw new Error(`subagent ${childId} is ${record.status} and cannot run`);
        }
        record.status = 'running';
        record.updatedAt = this.now();
        this.abortHandlers.set(childId, onAbort);
        this.store.upsert(record.parentSessionId, record);
        return record;
    }

    /**
     * 激活结束。
     * 终态原因（completed/error/max-tokens/refusal/timeout）→ status=done，且（后台场景）
     * 经 noticeSink 投递一次 settle 通知；aborted（被 interrupt）→ status=idle，可续跑、不投递。
     */
    finishActivation(childId: string, result: SubAgentResult, opts: { deliverNotice?: boolean } = {}): ChildRecord {
        const record = this.findChildOrThrow(childId);
        // 单次结算：已终态（done/stopped）的 child 不重复结算，也不重复投递 notice
        if (record.status === 'done' || record.status === 'stopped') return record;
        const terminal = isTerminal(result.stopReason);
        record.status = terminal ? 'done' : 'idle';
        record.lastResult = result;
        record.updatedAt = this.now();
        this.abortHandlers.delete(childId);
        this.store.upsert(record.parentSessionId, record);
        if (terminal && (opts.deliverNotice ?? true)) {
            record.hasNoticed = true;
            this.store.upsert(record.parentSessionId, record);
            if (this.sink) this.sink(record.parentSessionId, settleNoticeText(childId, record.label, result), childId);
            if (this.onSettled) this.onSettled(record, result);
        }
        return record;
    }

    // —— 控制 ——
    /** 公开只读查找：不存在返回 null（供工具层判断状态/续跑） */
    getRecord(childId: string): ChildRecord | null {
        const parsed = parseChildId(childId);
        if (!parsed) return null;
        return this.store.get(parsed.parentSessionId, childId);
    }

    private findChildOrThrow(childId: string): ChildRecord {
        const record = this.getRecord(childId);
        if (!record) throw new SubAgentNotFoundError(childId);
        return record;
    }

    private assertAncestor(childId: string, callerSessionId: string): ChildRecord {
        const record = this.findChildOrThrow(childId);
        const isAncestor = callerSessionId === record.parentSessionId
            || callerSessionId === record.treeRootSessionId;
        if (!isAncestor) throw new SubAgentControlDeniedError();
        return record;
    }

    /** interrupt：只停当前激活（回调运行循环停止），agent 保留可续；ancestor 才有权 */
    interrupt(childId: string, callerSessionId: string): boolean {
        this.assertAncestor(childId, callerSessionId);
        const handler = this.abortHandlers.get(childId);
        if (handler) handler();
        return true;
    }

    /** send_message：ancestor 向子代理投递续派消息（入 inbox，返回 messageId） */
    sendMessage(childId: string, callerSessionId: string, text: string): { messageId: string } {
        const record = this.assertAncestor(childId, callerSessionId);
        this.msgSeq++;
        record.inbox.push(text);
        record.updatedAt = this.now();
        this.store.upsert(record.parentSessionId, record);
        return { messageId: `${childId}:msg:${this.msgSeq}` };
    }

    /** 取走并清空 inbox（激活循环每次启动前调用） */
    drainInbox(childId: string): string[] {
        const record = this.findChildOrThrow(childId);
        const messages = record.inbox;
        record.inbox = [];
        record.updatedAt = this.now();
        this.store.upsert(record.parentSessionId, record);
        return messages;
    }

    listByParent(parentSessionId: string): ChildRecord[] {
        return this.store.list(parentSessionId);
    }

    /** .ai stop 全灭：以 sessionId 为树根递归中断全部 running child 并置 stopped；返回受影响数 */
    abortByParent(sessionId: string): number {
        return this.abortTree(sessionId);
    }

    private abortTree(key: string): number {
        let count = 0;
        for (const record of this.store.list(key)) {
            if (record.status === 'running') {
                const handler = this.abortHandlers.get(record.childId);
                if (handler) handler();
                this.abortHandlers.delete(record.childId);
                record.status = 'stopped';
                record.updatedAt = this.now();
                this.store.upsert(record.parentSessionId, record);
                count++;
            }
            // 子代理的孙代理以 childSessionId(=childId) 为父键递归
            count += this.abortTree(record.childSessionId);
        }
        return count;
    }

    /** 清理本会话已结束（done/stopped/interrupted）记录（连带 checkpoint 载荷），返回清理条数 */
    cleanTerminated(parentSessionId: string): number {
        let count = 0;
        for (const record of this.store.list(parentSessionId)) {
            if (record.status === 'done' || record.status === 'stopped' || record.status === 'interrupted') {
                if (this.removeChild(record)) count++;
            }
        }
        return count;
    }

    private removeChild(record: ChildRecord): boolean {
        const ok = this.store.remove(record.parentSessionId, record.childId);
        if (ok) this.store.removeChildSession(record.parentSessionId, record.childId);
        return ok;
    }

    /** 重载对账：把上次进程残留的 running 置 interrupted（可续），保留 checkpoint；返回条数 */
    reconcileReload(parentSessionId: string): number {
        let count = 0;
        for (const record of this.store.list(parentSessionId)) {
            if (record.status === 'running') {
                record.status = 'interrupted';
                record.updatedAt = this.now();
                this.store.upsert(record.parentSessionId, record);
                count++;
            }
        }
        return count;
    }

    /**
     * 生命周期清扫（父上下文已遗忘 → 收敛）：
     * - referenced（notice 标记仍在父上下文）→ 保留；
     * - running → 不打断，跑完结算后再收敛；
     * - 遗留未绑定记录（recVer!==2，旧版本创建，无 notice 绑定/无 checkpoint 可续）→ 清理；
     * - 新记录（recVer=2）：曾 notice（hasNoticed）且父上下文已遗忘 → 清理；
     *   尚未结算/等待手动续（hasNoticed 未置位）→ 保留，避免误删刚建/可续的 child。
     */
    sweepParent(parentSessionId: string): number {
        if (!this.onParentNoticeIds) return 0;
        const referenced = this.onParentNoticeIds(parentSessionId);
        let count = 0;
        for (const record of this.store.list(parentSessionId)) {
            if (referenced.has(record.childId)) continue;
            if (record.status === 'running') continue; // 不杀运行中
            const isLegacyUnbound = record.recVer !== 2;
            const isNoticedButForgotten = record.hasNoticed === true;
            if (isLegacyUnbound || isNoticedButForgotten) {
                if (this.removeChild(record)) count++;
            }
        }
        return count;
    }
}
