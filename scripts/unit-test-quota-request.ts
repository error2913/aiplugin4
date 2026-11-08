// 用量限制 × 模型请求链路单测（P1 C3/C6）。
//
// 与 unit-test-quota.ts 分开的原因：本组用例要替换 **全局 fetch** 与 Config.base/backend，
// 与被测内核用例的 HostSeam 桩互不干扰；单独进程级隔离更稳。
//
// 覆盖：
// - `requestModel` 的 admit 只在重试循环外过 1 次（3 次网络失败 = 1 次预留）；
// - `record` 抛错不会让已成功的请求被重试（AC-16：fetch 只调用 1 次）；
// - `endStream` 失败路径释放预留 + 删除 streamMeta（既有泄漏修复）；
// - `endStream` 结算归因优先「起流时刻」身份，不被调用方传入覆盖。
import assert from 'node:assert/strict';

import { streamService } from '../src/agent/stream';
import Config from '../src/config/config';
import type { QuotaConfigView } from '../src/config/configs/quota';
import { setHost } from '../src/core/host';
import { ModelEntry } from '../src/model/entry';
import { __testHooks, requestModel } from '../src/model/provider';
import { QuotaManager } from '../src/quota/manager';
import { loadStore, resetStoreCacheForTest } from '../src/quota/store';
import type { QuotaReserveHandle } from '../src/quota/types';

class MemoryStorage {
    map = new Map<string, string>();
    get(key: string): string | null {
        return this.map.has(key) ? this.map.get(key)! : null;
    }
    set(key: string, value: string): void {
        this.map.set(key, value);
    }
}

let storage = new MemoryStorage();
let clockNow = 0;

/** 固定在一个 5 小时窗口内（本地时间 2026-11-05 10:00） */
const AT = new Date(2026, 10, 5, 10, 0, 0).getTime();

function setup(): void {
    clockNow = AT;
    storage = new MemoryStorage();
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => clockNow },
        fetch: (() => { throw new Error('host fetch not used by provider/stream'); }) as never,
        ext: {} as never,
    });
    (Config as unknown as { base: unknown }).base = { TIMEOUT: 5000 };
    (Config as unknown as { backend: unknown }).backend = { STREAM: 'http://backend.invalid/stream', STREAM_TOKEN: '' };
    resetStoreCacheForTest();
    QuotaManager.reset();
    QuotaManager.releaseAllInflightForTest();
    QuotaManager.clearNotifiedForTest();
    QuotaManager.configure(() => view());
    streamService.resetStreamMetaForTest();
}

function view(over: Partial<QuotaConfigView> = {}): QuotaConfigView {
    return {
        ENABLED: true,
        LIMIT_5H: 1_000_000,
        LIMIT_WEEK: 10_000_000,
        LIMIT_MONTH: 40_000_000,
        SESSION_PERCENT: 100,
        USER_PERCENT: 100,
        PEAK_RULE: { segments: [], warnings: [] },
        PURPOSE_PERCENT: {
            summarization: 100,
            judge: 100,
            'image-understanding': 100,
            'text-embedding': 100,
        },
        NOTIFY_ON_LIMIT: false,
        ...over,
    };
}

/** 替换全局 fetch；返回还原函数与调用计数 */
function stubFetch(impl: (url: string, init?: any) => Promise<any>): { calls: number; restore: () => void } {
    const original = (globalThis as unknown as { fetch: unknown }).fetch;
    const state = { calls: 0 };
    (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: any) => {
        state.calls++;
        return impl(url, init);
    };
    return {
        get calls() { return state.calls; },
        restore: () => { (globalThis as unknown as { fetch: unknown }).fetch = original; },
    };
}

/** OpenAI 兼容成功响应（带 usage） */
function okResponse(prompt = 100, completion = 50): any {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            model: 'fake-model',
            choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        }),
        headers: { get: () => null },
    };
}

/** 429（rate_limit ⇒ 可重试）失败响应 */
async function rateLimited(): Promise<any> {
    return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit' } }),
        headers: { get: () => null },
    };
}

