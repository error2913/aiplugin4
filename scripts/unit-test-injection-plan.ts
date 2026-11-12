// #163 D3 接线层单测：`planAndWriteInjections` 的四种早退、写块、稳态零注入、provider 异常分流。
//
// 为什么单独一个 bundle：这一层是「provider 产出 → 写块」的**接线**，被测点是
// "什么时候根本不跑 / 什么时候真的落库 / provider 抛错怎么分流"，与 provider 内部逻辑无关。
import assert from 'node:assert/strict';

import Config from '../src/config/config';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import type { EventInput } from '../src/context/events';
import { planAndWriteInjections } from '../src/context/injection_plan';
import { resetInjectionTokenCache } from '../src/context/injections';
import { ContextService } from '../src/context/service';
import { setHost } from '../src/core/host';
import { registerInjectionProvider, resetInjectionProviders } from '../src/prompt/injection_registry';
import type { InjectionItem } from '../src/context/injections';
import type { InjectionProvider } from '../src/prompt/types';
import { Session } from '../src/session/session';

Config.registerConfig();

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

let storage = new FakeStorage();
let sidCounter = 0;

function installHost(): void {
    setMissingKeyErrorDetector((error) => /key not found|not found/i.test(error instanceof Error ? error.message : String(error)));
    setHost({
        storage: {
            get: (key: string) => storage.get(key),
            set: (key: string, value: string) => storage.set(key, value),
        },
        clock: { now: () => Date.now() },
        fetch: (() => { throw new Error('no fetch in unit test'); }) as any,
        ext: {} as any,
    });
}

function resetEnv(): void {
    storage = new FakeStorage();
    installHost();
    resetInjectionTokenCache();
    resetInjectionProviders();
    sidCounter += 1;
}

/** system 消息桩：与 `compileV2Request` 的 `prefix[0]` 同源形状 */
const SYSTEM_MESSAGE = { role: 'system', contentItems: [{ text: '你是测试机器人。' }] } as never;

/** 造一个"已接入事件账本 + 有历史"的会话（历史是为了让 anchor 不落在 0） */
interface Harness {
    session: Session;
    service: ContextService;
    /** 最后一次写入的 anchor（= 本轮 lastSentSeq） */
    lastSentSeq: number;
}

function makeSession(history = 6): Harness {
    const session = new Session();
    session.sessionId = `QQ-Group:inject-plan-${sidCounter}`;
    session.agentName = 'tester';
    session.sessionType = 'group';
    const service = ContextService.openSync(session.sessionId, { estimateEventTokens: () => 10 });
    session.contextV2 = service;
    session.context.sessionId = session.sessionId;
    const events: EventInput[] = [];
    for (let i = 1; i <= history; i++) {
        events.push(i % 2 === 1
            ? { kind: 'user', uid: 'QQ:1', msgId: `p${i}`, parts: [{ type: 'text', text: `消息${i}` }] } as EventInput
            : { kind: 'assistant', msgId: `pa${i}`, parts: [{ type: 'text', text: `回复${i}` }] } as EventInput);
    }
    if (events.length > 0) service.getStore().append(events);
    return { session, service, lastSentSeq: events.length };
}

function runPlan(h: Harness) {
    return planAndWriteInjections({
        ctx: { endPoint: { platform: 'QQ', userId: 'QQ:1' }, isPrivate: false } as never,
        session: h.session,
        systemMessage: SYSTEM_MESSAGE,
        tools: undefined,
        modelName: undefined,
        lastSentSeq: h.lastSentSeq,
    });
}

/** 最简单的 provider：固定产出给定条目，不读 `listActiveKeys`（用来验证框架层去重） */
function fixedProvider(name: string, kind: string, items: InjectionItem[], extra: Partial<InjectionProvider> = {}): InjectionProvider {
    return { name, kind, order: 100, ...extra, build: () => items };
}

const ITEM_X: InjectionItem = { k: 'test:x', r: 1, h: 1001, text: '测试注入条目' };

