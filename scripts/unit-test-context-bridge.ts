// 归档合并抽取（P0-4）单测：摘要 + facts 同一请求、两阶段草稿、解析失败不降级、共享 runtime。
import assert from 'node:assert/strict';

import Agent from '../src/agent/agent';
import Config from '../src/config/config';
import { compactionRuntimeFor, resetCompactionRuntime } from '../src/context/compact/session_runtime';
import { setArchiveFactsSink } from '../src/core/ports/archive_facts';
import { getHost, setHost } from '../src/core/host';
import { setAuxLlm } from '../src/core/ports/aux_llm';
import { SessionService } from '../src/session/session_service';
import { TokenCalibration } from '../src/token_calibration';
import { estimateMessageTokens, estimateTextTokens, handleMessages } from '../src/utils/message';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';

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

async function makeSession(sid: string) {
    const service = new SessionService();
    service.agentName = '*';
    Agent.get = (() => ({ sessionService: service })) as any;
    const session = service.getSession(sid);
    session.sessionType = 'user';
    (session.context as any).isColdSession = () => false;
    for (let i = 1; i <= 4; i++) {
        await session.context.addUserMessage({} as seal.MsgContext, `归档消息 ${i} `.repeat(800), 'QQ:1', `mb${i}`);
    }
    return session;
}

function combinedReply(facts: any[] = []) {
    return JSON.stringify({ summary: '这是滚动摘要', facts });
}

/** 等待异步副作用（fire-and-forget 的后台摘要） */
async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

