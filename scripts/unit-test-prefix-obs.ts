// #163 D7 rebase 白名单 + D9 观测单测（T14 组）：
// notePrefixRebase 记账 / 十个 reason / 缓存命中率滚动窗口 / 前缀漂移探针 / ArchiveControllerStatus 注入块视图。
//
// 为什么单独一个 bundle：这些断言的对照面是「Session 运行时字段 + ArchiveController.status()」，
// 与按域拆分的主入口无关；独立入口让失败定位更快，也避免污染大入口的装配前提。
import assert from 'node:assert/strict';

import { ArchiveController, ArchiveControllerStatus } from '../src/context/archive_controller';
import type { EventInput } from '../src/context/events';
import { resetInjectionTokenCache } from '../src/context/injections';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { ContextService } from '../src/context/service';
import { setHost } from '../src/core/host';
import { initBootRebaseCause, resetBootRebaseCauseForTest, takeBootRebaseCause } from '../src/core/prefix_boot';
import {
    configFingerprintOf,
    hasConfigHook,
    registerConfigHook,
    resetConfigFingerprints,
    runConfigHook,
    setConfigChangeListener,
} from '../src/config/hooks';
import { makeItem } from '../src/prompt/injections/keys';
import { CONFIG_REBASE_KEYS, SESSION_RUNTIME_KEYS } from '../src/session/persistence';
import { Session } from '../src/session/session';

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
    resetBootRebaseCauseForTest();
}

/** 十个白名单 reason（#163 REQ-D7-06 + 审核新增 inject-overflow） */
const REBASE_REASONS = [
    'archive', 'epoch', 'purge', 'edit', 'redact',
    `config:${CONFIG_REBASE_KEYS[0]}`, 'reload', 'upgrade', 'tools', 'summary-stale', 'inject-overflow',
];

let sidCounter = 0;

function newSession(): Session {
    sidCounter += 1;
    const session = new Session();
    session.sessionId = `QQ:prefix-obs-${sidCounter}`;
    session.context.sessionId = session.sessionId;
    return session;
}

/** 交替 user/assistant，保证每条消息独立成单元 */
function alternating(count: number, offset = 0): EventInput[] {
    const out: EventInput[] = [];
    for (let i = 0; i < count; i++) {
        const n = offset + i + 1;
        out.push(i % 2 === 0
            ? { kind: 'user', uid: 'QQ:1', msgId: `m${n}`, parts: [{ type: 'text', text: `消息${n}` }] } as EventInput
            : { kind: 'assistant', msgId: `a${n}`, parts: [{ type: 'text', text: `回复${n}` }] } as EventInput);
    }
    return out;
}

function makeController(service: ContextService, rebase?: () => { count: number; reason: string }): ArchiveController {
    return new ArchiveController({
        service,
        estimateEventTokens: () => 10,
        estimateTextTokens: (text: string) => text.length,
        ...(rebase ? { getRebaseStats: rebase } : {}),
    });
}

/** 直接往 store 追加事件（与单元测试既有做法一致，绕过 v2 投影缓存） */
function append(service: ContextService, inputs: EventInput[]): void {
    service.getStore().append(inputs);
}