export const tests: Record<string, () => void | Promise<void>> = {
    /** 早退 ①：`session.contextV2` 为空（v1 旧路径）⇒ 返回 null，不碰事件账本 */
    async testPlanReturnsNullWithoutContextV2() {
        resetEnv();
        registerInjectionProvider(fixedProvider('core:plan', 'test', [ITEM_X]));
        const session = new Session();
        session.sessionId = 'QQ:inject-plan-v1';
        assert.equal(session.contextV2, null, '前提：v1 会话没有 contextV2');
        const result = await planAndWriteInjections({
            ctx: {} as never,
            session,
            systemMessage: SYSTEM_MESSAGE,
            tools: undefined,
            modelName: undefined,
            lastSentSeq: 0,
        });
        assert.equal(result, null, 'v1 路径必须直接返回 null');
        assert.equal(session.injectionAnchorSeq, 0, '早退不得推进 anchor');
    },

    /** 早退 ②：没有注册任何 provider ⇒ 返回 null（**不构造 context、不建索引**，稳态零成本） */
    async testPlanReturnsNullWithoutProviders() {
        resetEnv();
        const h = makeSession();
        assert.equal((await runPlan(h)), null, '无 provider ⇒ null');
        assert.equal(h.service.snapshot().events.length, 6, '早退不得写入任何事件');
    },

    /**
     * 早退 ③：有 provider 但产出为空 ⇒ 返回全零结果（**不是** null）。
     *
     * 语义差别：null = "这轮压根没跑"；全零 = "跑了但没东西要写"（用于观测统计）。
     */
    async testPlanReturnsZeroResultWhenProviderProducesNothing() {
        resetEnv();
        registerInjectionProvider(fixedProvider('core:plan', 'test', []));
        const h = makeSession();
        const result = await runPlan(h);
        assert.ok(result, '有 provider 时不应返回 null');
        assert.deepEqual(
            { blocks: result!.blocks, items: result!.items, duplicates: result!.duplicates, skipped: result!.skipped },
            { blocks: 0, items: 0, duplicates: 0, skipped: 0 },
        );
        assert.equal(h.service.snapshot().events.length, 6, '零产出不得写块');
    },

    /** 早退 ④：provider 产出全被 `keepValidItems` 过滤（空键/空正文）⇒ 同样零结果 */
    async testPlanDropsInvalidItems() {
        resetEnv();
        registerInjectionProvider(fixedProvider('core:plan', 'test', [
            { k: '', r: 1, h: 1, text: '空键' },
            { k: 'test:blank', r: 1, h: 2, text: '   ' },
        ]));
        const h = makeSession();
        const result = await runPlan(h);
        assert.equal(result!.items, 0, '脏条目必须丢弃');
        assert.equal(h.service.snapshot().events.length, 6);
    },

    /**
     * 主路径：1 个 provider 产出 1 条 ⇒ 写入 1 个块、事件 +1、`head.unarchivedTokens` **不变**。
     *
     * 最后一条是 AUDIT-001（P0）的接线级复核：注入 token 绝不能进未归档账本。
     */
    async testPlanWritesBlockAndKeepsLedgerClean() {
        resetEnv();
        registerInjectionProvider(fixedProvider('core:plan', 'test', [ITEM_X]));
        const h = makeSession();
        const beforeEvents = h.service.snapshot().events.length;
        const beforeTokens = h.service.head().unarchivedTokens;
        const result = await runPlan(h);
        assert.equal(result!.blocks, 1, '应写入 1 个块');
        assert.equal(result!.items, 1);
        assert.ok(result!.tokens > 0, '块 token 应为正');
        assert.deepEqual(result!.seqs, [beforeEvents + 1], '块 seq 紧随历史末尾');
        assert.equal(h.service.snapshot().events.length, beforeEvents + 1, '事件数 +1');
        assert.equal(h.service.head().unarchivedTokens, beforeTokens, '注入 token 不得进入未归档账本');
        const injected = h.service.snapshot().events[beforeEvents] as any;
        assert.equal(injected.systemName, 'inject-test', '块必须标记来源（systemName=inject-<kind>）');
        assert.equal(injected.raw.injection.afterSeq, h.lastSentSeq, 'anchor = lastSentSeq');
        await h.service.flush();
    },

    /**
     * 稳态零注入：同一个条目第二轮再产出 ⇒ `duplicates === 1`、`blocks === 0`。
     *
     * 这是"每轮零成本"的核心断言：provider 允许重复产出，框架必须靠活动块索引挡住。
     */
    async testPlanSecondRoundIsAllDuplicates() {
        resetEnv();
        registerInjectionProvider(fixedProvider('core:plan', 'test', [ITEM_X]));
        const h = makeSession();
        const first = await runPlan(h);
        assert.equal(first!.blocks, 1);
        // 第二轮：请求已把上一轮写到 seq=6 的内容发出去 ⇒ anchor 推进到 7（含新块）
        h.lastSentSeq = h.service.head().nextSeq - 1;
        const second = await runPlan(h);
        assert.equal(second!.blocks, 0, '内容已在活动块里 ⇒ 不写块');
        assert.equal(second!.duplicates, 1, '应统计为 dup（不是"跳注"）');
        assert.equal(second!.skipped, 0, '真正的跳注恒为 0');
        await h.service.flush();
    },

    /** provider 抛错且 `optional !== false`（外部插件）⇒ 不抛、本轮 0 块、记观测 */
    async testPlanSwallowsOptionalProviderFailure() {
        resetEnv();
        registerInjectionProvider({
            name: 'ext:plan:broken',
            kind: 'test',
            order: 200,
            build: () => { throw new Error('provider boom'); },
        });
        const h = makeSession();
        const result = await runPlan(h);
        assert.equal(result!.blocks, 0, '失败的 provider 本轮不产块');
        assert.equal(h.service.snapshot().events.length, 6, '不得写任何块');
        assert.equal(h.session.prefixObservation?.event, 'injection-provider-failed', '必须记观测');
        assert.equal((h.session.prefixObservation?.detail as any).name, 'ext:plan:broken');
    },

    /** provider 抛错且 `optional === false`（内置）⇒ **上抛**，让请求按既有错误路径处理 */
    async testPlanThrowsForMandatoryProviderFailure() {
        resetEnv();
        registerInjectionProvider({
            name: 'core:plan',
            kind: 'test',
            order: 100,
            optional: false,
            build: () => { throw new Error('builtin boom'); },
        });
        const h = makeSession();
        await assert.rejects(() => runPlan(h), /builtin boom/, '内置 provider 失败必须上抛');
        assert.equal(h.service.snapshot().events.length, 6, '上抛前不得写块');
    },

    /**
     * 多 provider 同 kind ⇒ 合并成一个块（REQ-D3-05），且顺序按 order 升序。
     *
     * 顺序重要：`InjectionItem` 数组顺序直接决定块的渲染字节（R2 要求确定性）。
     */
    async testPlanMergesSameKindProvidersInOrder() {
        resetEnv();
        registerInjectionProvider(fixedProvider('core:plan-b', 'test', [
            { k: 'test:b', r: 1, h: 2002, text: '第二条' },
        ], { order: 200 }));
        registerInjectionProvider(fixedProvider('core:plan-a', 'test', [
            { k: 'test:a', r: 1, h: 1001, text: '第一条' },
        ], { order: 100 }));
        const h = makeSession();
        const result = await runPlan(h);
        assert.equal(result!.blocks, 1, '同 kind 只写一个块');
        assert.equal(result!.items, 2);
        const block = h.service.snapshot().events[6] as any;
        assert.equal(block.raw.injection.items[0].k, 'test:a', 'order 小的 provider 排前面');
        assert.equal(block.raw.injection.items[1].k, 'test:b');
        await h.service.flush();
    },

    /**
     * `listActiveKeys()` 必须招募到上一轮写入的条目键（provider 靠它做"已注入"判定）。
     *
     * 这里直接断言 provider 侧看到的集合，避免 provider 自己重复扫描。
     */
    async testPlanExposesActiveKeysToProvider() {
        resetEnv();
        let seen: string[] = [];
        registerInjectionProvider({
            name: 'core:plan',
            kind: 'test',
            order: 100,
            build: (c) => {
                seen = Array.from(c.listActiveKeys());
                // 已注入过就不再产出（模拟真实 provider 的零成本稳态）
                return seen.includes(ITEM_X.k) ? [] : [ITEM_X];
            },
        });
        const h = makeSession();
        await runPlan(h);
        assert.deepEqual(seen, [], '第一轮活动块为空');
        h.lastSentSeq = h.service.head().nextSeq - 1;
        const second = await runPlan(h);
        assert.deepEqual(seen, [ITEM_X.k], '第二轮必须能看到上一轮的条目键');
        assert.equal(second!.blocks, 0, 'provider 自己挡住 ⇒ 不写块且不计 dup');
        await h.service.flush();
    },
};
