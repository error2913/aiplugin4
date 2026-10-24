// 记忆桥单测：v2 事件消费、成功推进水位、失败不推进/幂等。
import assert from 'node:assert/strict';

import Agent from '../src/agent/agent';
import Config from '../src/config/config';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { setHost } from '../src/core/host';
import { consumeContextV2, consumedThrough, resetContextBridgeCursor } from '../src/agent/context_bridge';
import { MemoryManager } from '../src/memory/manager';
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
        await session.context.addUserMessage({} as seal.MsgContext, `记忆桥消息 ${i} `.repeat(20), 'QQ:1', `mb${i}`);
    }
    return session;
}

export const tests: Record<string, () => void | Promise<void>> = {
    async testContextBridgeConsumesAndAdvances() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算水位'] = 1;
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算空闲门槛'] = 0;
        (Config as any).cache = {};
        const original = MemoryManager.summarizeChunkWithRetry;
        let calls = 0;
        (MemoryManager as any).summarizeChunkWithRetry = async () => { calls++; return true; };
        try {
            const session = await makeSession('QQ:bridge-ok');
            resetContextBridgeCursor(session);
            const consumed = await consumeContextV2(session);
            assert.ok(consumed > 0);
            assert.equal(calls, 1);
            assert.ok(consumedThrough(session) >= 1);
            assert.equal(await consumeContextV2(session), 0, '水位已推进，无新事件不重复消费');
        } finally {
            (MemoryManager as any).summarizeChunkWithRetry = original;
        }
    },

    async testContextBridgeFailureKeepsCursor() {
        installHost();
        (globalThis as any).__TEST_CONFIG__.intConfigs['结算水位'] = 1;
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
};
