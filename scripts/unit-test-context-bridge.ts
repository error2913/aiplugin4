// 记忆桥单测：v2 事件消费、成功推进水位、失败不推进/幂等。
import assert from 'node:assert/strict';

import Agent from '../src/agent/agent';
import { compactContextV2, collectContextBacklog, commitExtraction, consumeContextV2, consumedThrough, peekExtractionChunk, resetContextRuntime, resetContextBridgeCursor } from '../src/agent/context_bridge';
import { MemoryScheduler, resetMemorySchedulerForTest } from '../src/agent/memory_scheduler';
import Config from '../src/config/config';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import { setAuxLlm } from '../src/core/ports/aux_llm';
import { MemoryManager } from '../src/memory/manager';
import { MemoryService, setMemoryEngineFactory } from '../src/memory/service';
import { MemoryEngine } from '../src/memory/v2/engine';
import { InMemoryMemoryStorage } from '../src/memory/v2/storage';
import { SessionService } from '../src/session/session_service';

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
};
