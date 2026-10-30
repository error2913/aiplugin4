// 记忆桥单测：v2 事件消费、成功推进水位、失败不推进/幂等。
import assert from 'node:assert/strict';

import Agent from '../src/agent/agent';
import { compactContextV2, collectContextBacklog, commitExtraction, consumeContextV2, consumedThrough, peekExtractionChunk, resetContextRuntime, resetContextBridgeCursor } from '../src/agent/context_bridge';
import { MemoryScheduler, resetMemorySchedulerForTest } from '../src/agent/memory_scheduler';
import Config from '../src/config/config';
import { compactionRuntimeFor, resetCompactionRuntime } from '../src/context/compact/session_runtime';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import { setAuxLlm } from '../src/core/ports/aux_llm';
import { MemoryManager } from '../src/memory/manager';
import { MemoryService, setMemoryEngineFactory } from '../src/memory/service';
import { MemoryEngine } from '../src/memory/v2/engine';
import { InMemoryMemoryStorage } from '../src/memory/v2/storage';
import { SessionService } from '../src/session/session_service';
import { TokenCalibration } from '../src/token_calibration';
import { estimateMessageTokens, estimateTextTokens, handleMessages } from '../src/utils/message';

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
        await session.context.addUserMessage({} as seal.MsgContext, `记忆桥消息 ${i} `.repeat(800), 'QQ:1', `mb${i}`);
    }
    return session;
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextBridgeConsumesAndAdvances() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        const original = MemoryManager.summarizeChunkWithRetry;
        let calls = 0;
        (MemoryManager as any).summarizeChunkWithRetry = async () => { calls++; return true; };
        try {
            const session = await makeSession('QQ:bridge-ok');
            resetContextBridgeCursor(session);
            // 记忆桥单次 collect 最多读 12000 字符（约 4000 token），这里多收集几轮越过 6000 token 水位
            collectContextBacklog(session);
            collectContextBacklog(session);
            const consumed = await consumeContextV2(session);
            assert.ok(consumed > 0);
            assert.equal(calls, 1);
            assert.ok(consumedThrough(session) >= 1);
            assert.equal(await consumeContextV2(session), 0, '水位已推进，无新事件不重复消费');
            resetContextRuntime(session);
            assert.equal(await consumeContextV2(session), 0, '重载后从持久化进度继续，不重复沉淀');
            assert.equal(calls, 1);
        } finally {
            (MemoryManager as any).summarizeChunkWithRetry = original;
        }
    },

    async testContextBridgeFailureKeepsCursor() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        const original = MemoryManager.summarizeChunkWithRetry;
        (MemoryManager as any).summarizeChunkWithRetry = async () => false;
        try {
            const session = await makeSession('QQ:bridge-fail');
            resetContextBridgeCursor(session);
            assert.equal(await consumeContextV2(session), 0);
            assert.equal(consumedThrough(session), 0, '失败不推进');
        } finally {
            (MemoryManager as any).summarizeChunkWithRetry = original;
        }
    },

    async testContextBridgeSplitCollectPeekCommit() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        const session = await makeSession('QQ:bridge-split');
        resetContextBridgeCursor(session);
        // 只收集：0 LLM
        const before = collectContextBacklog(session);
        assert.ok(before.pendingChars > 0, '收集后应有 pending');
        assert.equal(consumedThrough(session), 0, '收集不推进 consumed');
        const chunk = peekExtractionChunk(session, true);
        assert.ok(chunk && chunk.text.includes('记忆桥消息'), '应能取到抽取块');
        // 不 commit：pending 保留，consumed 不推进
        assert.equal(consumedThrough(session), 0);
        // 重载后 pending 仍在（持久化 mem_cursor）；生产路径下一轮 run 会先 collect
        resetContextRuntime(session);
        collectContextBacklog(session);
        const pendingAgain = peekExtractionChunk(session, true);
        assert.ok(pendingAgain && pendingAgain.text.includes('记忆桥消息'), '重载后 pending 仍在');
        commitExtraction(session, chunk!.throughSeq, chunk!.textLength);
        assert.ok(consumedThrough(session) >= 1, 'commit 推进 consumed');
        // 大文本一次只读一部分：循环提交剩余块，直到 pending 清空
        let left = peekExtractionChunk(session, true);
        while (left) {
            commitExtraction(session, left.throughSeq, left.textLength);
            left = peekExtractionChunk(session, true);
        }
        assert.equal(left, null, '提交后无剩余 pending');
    },

    async testContextBridgeSchedulerEndToEnd() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => Math.floor(Date.now() / 1000) });
        setMemoryEngineFactory(() => engine);
        resetMemorySchedulerForTest();
        MemoryScheduler.init();
        setAuxLlm({
            chat: async () => JSON.stringify({ facts: [{ memory_type: 'private', target_id: 'QQ:bridge-e2e', text: '用户喜欢猫', type: 'fact', confidence: 0.9 }] }),
            chatMessages: async () => '',
        } as any);
        try {
            const session = await makeSession('QQ:bridge-e2e');
            resetContextBridgeCursor(session);
            // 单次 collect 约 4000 token；多收集两轮越过 6000 token 的记忆水位
            collectContextBacklog(session);
            collectContextBacklog(session);
            MemoryScheduler.onRunEnd(session);
            assert.equal(MemoryScheduler.status().jobs, 1, 'AI 结束后应入队 extract');
            const now = Math.floor(Date.now() / 1000);
            assert.equal(await MemoryScheduler.tick(now), true, 'extract job 应执行');
            assert.ok(engine.repository.listUnits('user_QQ:bridge-e2e').length > 0, '抽取后应写入事实');
            // consolidate job（可能已由 extract 入队）
            if (MemoryScheduler.status().jobs > 0) assert.equal(await MemoryScheduler.tick(now), true);
            assert.ok(engine.repository.listObservations('user_QQ:bridge-e2e').length > 0, '巩固后应生成观察');
        } finally {
            setAuxLlm(null);
            resetMemorySchedulerForTest();
        }
    },

    async testContextBridgeCompactsV2() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        setAuxLlm({
            chat: async () => '这是滚动摘要',
            chatMessages: async () => '这是滚动摘要',
        });
        try {
            const session = await makeSession('QQ:bridge-compact');
            resetContextRuntime(session);
            const result = await compactContextV2(session, 1);
            assert.ok(result, '应返回压缩结果');
            assert.equal(result!.advanced, true);
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
     * 否则请求体估算会超出预算且 `omittedFromSeq` 永不出现（“预算到顶”检测不到 → 一次摘要永不触发）。
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
            // 构造多个小单元（user/assistant 交替），避免命中「最新单元自身超预算」的 truncate 路径，
            // 从而单独验证预算口径（校准系数 + tools JSON 预留）是否与真实请求估算同口径。
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
            // 包装真实 service：记录 compile 入参，同时保留真实编译结果与最近统计
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
            assert.ok(
                requestEstimate <= captured.budgetTokens,
                `请求体估算 ${requestEstimate} 应 ≤ 有效预算 ${captured.budgetTokens}`,
            );

            const stats = real.lastCompile();
            assert.ok(stats, '编译应写入最近编译统计');
            assert.notEqual(stats!.omittedFromSeq, null, '预算到顶必须能检测到 omittedFromSeq（否则一次摘要永不触发）');
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
     * 自动摘要与手动 `.ai ctx archive` 必须共用同一 CompactionRuntime：
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
                return '共享 runtime 摘要';
            },
            chatMessages: async () => '',
        } as any);
        try {
            const session = await makeSession('QQ:bridge-single-flight');
            resetContextRuntime(session);
            resetCompactionRuntime(session);
            const runtime = compactionRuntimeFor(session);
            assert.ok(runtime, '接入事件账本后应能取到共享运行时');
            assert.equal(compactionRuntimeFor(session), runtime, '自动路径与手动 archive 必须复用同一个 runtime');

            // 自动路径发起并阻塞在摘要 LLM 上；此时手动 archive 应被同一单飞挡下（不并发压同一批事件）
            const auto = compactContextV2(session, 1);
            await waitForCondition(() => summarizeCalls === 1, '自动摘要请求已发出');
            const manual = await runtime!.archiveNow(1);
            assert.equal(manual.ran, false, '自动摘要在飞时手动 archive 不得并发执行');
            assert.equal(manual.reason, 'running');
            assert.equal(summarizeCalls, 1, '被单飞挡下的手动调用不得额外调用摘要器');

            release!();
            const autoResult = await auto;
            assert.ok(autoResult, '自动路径应返回结果');
            assert.equal(autoResult!.advanced, true);
            assert.ok(summarizeCalls >= 1);

            // 共享 runtime 在自动摘要落地后仍可手动归档
            const after = await runtime!.archiveNow(1);
            assert.equal(after.ran, true);

            // purge/热重载语义：reset 后按当前 contextV2 重建 runtime
            resetCompactionRuntime(session);
            assert.notEqual(compactionRuntimeFor(session), runtime, 'reset 后应重建 runtime');
        } finally {
            setAuxLlm(null);
        }
    },
};

/** 等待异步副作用（fire-and-forget 的后台摘要） */
async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