export const tests: Record<string, () => void | Promise<void>> = {
    /** T14-01：rebase 记账字段正确（count 自增 / reason / throughSeq 归一化 / at 有值） */
    testNotePrefixRebaseFields() {
        resetEnv();
        const session = newSession();
        assert.equal(session.prefixRebase.count, 0, '初始应为 0 次');
        assert.equal(session.prefixRebase.reason, '', '初始应无原因');

        session.notePrefixRebase('archive', 12);
        assert.equal(session.prefixRebase.count, 1);
        assert.equal(session.prefixRebase.reason, 'archive');
        assert.equal(session.prefixRebase.throughSeq, 12);
        assert.ok(session.prefixRebase.at > 0, 'at 应被写入（毫秒时间戳）');

        session.notePrefixRebase('purge', 0);
        assert.equal(session.prefixRebase.count, 2, 'count 必须累加');
        assert.equal(session.prefixRebase.reason, 'purge', 'reason 覆盖为最近一次');
    },

    /** T14-02：throughSeq 归一化（负数/NaN/小数都不许进字段） */
    testNotePrefixRebaseNormalizesThroughSeq() {
        resetEnv();
        const session = newSession();
        session.notePrefixRebase('edit', -5);
        assert.equal(session.prefixRebase.throughSeq, 0, '负数收敛到 0');
        session.notePrefixRebase('edit', Number.NaN);
        assert.equal(session.prefixRebase.throughSeq, 0, 'NaN 收敛到 0');
        session.notePrefixRebase('edit', 7.9);
        assert.equal(session.prefixRebase.throughSeq, 7, '小数向下取整');
        session.notePrefixRebase('', 1);
        assert.equal(session.prefixRebase.reason, 'unknown', '空 reason 归一为 unknown');
    },

    /** T14-03：十个白名单 reason 全部可记账（不依赖真实时序，直接调方法） */
    testRebaseWhitelistCoversTenReasons() {
        resetEnv();
        const session = newSession();
        for (const reason of REBASE_REASONS) session.notePrefixRebase(reason, 0);
        assert.equal(session.prefixRebase.count, REBASE_REASONS.length);
        assert.equal(session.prefixRebase.reason, REBASE_REASONS[REBASE_REASONS.length - 1]);
        assert.equal(REBASE_REASONS.length, 11, '十 reason + 1 个 config:<key> 示例 = 11 条打点');
    },

    /** T14-04：rebase 必须同 tick 清空 prefixSnapshot（否则下一轮会拿旧基线判"漂移"） */
    testRebaseClearsPrefixSnapshot() {
        resetEnv();
        const session = newSession();
        session.prefixSnapshot = { messages: ['a', 'b'], throughSeq: 5 };
        session.notePrefixRebase('archive', 5);
        assert.equal(session.prefixSnapshot, null, 'rebase 后旧基线必须作废');
    },

    /** T14-05：观测事件只保留最近一条（运行时字段不得无界增长） */
    testNotePrefixObservationKeepsLatestOnly() {
        resetEnv();
        const session = newSession();
        session.notePrefixObservation('inject-window-violated', { tokens: 9000 });
        session.notePrefixObservation('injection-provider-failed', { name: 'core:memory' });
        assert.ok(session.prefixObservation);
        assert.equal(session.prefixObservation!.event, 'injection-provider-failed');
        assert.equal(session.prefixObservation!.detail.name, 'core:memory');
        assert.ok(session.prefixObservation!.at > 0);
    },

    /** T14-06：缓存窗口滚动（超过 100 轮淘汰最旧，累加值同步扣减） */
    testCacheWindowRollsOver() {
        resetEnv();
        const session = newSession();
        for (let i = 0; i < 100; i++) session.noteCacheUsage({ prompt_tokens: 100, cache_read_tokens: 80 });
        assert.equal(session.cacheWindow.turns, 100);
        assert.equal(session.cacheWindow.prompt, 10000);
        assert.equal(session.cacheWindow.read, 8000);

        // 第 101 轮：淘汰最旧一条（100/80），累加值必须同步扣减
        session.noteCacheUsage({ prompt_tokens: 200, cache_read_tokens: 20 });
        assert.equal(session.cacheWindow.turns, 100, '窗口长度恒定');
        assert.equal(session.cacheWindow.prompt, 10000 - 100 + 200);
        assert.equal(session.cacheWindow.read, 8000 - 80 + 20);
    },

    /** T14-07：prompt_tokens<=0 的轮次不计入（失败轮次不得压低命中率） */
    testCacheWindowIgnoresEmptyUsage() {
        resetEnv();
        const session = newSession();
        session.noteCacheUsage({ prompt_tokens: 0, cache_read_tokens: 0 });
        session.noteCacheUsage(null);
        session.noteCacheUsage(undefined);
        assert.equal(session.cacheWindow.turns, 0, '空 usage 不占窗口');
        session.noteCacheUsage({ prompt_tokens: 50 });
        assert.equal(session.cacheWindow.turns, 1);
        assert.equal(session.cacheWindow.read, 0, '缺 cache_read_tokens 按 0 计');
    },

    /** T14-08：前缀探针默认关闭（零成本），开启后字段可写 */
    testPrefixProbeDefaultsOff() {
        resetEnv();
        const session = newSession();
        assert.equal(session.prefixProbeEnabled, false, '默认关闭');
        assert.equal(session.prefixProbe.firstDiffIndex, null);
        session.prefixProbeEnabled = true;
        session.prefixProbe = { count: 3, hashes: ['a', 'b', 'c'], throughSeq: 9, firstDiffIndex: 1 };
        assert.equal(session.prefixProbe.firstDiffIndex, 1);
    },

    /** T14-09：观测字段全部不进持久化（不落盘 ⇒ 无迁移面） */
    testObservabilityFieldsAreRuntimeOnly() {
        const runtimeOnly = [
            'prefixRebase', 'prefixSnapshot', 'rebaseBootNoted', 'injectionAnchorSeq',
            'prefixObservation', 'lastSummaryStale', 'cacheWindow', 'prefixProbeEnabled', 'prefixProbe',
        ];
        for (const key of runtimeOnly) {
            assert.equal(SESSION_RUNTIME_KEYS.has(key), true, `${key} 必须排除持久化`);
        }
    },

    /** T14-10：引导期归因（首次安装无历史 ⇒ 不记 rebase；同版本同工具 ⇒ reload） */
    testBootRebaseCauseAttribution() {
        resetEnv();
        initBootRebaseCause('4.31.0', '[]');
        assert.equal(takeBootRebaseCause(), null, '首次安装不归因（无历史可污染）');

        resetEnv();
        initBootRebaseCause('4.31.0', '[]');
        initBootRebaseCause('4.31.0', '[]');
        assert.equal(takeBootRebaseCause(), 'reload', '同版本同工具 ⇒ 热重载');

        resetEnv();
        initBootRebaseCause('4.31.0', '[]');
        initBootRebaseCause('4.32.0', '[]');
        assert.equal(takeBootRebaseCause(), 'upgrade', '版本变化 ⇒ 升级');

        resetEnv();
        initBootRebaseCause('4.31.0', '[]');
        initBootRebaseCause('4.31.0', '[{"name":"grep_raw"}]');
        assert.equal(takeBootRebaseCause(), 'tools', '工具 schema 变化 ⇒ tools');
    },

    /** T14-11：归因是一次性的（取走后不重复记账） */
    testBootRebaseCauseIsOneShot() {
        resetEnv();
        initBootRebaseCause('1.0.0', '[]');
        initBootRebaseCause('1.0.0', '[]');
        assert.equal(takeBootRebaseCause(), 'reload');
        assert.equal(takeBootRebaseCause(), null, '第二次取走应为 null');
    },

    /** T14-12：ArchiveControllerStatus 扩展字段齐备（D9-02） */
    testArchiveStatusHasInjectionFields() {
        resetEnv();
        const service = ContextService.openSync('QQ-Group:prefix-obs-status', { estimateEventTokens: () => 10 });
        append(service, alternating(4));
        const controller = makeController(service, () => ({ count: 3, reason: 'archive' }));
        const status: ArchiveControllerStatus = controller.status();
        assert.equal(status.rebases, 3, 'rebase 次数应透传');
        assert.equal(status.lastRebaseCause, 'archive', '最近原因应透传');
        assert.equal(status.activeInjectTokens, 0, '无注入块时为 0');
        assert.deepEqual(status.blocks, [], '无注入块时为空数组');
    },

    /** T14-13：无 getRebaseStats 注入时安全降级（不抛、报 0/空） */
    testArchiveStatusWithoutRebaseStats() {
        resetEnv();
        const service = ContextService.openSync('QQ-Group:prefix-obs-nostats', { estimateEventTokens: () => 10 });
        const controller = makeController(service);
        const status = controller.status();
        assert.equal(status.rebases, 0);
        assert.equal(status.lastRebaseCause, '');
    },

    /** T14-14：注入块必须出现在 status().blocks 里且标 active（D9-02 可观测性） */
    async testArchiveStatusListsActiveInjectionBlocks() {
        resetEnv();
        const service = ContextService.openSync('QQ-Group:prefix-obs-blocks', { estimateEventTokens: () => 10 });
        append(service, alternating(4));
        const seqs = service.appendInjection({
            kind: 'time',
            afterSeq: 4,
            items: [makeItem('time:1', 'Current time: 2026-11-10')],
        });
        assert.equal(seqs.length, 1, '应写入 1 个注入块');
        const controller = makeController(service);
        const status = controller.status();
        assert.equal(status.blocks.length, 1, 'status 必须能看到该块');
        assert.equal(status.blocks[0].kind, 'time');
        assert.equal(status.blocks[0].afterSeq, 4);
        assert.equal(status.blocks[0].itemCount, 1);
        assert.equal(status.blocks[0].state, 'active', '未归档 ⇒ active');
        assert.ok(status.activeInjectTokens > 0, 'activeInjectTokens 应计入该块');
    },

    /** T14-15：注入 token 不进 unarchivedTokens 账本（AUDIT-001：否则 T 双计） */
    async testInjectionTokensStayOutOfLedger() {
        resetEnv();
        const service = ContextService.openSync('QQ-Group:prefix-obs-ledger', { estimateEventTokens: () => 10 });
        append(service, alternating(4));
        const before = service.head().unarchivedTokens;
        service.appendInjection({
            kind: 'memory',
            afterSeq: 4,
            items: [makeItem('memory:1', '记得他喜欢猫')],
        });
        assert.equal(service.head().unarchivedTokens, before, '注入块不得进入未归档账本');
        await service.flush();
    },

    // -----------------------------------------------------------------------
    // T14-16~19 / D7-06 ⑤ `config:<key>` rebase 归因的指纹基线语义
    // -----------------------------------------------------------------------

    /**
     * T14-16：**首次观察只建基线、不通知**（#163 启动期假 rebase 的根因修复）。
     *
     * `Config.registerConfig()` 只预热 `model` 一个分区，其余分区首次读取发生在监听器注册之后；
     * 若把"没有旧指纹"当成"变化"，`.ai ctx` 一上线就会显示"已重建 N 次"，真故障被淹没。
     */
    testConfigFingerprintFirstObservationIsBaseline() {
        resetConfigFingerprints();
        const changes: string[] = [];
        setConfigChangeListener((key) => { changes.push(key); });
        try {
            runConfigHook('context', { retainPercent: 30 });
            assert.deepEqual(changes, [], '首次观察只建基线，绝不广播');
            assert.ok(configFingerprintOf('context'), '基线指纹应已写入');
            // 第二次读到**相同**数据：仍不广播
            runConfigHook('context', { retainPercent: 30 });
            assert.deepEqual(changes, [], '数据未变不得广播');
        } finally {
            setConfigChangeListener(null);
            resetConfigFingerprints();
        }
    },

    /** T14-17：数据变化才广播，且 key 原样透出（供外层拼 `config:<key>`） */
    testConfigFingerprintBroadcastsOnRealChange() {
        resetConfigFingerprints();
        const changes: string[] = [];
        setConfigChangeListener((key) => { changes.push(key); });
        try {
            runConfigHook('tool', { blocked: [] });
            runConfigHook('tool', { blocked: ['run_ext_command'] });
            assert.deepEqual(changes, ['tool'], '一次变化只广播一次');
            runConfigHook('tool', { blocked: ['run_ext_command'] });
            assert.deepEqual(changes, ['tool'], '重复读同值不再广播');
            runConfigHook('context', { retainPercent: 20 });
            assert.deepEqual(changes, ['tool'], '另一个分区首次读取仍是基线，不广播');
            runConfigHook('context', { retainPercent: 40 });
            assert.deepEqual(changes, ['tool', 'context'], '第二个分区变化才广播自己的 key');
        } finally {
            setConfigChangeListener(null);
            resetConfigFingerprints();
        }
    },

    /**
     * T14-18：**有钩子的分区**同样参与指纹判定（`observeConfigFingerprint` 在钩子之后调用）。
     *
     * 若只观察无钩子分区，`config:<key>` 白名单里的大部分分区会被漏记。
     */
    testConfigFingerprintObservedAfterHook() {
        resetConfigFingerprints();
        const changes: string[] = [];
        const seenByHook: string[] = [];
        setConfigChangeListener((key) => { changes.push(key); });
        registerConfigHook('memory', (_key, data) => {
            seenByHook.push(JSON.stringify(data));
            return data;
        });
        try {
            assert.equal(hasConfigHook('memory'), true);
            runConfigHook('memory', { window: 8 });
            runConfigHook('memory', { window: 16 });
            assert.deepEqual(changes, ['memory'], '钩子分区的变化也必须广播');
            assert.deepEqual(seenByHook, ['{"window":8}', '{"window":16}'], '钩子应在指纹判定前执行');
        } finally {
            registerConfigHook('memory', (_key, data) => data);
            setConfigChangeListener(null);
            resetConfigFingerprints();
        }
    },

    /**
     * T14-19：监听器/序列化异常**不得**影响配置读取（失败软着陆）。
     *
     * 配置总线是启动路径，任何观测逻辑都不许把读配置弄崩。
     */
    testConfigFingerprintFailSoft() {
        resetConfigFingerprints();
        setConfigChangeListener(() => { throw new Error('listener boom'); });
        try {
            runConfigHook('context', { retainPercent: 30 });
            const out = runConfigHook('context', { retainPercent: 60 });
            assert.deepEqual(out, { retainPercent: 60 }, '监听器抛错 ⇒ 配置照常返回新数据');
        } finally {
            setConfigChangeListener(null);
            resetConfigFingerprints();
        }

        // 不可序列化数据：跳过指纹（宁可漏记，不可误记），且不抛
        resetConfigFingerprints();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        assert.equal(runConfigHook('role', cyclic), cyclic, '循环引用配置照常返回');
        assert.equal(configFingerprintOf('role'), undefined, '不可序列化 ⇒ 不建指纹');
    },
};
