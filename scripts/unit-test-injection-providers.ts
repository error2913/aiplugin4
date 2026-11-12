// #163 D3 内置注入 provider 单测：`core:memory`（预算三值 / 零成本稳态 / 按 k 拒发）与
// `core:mcp`（元数据 / 每 server 一条 / 按 k 拒发），以及两者的注册接线。
//
// 独立 bundle（不塞进 867KB 的 unit-test-entry.ts），风格与 scripts/unit-test-time-inject.ts 一致。
import assert from 'node:assert/strict';

import type { InjectionItem } from '../src/context/injections';
import { bankKindOfBankId, resolveGlobalBank } from '../src/memory/v2/bank_resolver';
import {
    computeInjectRoom,
    estimateActiveMemoryTokens,
    isMemoryItemKey,
    MEMORY_INJECT_DELTA,
    MEMORY_INJECT_MIN_ROOM,
    MEMORY_INJECT_WINDOW,
    parseMemoryPromptCandidates,
    selectInjectCandidates,
} from '../src/memory/v2/inject';
import { listInjectionProviders, resetInjectionProviders, resolveInjectionProviders } from '../src/prompt/injection_registry';
import { createMcpProvider } from '../src/prompt/injections/mcp';
import { createMemoryProvider } from '../src/prompt/injections/memory';
import { memoryItemKey } from '../src/prompt/injections/keys';
import { registerBuiltinInjectionProviders } from '../src/prompt/injections/index';
import type { PromptMemorySource } from '../src/prompt/memory_source';
import { setPromptMemorySource } from '../src/prompt/memory_source';
import { resetMcpInstructionsProvider, setMcpInstructionsProvider } from '../src/prompt/sections/mcp';
import type { InjectionContext, PromptFlags } from '../src/prompt/types';
import { estimateTextTokens } from '../src/utils/token_estimate';

/** 测试用平台上下文（`platformOf` 只读 endPoint） */
const CTX = { endPoint: { platform: 'QQ', userId: 'QQ:10001' }, isPrivate: false } as never;

const FLAGS = { memory: true } as PromptFlags;

/** 会话桩：provider 只读 `agentName`（global bank 用） */
const SESSION = { sessionId: 'QQ-Group:20002', agentName: 'tester' } as never;

function makeInjectionContext(over: Partial<InjectionContext> = {}): InjectionContext {
    const base: InjectionContext = {
        ctx: CTX,
        session: SESSION,
        flags: FLAGS,
        isPrivate: false,
        sessionId: 'QQ-Group:20002',
        query: 'anything',
        users: [],
        group: null,
        lastSentSeq: 0,
        now: 1_760_000_000_000,
        lastReplySeq: 0,
        lastReplyAt: 0,
        listActiveKeys: () => new Set<string>(),
        estimateTokens: estimateTextTokens,
    };
    return { ...base, ...over };
}

/** 记忆数据源桩：记录调用次数，返回固定渲染文本（形状与 `v2/prompt.buildMemoryPrompt` 一致） */
function installSpyMemorySource(text: string): { calls: () => number; restore: () => void } {
    let calls = 0;
    const source: PromptMemorySource = {
        initKnowledge: async () => undefined,
        knowledgeSignature: () => '',
        knowledgeIds: () => [],
        formatKnowledgeFor: () => '',
        memoryRevision: () => 0,
        summaryRevision: () => 0,
        buildLongTermPrompt: async () => {
            calls++;
            return text;
        },
        buildObservationPrompt: () => '',
    };
    setPromptMemorySource(source);
    return {
        calls: () => calls,
        restore: () => setPromptMemorySource(null),
    };
}

/** 与 `buildMemoryPrompt` 同形的渲染文本：群段（scopeLabel）+ global 段 */
const MEMORY_TEXT = [
    '## Group chat memory (测试群)',
    'Group: QQ-Group:20002',
    '- [mem:obs1] 用户喜欢喝绿茶。',
    '- [mem:obs2] 用户住在杭州。',
    '',
    '## Self experience (global)',
    '- [mem:g1] 这个群的规矩是晚上 11 点后不 @ 人。',
].join('\n');

