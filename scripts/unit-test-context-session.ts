// 生产路径：SessionService 打开会话后，写入/请求/持久化均走 Context v2。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import Agent from '../src/agent/agent';
import { PRIVILEGE_LEVEL_MAP } from '../src/config/static_config';
import { registerCmdCtx } from '../src/cmd/sub_cmd/ctx';
import { SubCmd } from '../src/cmd/root_cmd';
import { ContextService } from '../src/context/service';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { getHost, setHost } from '../src/core/host';
import { setAuxLlm } from '../src/core/ports/aux_llm';
import { SessionService } from '../src/session/session_service';
import { Session } from '../src/session/session';
import { sessionStorageKey } from '../src/session/persistence';
import { handleMessages } from '../src/utils/message';

class FakeStorage {
    map = new Map<string, string>();
    get(key: string): string {
        if (!this.map.has(key)) throw new Error(`key not found: ${key}`);
        return this.map.get(key)!;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

function installHost(): void {
    const storage = new FakeStorage();
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => Date.now() },
        fetch: (() => { throw new Error('no fetch'); }) as any,
        ext: {} as any,
    });
}

Config.registerConfig();

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextSessionServiceV2Path() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:session-service-v2';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;
        await session.context.addUserMessage({} as seal.MsgContext, '生产路径你好', 'QQ:1', 'pm1');
        await session.context.addUserMessage({} as seal.MsgContext, '[img:img_user] 图', 'QQ:1', 'pm2');
        session.context.addAssistantMessage('生产路径收到', 'pa1');
        assert.ok(session.contextV2, 'SessionService 应初始化上下文服务');
        assert.equal(session.contextV2!.snapshot().events.length, 3);
        const imageEvent = session.contextV2!.snapshot().events[1] as any;
        assert.ok(imageEvent.parts.some((part: any) => part.type === 'image' && part.ref === 'img_user'), '用户消息中的图片应保留 AST');
        assert.ok(session.context.messages.length > 0, '旧消费者通过投影读取');

        const system = { role: 'system', contentItems: [{ text: 'system prompt' }] } as any;
        const request = await handleMessages({} as seal.MsgContext, session, false, undefined, system);
        assert.ok(JSON.stringify(request).includes('生产路径你好'));
        assert.ok(JSON.stringify(request).includes('生产路径收到'));

        SessionService.save(session);
        const raw = getHost().storage.get(sessionStorageKey(sid));
        assert.ok(raw);
        assert.equal(raw.includes('"messages"'), false, '旧消息数组不再落盘');
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 3, '重开数据仍在');
    },

    async testLegacyMigrationParsesContent() {
        installHost();
        const sid = 'QQ:legacy-image';
        const legacy = new Session();
        legacy.sessionId = sid;
        legacy.context.sessionId = sid;
        legacy.context.agentName = '*';
        legacy.context.messages = [{
            role: 'user',
            contentItems: [{ text: '[img:img_legacy] 看图', time: 1, userId: 'QQ:1', messageId: 'lm1' }],
        }] as any;
        SessionService.save(legacy);
        const saved = getHost().storage.get(sessionStorageKey(sid));
        assert.ok(saved.includes('lm1'), `旧消息应落盘（实际：${saved.slice(0, 200)}）`);
        const service = new SessionService();
        service.agentName = '*';
        const session = service.getSession(sid);
        assert.equal(session.context.messages.length, 1, '旧消息应能读回');
        assert.ok(session.contextV2, '旧会话应迁移到事件账本');
        const event = session.contextV2!.snapshot().events[0] as any;
        assert.equal(event.kind, 'user');
        assert.ok(event.parts.some((part: any) => part.type === 'image' && part.ref === 'img_legacy'), '迁移应保留图片 AST');
        assert.ok(event.parts.some((part: any) => part.type === 'text' && part.text.includes('看图')));
    },

    async testContextTooLongTightensBudget() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:context-too-long';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;
        for (let i = 0; i < 5; i++) {
            await session.context.addUserMessage({} as seal.MsgContext, `${i} `.repeat(500), 'QQ:1', `ct${i}`);
        }
        const system = { role: 'system', contentItems: [{ text: 'system prompt' }] } as any;
        const before = JSON.stringify(await handleMessages({} as seal.MsgContext, session, false, undefined, system));
        await session.context.archiveByTokenIfNeeded(200);
        assert.equal(session.context.v2BudgetCapValue, 200, '超长错误应设置临时预算上限');
        const after = JSON.stringify(await handleMessages({} as seal.MsgContext, session, false, undefined, system));
        assert.ok(after.length < before.length, `收紧预算后请求应缩短（${before.length} → ${after.length}）`);
        session.context.setV2BudgetCap(null);
        assert.equal(session.context.v2BudgetCapValue, null);
    },

    async testCtxCommandUserFacing() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:ctx-command';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;
        await session.context.addUserMessage({} as seal.MsgContext, '你好', 'QQ:1', 'cm1');
        registerCmdCtx();
        const command = SubCmd.map['ctx'];
        assert.ok(command);
        const replied: string[] = [];
        (seal as any).replyToSender = (_ctx: unknown, _msg: unknown, text: string) => { replied.push(String(text)); };
        const solve = (args: string[], kwargs: Array<{ name: string }> = []) => command.solve({
            ctx: { privilegeLevel: PRIVILEGE_LEVEL_MAP.master },
            msg: {},
            cmdArgs: { args, kwargs },
            epId: 'QQ:1',
            gid: '',
            sid,
            session,
            ret: {},
        } as any);

        await solve(['ctx']);
        assert.ok(replied[0].includes('上下文：共 1 条消息'), replied[0]);
        assert.equal(replied[0].includes('v2'), false);

        await solve(['ctx', 'help']);
        assert.ok(replied[1].includes('用法：.ai ctx'), replied[1]);
        assert.ok(replied[1].includes('archive'));
        assert.ok(replied[1].includes('budget='));
        assert.ok(replied[1].includes('name'));

        await solve(['ctx', 'archive', 'help']);
        assert.ok(replied[2].includes('手动归档'), replied[2]);

        // purge = 新 context epoch：归档冷却标记重置
        session.ctxAutoSummaryBlockedUntil = Date.now() + 60_000;
        await solve(['ctx', 'purge'], [{ name: 'yes' }]);
        assert.ok(replied[3].includes('已清除'), replied[3]);
        assert.equal(session.ctxAutoSummaryBlockedUntil, 0, 'purge 后归档冷却应重置');
        assert.equal(session.contextV2!.snapshot().events.length, 0, 'purge 后内存服务应重建为空');
        await session.context.addUserMessage({} as seal.MsgContext, '清除后的新消息', 'QQ:1', 'cm2');
        assert.equal(session.contextV2!.snapshot().events.length, 1);
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 1, 'purge 后新写入应持久化');
    },

    /**
     * 自动归档可重复（P0-4 去掉「每会话一次」额度）：
     * 第一次预算到顶触发成功后，再次攒出超目标未摘要原文仍会继续归档。
     */
    async testAutoSummaryQuotaUsedOnce(): Promise<void> {
        let auxCalls = 0;
        setAuxLlm({
            chat: async () => { auxCalls++; return '滚动摘要'; },
            chatMessages: async () => '',
        } as any);
        try {
            const h = makeQuotaHarness({ pending: 100_000, omitted: 1 });
            h.agent.scheduleContextCompaction(h.session);
            await waitFor(() => h.state.compacts === 1 && h.session.ctxAutoSummaryInFlight === false, '第一次自动归档落地');
            assert.equal(auxCalls, 1);
            assert.equal(h.session.ctxAutoSummaryInFlight, false, '落地后应清掉在飞标记');
            assert.equal(h.state.pending, 0, '摘要推进到目标以下');
            assert.equal(h.state.lastBatchTokens, 6000, '目标 30000（预算 100000×30%），单批按 COMPACT_BATCH_TOKENS=6000 截断');

            // 不再有「每会话一次」限额：再次超目标仍会归档
            h.state.pending = 100_000;
            h.agent.scheduleContextCompaction(h.session);
            await waitFor(() => h.state.compacts === 2, '第二次自动归档');
            assert.equal(auxCalls, 2, '归档可重复，不再受一次性额度限制');
        } finally {
            setAuxLlm(null);
        }
    },

    /** 自动归档失败（aux 返回空）后退避：不立即重试、不提交摘要 */
    async testAutoSummaryQuotaRefundOnFailure(): Promise<void> {
        let auxCalls = 0;
        setAuxLlm({
            chat: async () => { auxCalls++; return null; },
            chatMessages: async () => '',
        } as any);
        try {
            const h = makeQuotaHarness({ pending: 100_000, omitted: 1 });
            h.agent.scheduleContextCompaction(h.session);
            await waitFor(() => h.state.compacts === 1 && h.session.ctxAutoSummaryInFlight === false, '第一次归档失败返回');
            assert.equal(auxCalls, 1);

            // 失败进入 runtime backoff → 立即再触发不再调用
            h.agent.scheduleContextCompaction(h.session);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(auxCalls, 1, '失败后退避，不立即重试');
            assert.equal(h.state.compacts, 1);
        } finally {
            setAuxLlm(null);
        }
    },

    /** 自动摘要门闩：未发生预算裁剪 / 未超保留目标 / 已在飞 / 未接入账本 → 都不发起 */
    async testAutoSummaryGateConditions(): Promise<void> {
        let auxCalls = 0;
        setAuxLlm({
            chat: async () => { auxCalls++; return '滚动摘要'; },
            chatMessages: async () => '',
        } as any);
        try {
            // 1) 本轮编译没有发生预算裁剪（omittedFromSeq=null）→ 不摘要
            const notOmitted = makeQuotaHarness({ pending: 100_000, omitted: null });
            notOmitted.agent.scheduleContextCompaction(notOmitted.session);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(notOmitted.state.compacts, 0, '未预算裁剪不应触发摘要');

            // 2) 未摘要原文未超过保留目标 → 不空跑
            const belowTarget = makeQuotaHarness({ pending: 10_000, omitted: 1 });
            belowTarget.agent.scheduleContextCompaction(belowTarget.session);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(belowTarget.state.compacts, 0, 'pending <= target 不应触发摘要');

            // 3) 已有摘要发起未落地（inFlight）→ 不重复触发
            const inFlight = makeQuotaHarness({ pending: 100_000, omitted: 1 });
            inFlight.session.ctxAutoSummaryInFlight = true;
            inFlight.agent.scheduleContextCompaction(inFlight.session);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(inFlight.state.compacts, 0, 'inFlight 时不得重复触发');

            // 4) 未接入事件账本（无 contextV2）→ 直接返回
            const noService = makeQuotaHarness({ pending: 100_000, omitted: 1 });
            noService.session.contextV2 = null;
            noService.agent.scheduleContextCompaction(noService.session);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(noService.state.compacts, 0);
            assert.equal(auxCalls, 0, '以上门闩条件均不应调用 aux LLM');
        } finally {
            setAuxLlm(null);
        }
    },

    /** 自动摘要单飞：已发起未落地期间再次触发（如并发 run/finally 重入）不重复发起 */
    async testAutoSummarySingleFlight(): Promise<void> {
        let auxCalls = 0;
        let release: (() => void) | null = null;
        setAuxLlm({
            chat: async () => {
                auxCalls++;
                await new Promise<void>(resolve => { release = resolve; });
                return '滚动摘要';
            },
            chatMessages: async () => '',
        } as any);
        try {
            const h = makeQuotaHarness({ pending: 100_000, omitted: 1 });
            h.agent.scheduleContextCompaction(h.session);
            await waitFor(() => auxCalls === 1, '摘要请求已发出');
            assert.equal(h.session.ctxAutoSummaryInFlight, true);
            h.agent.scheduleContextCompaction(h.session);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(auxCalls, 1, 'inFlight 期间不得并发发起第二次摘要');
            release!();
            await waitFor(() => h.state.compacts === 1 && h.session.ctxAutoSummaryInFlight === false, '摘要落地');
            assert.equal(h.session.ctxAutoSummaryInFlight, false);
        } finally {
            setAuxLlm(null);
        }
    },

    /**
     * 存储层大工具结果处理：
     * - 40KB 单事件不截断、可落盘（单事件页上限 256KB；多事件页 32KB 不再误伤）；
     * - >256KB 单事件在写账本前截断 text parts 并加标记，保证 flush 不永久卡死；
     * - 落盘后重开可读回（截断版）。
     */
    async testToolResultStorageLimit() {
        installHost();
        const service = new SessionService();
        service.agentName = '*';
        const sid = 'QQ:tool-result-storage';
        const session = service.getSession(sid);
        session.sessionType = 'user';
        (session.context as any).isColdSession = () => false;

        // 1) 40KB 单事件：不截断，flush 成功（旧实现会因 >32KB 单事件页被 buildEventPage 拒绝而永久卡住）
        const text40k = '中'.repeat(40 * 1024);
        await session.context.addToolCallbackMessage(text40k, 'call_40k', 'call_ob11_api');
        const event40k = session.contextV2!.snapshot().events[0] as any;
        const stored40k = event40k.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
        assert.equal(stored40k.length, text40k.length, '40KB 单事件不应被存储层截断');
        assert.equal(stored40k.includes('[tool-result-truncated-for-storage:'), false, '不应出现截断标记');
        assert.equal((await session.contextV2!.flush()).ok, true, '40KB 单事件应可落盘');
        const reopened40k = await ContextService.open(sid);
        assert.equal(reopened40k.snapshot().events.length, 1, '40KB 单事件落盘后应可读回');
        assert.equal(
            (reopened40k.snapshot().events[0] as any).parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('').length,
            text40k.length,
            '读回原文完整',
        );

        // 2) 300KB 单事件：写账本前截断并加标记，flush 成功
        const huge = '长'.repeat(300 * 1024);
        await session.context.addToolCallbackMessage(huge, 'call_huge', 'call_ob11_api');
        const hugeEvent = session.contextV2!.snapshot().events.find((event: any) => event.kind === 'tool_result' && event.callId === 'call_huge') as any;
        assert.ok(hugeEvent, '超大工具结果应入账本');
        const storedHuge = hugeEvent.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
        assert.ok(storedHuge.length < huge.length, `超单事件页上限应截断（保留 ${storedHuge.length}/${huge.length}）`);
        assert.ok(storedHuge.includes('[tool-result-truncated-for-storage:'), '截断需带存储层标记');
        assert.equal((await session.contextV2!.flush()).ok, true, '截断后单事件页应可落盘');
        const reopened = await ContextService.open(sid);
        assert.equal(reopened.snapshot().events.length, 2, '两个工具结果都应在账本里');
        const reloadedHuge = reopened.snapshot().events.find((event: any) => event.kind === 'tool_result' && event.callId === 'call_huge') as any;
        assert.ok(reloadedHuge, '重开后可读回截断版超大结果');
        assert.ok(
            reloadedHuge.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('').includes('[tool-result-truncated-for-storage:'),
            '重开后保留截断标记',
        );
    },
};