export const tests: Record<string, () => void | Promise<void>> = {
    /** C3：重试 3 次只预留 1 次（预留必须在重试循环外） */
    async testProviderAdmitOutsideRetry(): Promise<void> {
        setup();
        const fetchStub = stubFetch(rateLimited);
        const original = QuotaManager.admitChat;
        let admits = 0;
        (QuotaManager as unknown as { admitChat: unknown }).admitChat = (...args: unknown[]) => {
            admits++;
            // 必须是方法调用（`this` 绑定 QuotaManager），原实现内部读 this.evaluate/this.inflight
            return (original as (...a: unknown[]) => QuotaReserveHandle).apply(QuotaManager, args);
        };
        try {
            await assert.rejects(
                () => requestModelWith(),
                // 网络/限速类失败最终仍抛分类错误（不是配额错误）
                (e: unknown) => (e as Error).name === 'ApiError',
            );
            assert.equal(fetchStub.calls, 3, '429 可重试：应请求 3 次（1 + MAX_RETRIES）');
            assert.equal(admits, 1, '重试循环外只预留一次，否则额度被重复占用');
            assert.deepEqual(QuotaManager.inflightSnapshotForTest(), { total: 0, sessions: 0, users: 0 }, '失败路径必须释放预留');
        } finally {
            (QuotaManager as unknown as { admitChat: unknown }).admitChat = original;
            fetchStub.restore();
        }
    },

    /** C3/AC-16：记账抛错不得让已成功的请求被重试（否则二次计费） */
    async testRecordThrowingDoesNotRetry(): Promise<void> {
        setup();
        const fetchStub = stubFetch(async () => okResponse());
        const original = __testHooks.record;
        __testHooks.record = () => { throw new Error('boom'); };
        try {
            const data = await requestModelWith();
            assert.equal(data.choices.length, 1);
            assert.equal(fetchStub.calls, 1, '记账异常必须被吞掉，不能触发重试');
        } finally {
            __testHooks.record = original;
            fetchStub.restore();
        }
    },

    /** C6：endStream 失败路径必须释放预留并删除 streamMeta（既有 Map 泄漏修复） */
    async testStreamHandleReleasedOnFailure(): Promise<void> {
        setup();
        let released = 0;
        const handle: QuotaReserveHandle = { est: 100, release: () => { released++; } };
        streamService.seedStreamMetaForTest('stream-fail', {
            modelName: 'fake-model',
            rawEstimate: 100,
            startedAt: Date.now(),
            handle,
            identity: { sessionId: 'QQ-Group:1', userId: 'QQ:1' },
        });
        const fetchStub = stubFetch(async () => ({
            ok: false,
            status: 500,
            text: async () => 'boom',
            headers: { get: () => null },
        }));
        try {
            const status = await streamService.endStream('stream-fail', { sessionId: 'QQ-Group:1' });
            assert.equal(status, '', '失败态返回空串（保持既有契约）');
            assert.equal(released, 1, '失败路径必须释放预留句柄');
            assert.equal(streamService.pendingStreamCountForTest(), 0, '失败路径必须删除 streamMeta（原实现只在 success 内 delete）');
        } finally {
            fetchStub.restore();
        }
    },

    /** C6：结算归因优先「起流时刻」身份（长流期间会话再起一轮也不会记错） */
    async testEndStreamAttributionPrefersMeta(): Promise<void> {        setup();
        streamService.seedStreamMetaForTest('stream-ok', {
            modelName: 'fake-model',
            rawEstimate: 100,
            startedAt: Date.now(),
            identity: { sessionId: 'QQ-Group:started', userId: 'QQ:started' },
        });
        const fetchStub = stubFetch(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                status: 'success',
                model: 'fake-model',
                results: ['ok'],
                next_after: 0,
                usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            }),
            headers: { get: () => null },
        }));
        try {
            const status = await streamService.endStream('stream-ok', { sessionId: 'QQ-Group:later', userId: 'QQ:later' });
            assert.equal(status, 'success');
            const store = loadStore(AT);
            assert.equal(store.sessions['QQ-Group:started']?.h.v, 140, '记账应归到起流时刻的会话');
            assert.equal(store.sessions['QQ-Group:later'], undefined, '不得记到调用方后来传入的会话');
            assert.equal(store.total.h.v, 140, '总量维度同步累计');
            assert.equal(streamService.pendingStreamCountForTest(), 0, '成功路径也要清理 streamMeta');
        } finally {
            fetchStub.restore();
        }
    },

    /** AC-09：用途细闸拒绝时嵌入/识图各自按约定降级（不抛、不刷 error） */
    async testPurposeRejectionDegrades(): Promise<void> {
        setup();
        // 用途预算压到 1：先记满，之后任何用途请求都会被拒
        QuotaManager.configure(() => view({
            PURPOSE_PERCENT: { summarization: 1, judge: 1, 'image-understanding': 1, 'text-embedding': 1 },
        }));
        QuotaManager.record('text-embedding', 1_000_000, {});
        QuotaManager.record('image-understanding', 1_000_000, {});
        const fetchStub = stubFetch(async () => okResponse());
        const model = new ModelEntry(0, 'fake-model', 'test', 'http://upstream.invalid/v1', 'key', ['embed'], 'config');
        try {
            const vector = await model.callEmbedding('hello');
            assert.deepEqual(vector, [], '嵌入被拒应返回空数组（调用方回退关键词检索）');
            const text = await model.callITT('http://img.invalid/a.png', 'describe');
            assert.equal(text, '', '识图被拒应返回空串（调用方按文本标签处理）');
            assert.equal(fetchStub.calls, 0, '被拒时不该真的发出网络请求');
            assert.equal(QuotaManager.inflightSnapshotForTest().total, 0, '用途路径不预留 inflight');
        } finally {
            fetchStub.restore();
        }
    },
};

/** 发一次最小 chat 请求（走 requestModel 全链路：预留 → fetch → 记账 → 释放） */
function requestModelWith(): Promise<any> {
    return requestModel('http://upstream.invalid/v1/chat/completions', 'key', { model: 'fake-model', messages: [] }, {
        provider: 'test',
        api: 'openai-completions',
        use: 'chat',
        modelName: 'fake-model',
        rawEstimateTokens: 80,
        quotaEst: 200,
        quotaIdentity: { sessionId: 'QQ-Group:1', userId: 'QQ:1' },
    });
}