/** 批量造记忆条目键（唯一），用于构造"窗口快满"的活动集合 */
function activeMemoryKeys(count: number): Set<string> {
    const keys = new Set<string>();
    for (let i = 0; i < count; i++) keys.add(`user_u1|observation|o${i}`);
    return keys;
}

export const tests = {
    // ----- 预算三值（r2 §2.3） -------------------------------------------------

    /** room：首次 / 归档后取 min(MEMORY_PROMPT_TOKENS, WINDOW) */
    testInjectRoomFirstInjection(): void {
        assert.equal(computeInjectRoom(0, 2048), 2048);
        // 存量用户可能仍存 3000（< 窗口 4096）⇒ 首次就 3000，行为与改前一致
        assert.equal(computeInjectRoom(0, 3000), 3000);
        // 超过窗口则夹到 4096
        assert.equal(computeInjectRoom(0, 5000), MEMORY_INJECT_WINDOW);
        // 非法/缺省配置回退出厂默认 2048
        assert.equal(computeInjectRoom(0, Number.NaN), 2048);
        assert.equal(computeInjectRoom(0, 0), 2048);
        assert.equal(computeInjectRoom(0), 2048);
    },

    /** room：稳态取 min(DELTA, WINDOW − active)，可为负（= 已满，本轮不注） */
    testInjectRoomSteadyState(): void {
        assert.equal(computeInjectRoom(1000, 2048), MEMORY_INJECT_DELTA);
        // 4096 − 4000 = 96 < DELTA ⇒ 取剩余量
        assert.equal(computeInjectRoom(4000, 2048), 96);
        // 恰好满额 ⇒ 0（只停注、不强释放）
        assert.equal(computeInjectRoom(MEMORY_INJECT_WINDOW, 2048), 0);
        // 超过窗口 ⇒ 负值（调用方按 < MIN_ROOM 处理）
        assert.equal(computeInjectRoom(MEMORY_INJECT_WINDOW + 100, 2048), -100);
        // 非法入参按 0 处理
        assert.equal(computeInjectRoom(Number.NaN, 2048), 2048);
        assert.equal(computeInjectRoom(-5, 2048), 2048);
    },

    /** 活动条目粗估只数记忆条目，结构键（memory:heading 等）不计入 */
    testEstimateActiveMemoryTokens(): void {
        assert.equal(estimateActiveMemoryTokens(new Set()), 0);
        assert.equal(estimateActiveMemoryTokens(new Set(['memory:heading', 'memory:tail', 'mcp:foo'])), 0);
        assert.equal(isMemoryItemKey('group_QQ-Group:1|observation|o1'), true);
        assert.equal(isMemoryItemKey('user_QQ:1|mental_model|mm1'), true);
        assert.equal(isMemoryItemKey('global_main|fact|f1'), true);
        assert.equal(isMemoryItemKey('memory:heading'), false);
        assert.equal(estimateActiveMemoryTokens(activeMemoryKeys(3)) > 0, true);
    },

    /** 候选选择：已注入跳过、同批同文去重、预算不够整条留到下轮（不碎片化） */
    testSelectInjectCandidatesBudgetAndDedup(): void {
        const candidates = parseMemoryPromptCandidates(MEMORY_TEXT, {
            globalBankId: resolveGlobalBank('tester').bankId,
        });
        assert.equal(candidates.length, 3);
        // 第一条候选就是要注入的群组观察
        assert.equal(candidates[0].bankId, 'group_QQ-Group:20002');
        assert.equal(candidates[0].kind, 'observation');
        assert.equal(candidates[0].id, 'obs1');
        assert.match(candidates[0].line, /^- \[mem:obs1\] 用户喜欢喝绿茶。$/);

        // 已有两条在活动块里 ⇒ 只剩 global 那条
        const active = new Set([
            memoryItemKey('group_QQ-Group:20002', 'observation', 'obs1'),
            memoryItemKey('group_QQ-Group:20002', 'observation', 'obs2'),
        ]);
        const selection = selectInjectCandidates(candidates, active, 4096, estimateTextTokens);
        assert.equal(selection.picked.length, 1);
        assert.equal(selection.picked[0].id, 'g1');

        // 余量为 0：第一条仍放行（否则一条超长记忆会永久饿死整个注入）
        const tight = selectInjectCandidates(candidates, new Set<string>(), 0, () => 100);
        assert.equal(tight.picked.length, 1);
        assert.equal(tight.skippedBudget, 0);
        // 余量只够一条：第二条起因预算中断（整条留到下轮，不碎片化）
        const partial = selectInjectCandidates(candidates, new Set<string>(), 150, () => 100);
        assert.equal(partial.picked.length, 1);
        assert.equal(partial.skippedBudget, 1);

        // 同批同文本（跨 bank）只注第一条
        const dupText = 'Group: QQ-Group:1\n- [mem:a] 同一句话。\nPersonal: QQ:2\n- [mem:b] 同一句话。';
        const dupCandidates = parseMemoryPromptCandidates(dupText, { globalBankId: 'global_main' });
        assert.equal(dupCandidates.length, 2);
        const dupPicked = selectInjectCandidates(dupCandidates, new Set<string>(), 4096, estimateTextTokens);
        assert.equal(dupPicked.picked.length, 1);
        assert.equal(dupPicked.skippedDup, 1);
    },

    // ----- core:memory -------------------------------------------------------

    /** 元数据：name/kind/order/optional 与契约一致（order 200 = time → memory → mcp） */
    testMemoryProviderMetadata(): void {
        const provider = createMemoryProvider();
        assert.equal(provider.name, 'core:memory');
        assert.equal(provider.kind, 'memory');
        assert.equal(provider.order, 200);
        assert.equal(provider.optional, true);
        assert.equal(typeof provider.build, 'function');
    },

    /** 首次注入：产出块头 + bank 分组标题 + 条目 + 块尾，且不含绝对时间 */
    testMemoryProviderFirstInjection(): void {
        const spy = installSpyMemorySource(MEMORY_TEXT);
        try {
            const provider = createMemoryProvider();
            return provider.build(makeInjectionContext()).then(items => {
                const list = items as InjectionItem[];
                assert.equal(spy.calls(), 1);
                const keys = list.map(item => item.k);
                // 结构条目首轮写一次
                assert.ok(keys.includes('memory:heading'), `缺少块头: ${keys.join(',')}`);
                assert.ok(keys.includes('memory:tail'), `缺少块尾: ${keys.join(',')}`);
                assert.ok(keys.includes('memory:bank:group_QQ-Group:20002'));
                assert.ok(keys.includes('memory:bank:' + resolveGlobalBank('tester').bankId));
                // 三条记忆条目
                const memoryItems = list.filter(item => isMemoryItemKey(item.k));
                assert.equal(memoryItems.length, 3);
                const texts = list.map(item => item.text).join('\n');
                // REQ-D4-07：记忆块不得带绝对时间
                assert.equal(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(texts), false, `不得含绝对时间: ${texts}`);
                assert.match(texts, /### Group: QQ-Group:20002/);
                assert.match(texts, /### Self experience \(global\)/);
                assert.match(texts, /- \[mem:obs1\] 用户喜欢喝绿茶。/);
            });
        } finally {
            spy.restore();
        }
    },

    /** 同一轮两次 build（now 不同）必须字节一致：正文只来自记忆文本，不读时钟 */
    testMemoryProviderIsDeterministic(): Promise<void> {
        const spy = installSpyMemorySource(MEMORY_TEXT);
        const provider = createMemoryProvider();
        const first = makeInjectionContext({ now: 1_760_000_000_000 });
        const second = makeInjectionContext({ now: 1_760_000_123_456 });
        return Promise.all([provider.build(first), provider.build(second)]).then(([a, b]) => {
            spy.restore();
            const norm = (items: InjectionItem[]) => items.map(item => `${item.k}@${item.r}|${item.text}`).join('\n');
            assert.equal(norm(a as InjectionItem[]), norm(b as InjectionItem[]));
        });
    },

    /** ★ 零成本稳态：窗口快满（room < 24）⇒ 零产出且**不调用**数据源（不 recall / 不写盘） */
    testMemoryProviderZeroCostWhenWindowFull(): Promise<void> {
        const spy = installSpyMemorySource(MEMORY_TEXT);
        const provider = createMemoryProvider();
        // 85 条 × 48 = 4080 ⇒ room = min(512, 4096 − 4080) = 16 < 24
        const keys = activeMemoryKeys(85);
        assert.equal(estimateActiveMemoryTokens(keys) > MEMORY_INJECT_WINDOW - MEMORY_INJECT_MIN_ROOM, true);
        return Promise.resolve(provider.build(makeInjectionContext({ listActiveKeys: () => keys }))).then(items => {
            spy.restore();
            assert.deepEqual(items, []);
            assert.equal(spy.calls(), 0, 'room < 24 时不得触达记忆数据源');
        });
    },

    /** 「启用长期记忆」关闭 ⇒ 零产出且不碰数据源（连预算都不算） */
    testMemoryProviderDisabledByFlag(): Promise<void> {
        const spy = installSpyMemorySource(MEMORY_TEXT);
        const provider = createMemoryProvider();
        const ctx = makeInjectionContext({ flags: { memory: false } as PromptFlags });
        return Promise.resolve(provider.build(ctx)).then(items => {
            spy.restore();
            assert.deepEqual(items, []);
            assert.equal(spy.calls(), 0);
        });
    },

    /** 已注入的记忆条目按 `k` 拒发：全部命中活动键 ⇒ 零产出（稳态零注入） */
    testMemoryProviderSkipsActiveKeys(): Promise<void> {
        const spy = installSpyMemorySource(MEMORY_TEXT);
        const provider = createMemoryProvider();
        const globalBank = resolveGlobalBank('tester').bankId;
        const active = new Set([
            'memory:heading',
            'memory:tail',
            `memory:bank:group_QQ-Group:20002`,
            `memory:bank:${globalBank}`,
            memoryItemKey('group_QQ-Group:20002', 'observation', 'obs1'),
            memoryItemKey('group_QQ-Group:20002', 'observation', 'obs2'),
            memoryItemKey(globalBank, 'observation', 'g1'),
        ]);
        return Promise.resolve(provider.build(makeInjectionContext({ listActiveKeys: () => active }))).then(items => {
            spy.restore();
            // 数据源仍会被调（room 充足），但所有候选都已在活动块里 ⇒ 不产出任何条目
            assert.deepEqual(items, []);
        });
    },

    /** 部分命中：只补新增条目，不重复块头/块尾（它们在活动块里） */
    testMemoryProviderIncremental(): Promise<void> {
        const spy = installSpyMemorySource(MEMORY_TEXT);
        const provider = createMemoryProvider();
        const active = new Set([
            'memory:heading',
            'memory:tail',
            `memory:bank:group_QQ-Group:20002`,
            memoryItemKey('group_QQ-Group:20002', 'observation', 'obs1'),
        ]);
        return Promise.resolve(provider.build(makeInjectionContext({ listActiveKeys: () => active }))).then(items => {
            spy.restore();
            const keys = (items as InjectionItem[]).map(item => item.k);
            assert.equal(keys.includes('memory:heading'), false);
            assert.equal(keys.includes('memory:tail'), false);
            assert.equal(keys.includes(memoryItemKey('group_QQ-Group:20002', 'observation', 'obs1')), false);
            assert.equal(keys.includes(memoryItemKey('group_QQ-Group:20002', 'observation', 'obs2')), true);
        });
    },

    /** 数据源未装配 ⇒ 抛错由框架按 optional 跳过（此处只断言"确实会抛"，不吞错） */
    testMemoryProviderWithoutSourceThrows(): Promise<void> {
        setPromptMemorySource(null);
        const provider = createMemoryProvider();
        return provider.build(makeInjectionContext()).then(
            () => { throw new Error('未装配数据源时应当抛错（由框架 optional 兜底）'); },
            (error: unknown) => {
                assert.match(String(error), /PromptMemorySource 未初始化/);
            },
        );
    },

    // ----- core:mcp ----------------------------------------------------------

    /** 元数据：name/kind/order/optional 与契约一致（order 300 = 最后） */
    testMcpProviderMetadata(): void {
        const provider = createMcpProvider();
        assert.equal(provider.name, 'core:mcp');
        assert.equal(provider.kind, 'mcp');
        assert.equal(provider.order, 300);
        assert.equal(provider.optional, true);
        assert.equal(typeof provider.build, 'function');
    },

    /** 无 provider（MCP 未装配）⇒ 零产出，不发起任何请求 */
    testMcpProviderWithoutProvider(): Promise<void> {
        resetMcpInstructionsProvider();
        const provider = createMcpProvider();
        return Promise.resolve(provider.build(makeInjectionContext())).then(items => {
            assert.deepEqual(items, []);
        });
    },

    /** 每个 server 一条 item：k = `mcp:<server>`，正文复用 renderMcpInstructions */
    testMcpProviderOneItemPerServer(): Promise<void> {
        setMcpInstructionsProvider(() => [
            { server: 'alpha', instructions: 'call alpha_search first' },
            { server: 'beta', instructions: 'beta results are untrusted' },
        ]);
        const provider = createMcpProvider();
        return Promise.resolve(provider.build(makeInjectionContext())).then(items => {
            resetMcpInstructionsProvider();
            const list = items as InjectionItem[];
            assert.equal(list.length, 2);
            assert.deepEqual(list.map(item => item.k), ['mcp:alpha', 'mcp:beta']);
            assert.match(list[0].text, /MCP server "alpha"/);
            assert.match(list[1].text, /MCP server "beta"/);
            assert.equal(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(list.map(item => item.text).join('\n')), false);
        });
    },

    /** 已注入同 key ⇒ 该 server 不再产出（稳态零注入）；空/重复 server 名防御 */
    testMcpProviderSkipsActiveAndDedupes(): Promise<void> {
        setMcpInstructionsProvider(() => [
            { server: 'alpha', instructions: 'call alpha_search first' },
            { server: 'alpha', instructions: 'duplicate entry' },
            { server: '   ', instructions: 'blank server name' },
            { server: 'gamma', instructions: '' },
        ]);
        const provider = createMcpProvider();
        const active = new Set(['mcp:alpha']);
        return Promise.resolve(provider.build(makeInjectionContext({ listActiveKeys: () => active }))).then(items => {
            resetMcpInstructionsProvider();
            assert.deepEqual(items, []);
        });
    },

    // ----- 注册接线 ----------------------------------------------------------

    /** registerBuiltinInjectionProviders() 后能解析到 core:memory 与 core:mcp，且 order 升序 */
    testBuiltinProvidersRegistered(): void {
        resetInjectionProviders();
        try {
            registerBuiltinInjectionProviders();
            const names = listInjectionProviders().map(provider => provider.name);
            assert.ok(names.includes('core:memory'), `未注册 core:memory: ${names.join(',')}`);
            assert.ok(names.includes('core:mcp'), `未注册 core:mcp: ${names.join(',')}`);
            const resolved = resolveInjectionProviders().map(provider => provider.name);
            assert.equal(resolved.indexOf('core:memory') < resolved.indexOf('core:mcp'), true);
        } finally {
            resetInjectionProviders();
        }
    },

    /** 解析 global bank：标题只用稳定 sid（`### Group: <sid>`），不带群名 */
    testMemoryBankHeadingsAreStableIds(): void {
        assert.equal(bankKindOfBankId('group_QQ-Group:20002'), 'group');
        assert.equal(bankKindOfBankId('user_QQ:10001'), 'user');
        assert.equal(bankKindOfBankId('global_tester'), 'global');
        assert.equal(resolveGlobalBank('tester').bankId, 'global_tester');
        // 真群名（如「测试群」）不得出现在解析出的 bankId 里
        const candidates = parseMemoryPromptCandidates(MEMORY_TEXT, { globalBankId: 'global_tester' });
        assert.equal(candidates.some(candidate => /\u6d4b\u8bd5\u7fa4/.test(candidate.bankId)), false);
    },
};