// ---------------- 自动摘要额度测试工具 ----------------

/** 等待 fire-and-forget 的异步副作用（scheduleContextCompaction 返回 void） */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

interface QuotaHarness {
    agent: any;
    session: any;
    state: { pending: number; compacts: number; saves: number; lastBatchTokens: number };
}

/**
 * 构造只实现 `Agent.scheduleContextCompaction` 所需表面的会话：
 * contextV2 门面（lastCompile/head/compact/flush）+ 额度字段 + save。
 * 预算用会话覆盖 100000（保留强度默认 30% → 目标 30000），与全局配置解耦。
 */
function makeQuotaHarness(opts: { pending: number; omitted: number | null }): QuotaHarness {
    const state = { pending: opts.pending, compacts: 0, saves: 0, lastBatchTokens: 0 };
    const service: any = {
        lastCompile: () => ({ omittedFromSeq: opts.omitted, omittedToSeq: opts.omitted }),
        head: () => ({ unsummarizedTokens: state.pending }),
        compact: async (options: any, deps: any) => {
            state.compacts++;
            state.lastBatchTokens = options?.batchTokens;
            const text = await deps.summarize('batch-input');
            if (typeof text !== 'string' || !text.trim()) {
                return {
                    advanced: false,
                    reason: 'empty-summary',
                    record: null,
                    through: 0,
                    unsummarizedTokens: state.pending,
                    batch: null,
                    inputChars: 0,
                    truncated: false,
                };
            }
            state.pending = 0;
            return {
                advanced: true,
                record: { kind: 'summary', id: 'sum:1', at: 1, epoch: 1, fromSeq: 1, toSeq: 2, text },
                through: 2,
                unsummarizedTokens: 0,
                batch: null,
                inputChars: 10,
                truncated: false,
            };
        },
        flush: async () => ({ ok: true }),
    };
    const session: any = {
        sessionId: '',
        agentName: '*',
        contextV2: service,
        setting: { overrides: { ctxBudgetTokens: 100_000 } },
        ctxAutoSummaryInFlight: false,
        ctxAutoSummaryBlockedUntil: 0,
        save: () => { state.saves++; },
    };
    return { agent: Object.create(Agent.prototype), session, state };
}