interface CapturedFacts {
    calls: Array<{ sessionId: string; facts: unknown[]; fromSeq: number; toSeq: number }>;
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextArchiveCombinedFacts() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        const captured: CapturedFacts = { calls: [] };
        setArchiveFactsSink(async input => {
            captured.calls.push({ sessionId: input.sessionId, facts: input.facts, fromSeq: input.fromSeq, toSeq: input.toSeq });
            return [];
        });
        setAuxLlm({
            chat: async () => combinedReply([{ memory_type: 'private', target_id: 'QQ:1', text: '用户喜欢猫', type: 'fact', confidence: 0.9 }]),
            chatMessages: async () => '',
        } as any);
        try {
            const session = await makeSession('QQ:archive-combined');
            resetCompactionRuntime(session);
            const result = await compactionRuntimeFor(session)!.archiveNow(1);
            assert.equal(result.advanced, true);
            await session.contextV2!.flush();
            const summaries = session.contextV2!.snapshot().records.filter(r => r.kind === 'summary');
            assert.ok(summaries.length >= 1, '应写入滚动摘要记录');
            assert.ok(captured.calls.length >= 1, '归档段 facts 应交给 sink');
            assert.equal(captured.calls[0].sessionId, 'QQ:archive-combined');
            assert.equal(captured.calls[0].facts.length, 1);
            assert.ok(captured.calls[0].toSeq >= captured.calls[0].fromSeq);
        } finally {
            setAuxLlm(null);
            setArchiveFactsSink(null);
        }
    },

    async testContextArchiveFactsFailureDraftReplay() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        let applied = 0;
        let fail = true;
        setArchiveFactsSink(async () => {
            if (fail) throw new Error('draft-fail');
            applied++;
            return [];
        });
        setAuxLlm({
            chat: async () => combinedReply([{ memory_type: 'private', target_id: 'QQ:1', text: '用户喜欢茶', type: 'fact', confidence: 0.9 }]),
            chatMessages: async () => '',
        } as any);
        try {
            const session = await makeSession('QQ:archive-draft');
            resetCompactionRuntime(session);
            const first = await compactionRuntimeFor(session)!.archiveNow(1);
            assert.equal(first.advanced, true, 'facts 写失败不阻塞摘要提交');
            const draftKey = 'archive_draft:QQ:archive-draft';
            const draft = JSON.parse(getHost().storage.get(draftKey) || '{}');
            assert.equal(draft.applied, false, 'facts 失败应保留未应用草稿');

            // 再攒一些未摘要内容，触发下一次 compact 入口 replay
            for (let i = 1; i <= 4; i++) {
                await session.context.addUserMessage({} as seal.MsgContext, `后续消息 ${i} `.repeat(800), 'QQ:1', `mb2-${i}`);
            }
            fail = false;
            await compactionRuntimeFor(session)!.archiveNow(1);
            assert.ok(applied >= 1, '重放应补写 facts（不重调 LLM）');
            const after = getHost().storage.get(draftKey);
            assert.ok(!after, '成功重放后草稿应清除');
        } finally {
            setAuxLlm(null);
            setArchiveFactsSink(null);
        }
    },

    async testContextArchiveParseFailureNoFallback() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        let calls = 0;
        setArchiveFactsSink(async () => []);
        setAuxLlm({
            chat: async () => { calls++; return '这不是 JSON'; },
            chatMessages: async () => '',
        } as any);
        try {
            const session = await makeSession('QQ:archive-bad-json');
            resetCompactionRuntime(session);
            const result = await compactionRuntimeFor(session)!.archiveNow(1);
            assert.equal(result.advanced, false);
            assert.equal(result.reason, 'summary-error');
            assert.equal(calls, 1, '解析失败不做后备，只调一次');
            assert.equal(session.contextV2!.snapshot().records.filter(r => r.kind === 'summary').length, 0, '不提交摘要');
        } finally {
            setAuxLlm(null);
            setArchiveFactsSink(null);
        }
    },

    async testContextBridgeCompactsV2() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        setAuxLlm({
            chat: async () => combinedReply(),
            chatMessages: async () => combinedReply(),
        });
        try {
            const session = await makeSession('QQ:bridge-compact');
            resetCompactionRuntime(session);
            const result = await compactionRuntimeFor(session)!.archiveNow(1);
            assert.equal(result.advanced, true);
            await session.contextV2!.flush();
            const summaries = session.contextV2!.snapshot().records.filter(r => r.kind === 'summary');
            assert.ok(summaries.length >= 1, '应写入滚动摘要记录');
            assert.ok(session.contextV2!.head().summarizedThrough >= 1);
        } finally {
            setAuxLlm(null);
        }
    },

    /**
     * 编译预算口径回归（P0）：
     * v2 编译的预算必须按 TokenCalibration 校准系数折算、tools 预留必须按 JSON 实际估算，
     * 否则请求体估算会超出预算且 `omittedFromSeq` 永不出现（“预算到顶”检测不到 → 摘要永不触发）。
     */
    async testContextCompileBudgetMatchesRequestEstimate() {
        installHost();
        const TC = (globalThis as any).__TEST_CONFIG__;
        const origBudget = TC.intConfigs['上下文预算'];
        const origPE = TC.boolConfigs['切换为提示词工程'];
        TC.intConfigs['上下文预算'] = 20000;
        TC.boolConfigs['切换为提示词工程'] = false;
        (Config as any).cache = {};
        TokenCalibration.resetForTest();
        const origAgentGet = Agent.get;
        try {
            TokenCalibration.record('cal-budget-model', 100, 200); // factor = 2
            const sessionService = new SessionService();
            sessionService.agentName = '*';
            Agent.get = (() => ({ sessionService })) as any;
            const session = sessionService.getSession('QQ:compile-budget');
            session.sessionType = 'user';
            (session.context as any).isColdSession = () => false;
            for (let i = 1; i <= 6; i++) {
                await session.context.addUserMessage({} as seal.MsgContext, `预算口径用户消息 ${i} `.repeat(150), 'QQ:1', `cb-u${i}`);
                session.context.addAssistantMessage(`预算口径助手回复 ${i} `.repeat(150), `cb-a${i}`);
            }
            const real = session.contextV2!;
            let captured: any = null;
            (session as any).contextV2 = {
                compile: (options: any) => {
                    captured = options;
                    return real.compile(options);
                },
            };
            const tools = [{
                type: 'function',
                function: {
                    name: 'big_tool',
                    description: 'x'.repeat(4000),
                    parameters: { type: 'object', properties: { q: { type: 'string' } } },
                },
            }];
            const system = { role: 'system', contentItems: [{ text: 'system prompt' }] };
            const out = await handleMessages(
                { endPoint: { userId: 'QQ:1' } } as any,
                session,
                false,
                tools,
                system as any,
                'cal-budget-model',
            );
            assert.ok(captured, 'v2 路径应调用 compile');
            assert.equal(captured.budgetTokens, 10000, '有效预算 = requestBudget(20000) / 校准系数(2)');
            assert.equal(
                captured.toolsReserveTokens,
                estimateTextTokens(JSON.stringify(tools)),
                'tools 预留按 JSON 实际估算（不再是 tools.length * 20）',
            );

            const requestEstimate = (out as any[]).reduce((sum, message) => sum + estimateMessageTokens(message), 0)
                + estimateTextTokens(JSON.stringify(tools));
            assert.ok(requestEstimate <= captured.budgetTokens, `请求体估算 ${requestEstimate} 应 ≤ 有效预算 ${captured.budgetTokens}`);

            const stats = real.lastCompile();
            assert.ok(stats, '编译应写入最近编译统计');
            assert.notEqual(stats!.omittedFromSeq, null, '预算到顶必须能检测到 omittedFromSeq');
            assert.ok((stats!.omittedToSeq ?? 0) >= 1);
        } finally {
            Agent.get = origAgentGet;
            if (origBudget === undefined) delete TC.intConfigs['上下文预算']; else TC.intConfigs['上下文预算'] = origBudget;
            if (origPE === undefined) delete TC.boolConfigs['切换为提示词工程']; else TC.boolConfigs['切换为提示词工程'] = origPE;
            TokenCalibration.resetForTest();
            (Config as any).cache = {};
        }
    },

    /**
     * 自动归档与手动 `.ai ctx archive` 必须共用同一 CompactionRuntime：
     * 两个“单飞”互不可见时，可同时对同一批未摘要事件 compactOnce → 重复摘要/重复计费。
     */
    async testContextBridgeSharedRuntimeSingleFlight() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        let summarizeCalls = 0;
        let release: (() => void) | null = null;
        setAuxLlm({
            chat: async () => {
                summarizeCalls++;
                if (summarizeCalls === 1) {
                    await new Promise<void>(resolve => { release = resolve; });
                }
                return combinedReply();
            },
            chatMessages: async () => '',
        } as any);
        try {
            const session = await makeSession('QQ:bridge-single-flight');
            resetCompactionRuntime(session);
            const runtime = compactionRuntimeFor(session);
            assert.ok(runtime, '接入事件账本后应能取到共享运行时');
            assert.equal(compactionRuntimeFor(session), runtime, '自动路径与手动 archive 必须复用同一个 runtime');

            const auto = runtime!.maybeRun(1);
            await waitForCondition(() => summarizeCalls === 1, '自动摘要请求已发出');
            const manual = await runtime!.archiveNow(1);
            assert.equal(manual.ran, false, '自动摘要在飞时手动 archive 不得并发执行');
            assert.equal(manual.reason, 'running');
            assert.equal(summarizeCalls, 1, '被单飞挡下的手动调用不得额外调用摘要器');

            release!();
            const autoResult = await auto;
            assert.equal(autoResult.advanced, true);
            assert.ok(summarizeCalls >= 1);

            const after = await runtime!.archiveNow(1);
            assert.equal(after.ran, true);

            resetCompactionRuntime(session);
            assert.notEqual(compactionRuntimeFor(session), runtime, 'reset 后应重建 runtime');
        } finally {
            setAuxLlm(null);
        }
    },
};
