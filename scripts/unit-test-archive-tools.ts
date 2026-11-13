// #163 D8 工具面恒定 + D7/T16 归档预算口径单测（T12 / T16 组）。
//
// 为什么单独一个 bundle：这些断言的对照面是「模块级工具 schema 缓存 + ArchiveController 的水位算法」，
// 与按域拆分的 unit-test-*.ts 主入口无关；独立入口让失败定位更快。
//
// 覆盖点（对应 .dev/docs-archive/163/exec/d789-archive-tools.md §E）：
// - E1~E6  D8 工具面恒定：三件套恒定、永不 null、同一数组引用、JSON 字节恒定、token 预留不随开关变；
// - E9~E13 T16 归档：水位常量、`estimateT()` 三项、`selectCut` 扣注入、`selectMarkForTarget` 扣注入、
//          `selectMarkTo` 跳过注入、`inject-exceeds-retain-target` 下限保护；
// - E17     D7-10/11 `L` 单一实现（`resolveArchiveL` 与旧内联公式逐值相等）；
// - E8      D8-07 负向断言：运行期改工具开关**不**产生 rebase。
import assert from 'node:assert/strict';

import { ArchiveController } from '../src/context/archive_controller';
import type { EventInput } from '../src/context/events';
import { INJECTION_WRAP_TOKENS, resetInjectionTokenCache } from '../src/context/injections';
import { setMissingKeyErrorDetector } from '../src/context/log/page_store';
import { ContextService } from '../src/context/service';
import { setHost } from '../src/core/host';
import { makeItem } from '../src/prompt/injections/keys';
import { Session } from '../src/session/session';
import { registerDispatchTools } from '../src/tool/tools/core/tool_dispatch';
import Tool, {
    NATIVE_TOOL_NAMES,
    nativeRequestToolsJson,
    resetNativeToolsJsonCache,
    toolMap,
} from '../src/tool/tool';
import { resolveArchiveL } from '../src/utils/context_budget';
import { resolveArchiveWatermarks } from '../src/utils/context_limits';
import { estimateToolsTokens } from '../src/utils/message';
import { estimateTextTokens } from '../src/utils/token_estimate';

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
    sidCounter += 1;
}

/** 造会话桩：`toolState` 是真的 getter（读 `tool.state`），但不能触发 Config 依赖，故直接给最小对象 */
function sessionStub(over: { state?: Record<string, boolean>; sessionType?: 'group' | 'user' } = {}): Session {
    const state = over.state ?? {};
    return {
        sessionId: 'QQ-Group:archive-tools',
        sessionType: over.sessionType ?? 'group',
        tool: { state },
        get toolState() { return state; },
        toolRestriction: null,
    } as unknown as Session;
}

/** 交替 user/assistant（保证每条消息独立成单元，token 可逐条预测） */
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

/** 连续 user（会被 `segmentUnits` 合并成一个单元，用于制造"单块超出目标"的场景） */
function consecutiveUsers(count: number, offset = 0): EventInput[] {
    const out: EventInput[] = [];
    for (let i = 0; i < count; i++) {
        const n = offset + i + 1;
        out.push({ kind: 'user', uid: 'QQ:1', msgId: `c${n}`, parts: [{ type: 'text', text: `合并${n}` }] } as EventInput);
    }
    return out;
}

const ESTIMATE = 10;

interface Harness {
    service: ContextService;
    controller: ArchiveController;
    observed: string[];
}

function makeHarness(opts: { rebase?: (reason: string, seq: number) => void } = {}): Harness {
    resetEnv();
    const service = ContextService.openSync(`QQ-Group:archive-tools-${sidCounter}`, {
        estimateEventTokens: () => ESTIMATE,
    });
    const observed: string[] = [];
    const controller = new ArchiveController({
        service,
        estimateEventTokens: () => ESTIMATE,
        estimateTextTokens: estimateTextTokens,
        observe: (event) => { observed.push(event); },
        ...(opts.rebase ? { onRebase: opts.rebase } : {}),
    });
    return { service, controller, observed };
}

function append(service: ContextService, inputs: EventInput[]): void {
    service.getStore().append(inputs);
}

/** 三个元工具必须已注册（`getNativeRequestTools` 的输入前提） */
function ensureMetaTools(): void {
    if (!toolMap.list_tools) registerDispatchTools();
}

export const tests: Record<string, () => void | Promise<void>> = {
    // -----------------------------------------------------------------------
    // T12 / D8 工具面恒定
    // -----------------------------------------------------------------------

    /**
     * E1：5 组"会话状态差异极大"的输入下，元工具 schema 的 JSON **逐字节相同**且恒为 3 项。
     *
     * 这是 R1 成立的前提：`tools` 位于请求体最前端，任何波动都会作废整个请求体的缓存。
     */
    testNativeToolsInvariantAcrossSessionStates() {
        ensureMetaTools();
        const snapshots: string[] = [];
        const states: Array<{ state: Record<string, boolean>; sessionType: 'group' | 'user' }> = [
            { state: {}, sessionType: 'group' },
            // 全部工具关闭
            { state: Object.fromEntries(Object.keys(toolMap).map(n => [n, false])), sessionType: 'group' },
            // 只开 1 个
            { state: { list_tools: true }, sessionType: 'user' },
            // 平台相关工具被关
            { state: { call_ob11_api: false, run_ext_command: false }, sessionType: 'user' },
            // 子代理限制面（toolRestriction 已生效后的状态）
            { state: { search_tools: false }, sessionType: 'group' },
        ];
        for (const s of states) {
            const tools = Tool.getNativeRequestTools(sessionStub(s));
            assert.equal(tools.length, 3, `元工具恒为 3 项（sessionType=${s.sessionType}）`);
            snapshots.push(JSON.stringify(tools));
        }
        for (let i = 1; i < snapshots.length; i++) {
            assert.equal(snapshots[i], snapshots[0], `第 ${i} 组输入的 schema 字节必须与第 0 组一致`);
        }
    },

    /** E2：三个元工具全关掉时仍返回 3 项，**不是 null/空数组**（空数组会让 body.tools 键整个消失） */
    testNativeToolsNeverNullWhenAllDisabled() {
        ensureMetaTools();
        const state: Record<string, boolean> = {};
        for (const name of Object.keys(toolMap)) state[name] = false;
        const tools = Tool.getNativeRequestTools(sessionStub({ state }));
        assert.notEqual(tools, null);
        assert.equal(Array.isArray(tools), true);
        assert.equal(tools.length, 3);
    },

    /** E3：导出面契约 —— 三件套名单恰为 `list_tools/search_tools/call_tool`，其它"核心"工具不在内 */
    testNativeToolNamesExact() {
        assert.deepEqual(
            NATIVE_TOOL_NAMES.slice(),
            ['list_tools', 'search_tools', 'call_tool'],
            '原生 function calling 只暴露三个元工具',
        );
        for (const forbidden of ['list_mcps', 'use_skill', 'call_ob11_api', 'run_ext_command', 'run_core_command']) {
            assert.equal(NATIVE_TOOL_NAMES.includes(forbidden), false, `${forbidden} 不得进请求体（会让工具面随开关漂移）`);
        }
        ensureMetaTools();
        assert.deepEqual(
            Tool.getNativeRequestTools().map(t => t.function.name),
            NATIVE_TOOL_NAMES.slice(),
            '实际返回顺序必须与常量一致（顺序变了也是字节变化）',
        );
    },

    /** E4：`nativeRequestToolsJson()` 两次调用相等；工具开关变化前后仍相等 */
    testNativeToolsJsonStable() {
        ensureMetaTools();
        resetNativeToolsJsonCache();
        const first = nativeRequestToolsJson();
        assert.equal(nativeRequestToolsJson(), first, '同一快照两次序列化必须相等');
        assert.equal(first, JSON.stringify(Tool.getNativeRequestTools()), '与直接序列化同源');

        // 模拟运行期开关变化：JSON 不得变化
        const s = sessionStub({ state: { list_tools: false, search_tools: true, call_tool: false } });
        Tool.getNativeRequestTools(s);
        assert.equal(nativeRequestToolsJson(), first, '工具开关变化不得改变 schema 字节');
        resetNativeToolsJsonCache();
        assert.equal(nativeRequestToolsJson(), first, '缓存失效后重算仍必须一致');
    },

    /**
     * E5：`estimateToolsTokens` 与 JSON 估算同源，且**同一数组引用命中 memo**。
     *
     * memo 的意义不只是省 CPU：它保证"同一轮内两次预算计算拿到完全相同的数字"，
     * 否则 `L` 会在注入闸与编译层之间抖动。
     */
    testEstimateToolsTokensMemoizesByReference() {
        ensureMetaTools();
        const tools = Tool.getNativeRequestTools();
        const expected = estimateTextTokens(JSON.stringify(tools));
        assert.equal(estimateToolsTokens(tools), expected);
        assert.equal(estimateToolsTokens(tools), expected, '同一引用两次调用返回值相等（memo 命中）');
        // 换开关后的**新**数组：值仍围绕元工具三件套（不会因开关变而变）
        const other = [tools[0], tools[1], tools[2]];
        assert.equal(estimateToolsTokens(other), expected, '内容相同的不同引用估算值相同');
        assert.equal(estimateToolsTokens(undefined), 0, '无 tools ⇒ 预留 0');
        assert.equal(estimateToolsTokens([]), 0, '空数组 ⇒ 预留 0');
    },

    /** E6：`getNativeRequestTools()` 返回**同一数组引用** —— 这是字节恒定的机制保证 */
    testNativeToolsReturnsSameArrayReference() {
        ensureMetaTools();
        const a = Tool.getNativeRequestTools();
        const b = Tool.getNativeRequestTools(sessionStub({ state: { list_tools: false } }));
        assert.equal(a, b, '必须是同一数组引用（每次新建数组会给"字节相同"留下隐患）');
        resetNativeToolsJsonCache();
        Tool.reset();
        assert.notEqual(Tool.getNativeRequestTools(), a, 'Tool.reset() 后必须重建（注册表已清空）');
    },

    /**
     * E8 / D8-07（负向断言）：运行期改 `session.toolState` **不增加** rebase 计数。
     *
     * 语义：`tools` 只在**升级**（原生 schema 指纹变了）时 rebase 一次；`.ai tool on/off`
     * 只改执行期可用性，不改请求体。这条断言锁死"不要为工具开关加 rebase 打点"。
     */
    testToolToggleDoesNotRebasePrefix() {
        ensureMetaTools();
        const session = new Session();
        session.sessionId = 'QQ:toggle-no-rebase';
        const before = session.prefixRebase?.count ?? 0;
        for (const name of NATIVE_TOOL_NAMES) {
            session.tool.state[name] = false;
            Tool.getNativeRequestTools(session);
            nativeRequestToolsJson();
        }
        session.tool.state.list_tools = true;
        Tool.getNativeRequestTools(session);
        assert.equal(session.prefixRebase?.count ?? 0, before, '工具开关变化不得产生前缀 rebase');
    },

    // -----------------------------------------------------------------------
    // T16 / D7 归档口径
    // -----------------------------------------------------------------------

    /** E9：水位常量契约（L/A/B/C 四个数必须与文档一致，改一个就会整体偏移） */
    testArchiveWatermarksShape() {
        const wm = resolveArchiveWatermarks(1000, 30);
        assert.deepEqual(wm, { L: 1000, A: 300, B: 950, C: 1650 });
        assert.equal(resolveArchiveWatermarks(1000, 100).A, 1000, '保留 100% ⇒ A = L');
        assert.equal(resolveArchiveWatermarks(0, 30).L, 0, '预算 0 ⇒ L=0（调用方据此走"预算未知"分支）');
    },

    /**
     * E10：`estimateT()` = 未归档原文 + 摘要注入 + **活动注入**三项之和。
     *
     * 第三项是 AUDIT-005（P1）的修复点：注入 token 不落 head，只能从事件现算；
     * 漏掉它就会"注入把预算挤爆之后才归档"。
     */
    async testEstimateTIncludesActiveInjections() {
        const h = makeHarness();
        append(h.service, alternating(10)); // 10 × 10 = 100 未归档原文
        assert.equal(h.controller.estimateT(), 100, '无摘要/无注入 ⇒ 只有原文');
        const body = 'x'.repeat(40);
        h.service.appendInjection({ kind: 'memory', afterSeq: 1, items: [makeItem('m1', body)] });
        const withInject = h.controller.estimateT();
        assert.ok(withInject > 100, `活动注入必须计入 T（实际 ${withInject}）`);
        // tokens = estimateTextTokens(正文) + INJECTION_WRAP_TOKENS（落盘时冻结，见 service.appendInjection）
        const expectedInject = estimateTextTokens(body) + INJECTION_WRAP_TOKENS;
        assert.equal(withInject - 100, expectedInject, `注入 token 必须与落盘口径一致（实际差 ${withInject - 100}）`);

        // 归档越过注入块的 afterSeq ⇒ 块释放 ⇒ T 回落
        h.service.commitArchive(9);
        const after = h.controller.estimateT();
        assert.equal(after, h.service.head().unarchivedTokens, '块释放后 T = 原文（+摘要），不再含注入');
        await h.service.flush();
    },

    /**
     * E11：`selectCut` 的目标里**先扣掉**摘要注入与活动注入（REQ-D3-31 公式 3）。
     *
     * 构造方式：注入 200 token，L=1000。若不计注入，切到"剩余原文 ≤ 1000"就停（几乎不用切）；
     * 计注入则必须切到"剩余原文 ≤ 1000 − 200 = 800"。
     */
    async testSelectCutSubtractsInjectionsFromTarget() {
        const h = makeHarness();
        // 200 条交替 = 2000 token 原文，切成 100 个单元（每单元 2 条 = 20 token）
        append(h.service, alternating(200));
        // 活动注入 ≈ 200 token（正文 200 个 CJK 字 = 200 token，+ 包装）
        h.service.appendInjection({ kind: 'memory', afterSeq: 1, items: [makeItem('m-big', '中'.repeat(200))] });
        const injectTokens = h.controller.estimateT() - h.service.head().unarchivedTokens;
        assert.ok(injectTokens >= 200, `注入 token 应可观（实际 ${injectTokens}）`);

        h.controller.beforeRequest({ L: 1000, retainPercent: 30 });
        const remaining = h.service.head().unarchivedTokens;
        // 计入注入 ⇒ 剩余原文必须 ≲ 1000 − injectTokens（而不是 1000）
        const target = 1000 - injectTokens;
        assert.ok(
            remaining <= target,
            `剩余原文应 ≤ L − 注入（target=${target}，实际 ${remaining}）`,
        );
        await h.service.flush();
    },

    /**
     * E12：`selectMarkForTarget` 把活动注入计入"归档后还剩多少"（REQ-D3-31 公式 4）。
     *
     * 直接调私有方法而不是走 `afterRequestSent`：后者还要先过 `T >= B` 的触发闸，
     * 会把"是否计入注入"这个被测点混进触发条件里。这里只测**停止点**：
     * - 不计入注入 ⇒ 剩余原文 340 ≤ A=350 ⇒ 返回 null（永远不总结）；
     * - 计入注入 ⇒ 400 > 350 ⇒ 必须往后吃到 3 个单元（400−60=340 ≤ 350）才停。
     */
    async testSelectMarkForTargetCountsInjections() {
        const markFor = (controller: ArchiveController, A: number) => (controller as unknown as {
            selectMarkForTarget: (a: number) => { fromSeq: number; toSeq: number; tokens: number; unitCount: number } | null;
        }).selectMarkForTarget.bind(controller);

        // 对照：无注入 ⇒ null
        const plain = makeHarness();
        append(plain.service, alternating(34)); // 34 条 × 10 = 340 token，17 个单元（每单元 20）
        assert.equal(plain.service.head().unarchivedTokens, 340);
        assert.equal(markFor(plain.controller, 350)(350), null, '无注入且原文 ≤ A ⇒ 不该总结');
        await plain.service.flush();

        // 计入注入 ⇒ 必须总结到剩余 ≤ A
        const h = makeHarness();
        append(h.service, alternating(34));
        const body = 'y'.repeat(90);
        h.service.appendInjection({ kind: 'memory', afterSeq: 1, items: [makeItem('m1', body)] });
        const injectTokens = h.controller.estimateT() - h.service.head().unarchivedTokens;
        assert.equal(injectTokens, estimateTextTokens(body) + INJECTION_WRAP_TOKENS);
        assert.ok(h.service.head().unarchivedTokens <= 350, '原文本身必须 ≤ A（否则本用例证不了"计入注入"）');

        const mark = markFor(h.controller, 350)(350);
        assert.ok(mark, '计入注入后 340+注入 > A ⇒ 必须总结');
        // 只断言算法性质（不钉具体 seq，免得估算口径微调就红）：
        // 1) 覆盖后「剩余原文 + 注入」必须 ≤ A；
        // 2) 少覆盖一个单元时仍 > A（说明是"刚好够"，不是切多了）。
        const perUnit = 10; // 交替 user/assistant ⇒ 每条事件独立成单元，各 10 token
        assert.equal(mark!.tokens, mark!.unitCount * perUnit, '总结区间 token 只算普通事件，不含注入');
        const remainAfter = 340 + injectTokens - mark!.tokens;
        assert.ok(remainAfter <= 350, `覆盖后剩余应 ≤ A（实际 ${remainAfter}）`);
        const remainBefore = remainAfter + perUnit;
        assert.ok(remainBefore > 350, `少覆盖一个单元时应仍 > A（实际 ${remainBefore}）`);
        await h.service.flush();
    },

    /**
     * E13：`selectMarkTo`（硬切后只总结 Cb）跳过了注入块（REQ-D3-31 公式 5）。
     *
     * 若把注入算进总结区间 token，会高估 Cb 的大小 ⇒ 分批数偏多、总结正文里混进注入内容。
     */
    async testSelectMarkToSkipsInjections() {
        const h = makeHarness();
        // 连续 user 成一个 300 token 大单元 + 后续交替
        append(h.service, consecutiveUsers(30));
        append(h.service, alternating(40, 30));
        h.service.appendInjection({ kind: 'memory', afterSeq: 1, items: [makeItem('m1', 'w'.repeat(200))] });

        const selectMarkTo = (h.controller as unknown as {
            selectMarkTo: (toSeq: number) => { tokens: number } | null;
        }).selectMarkTo.bind(h.controller);
        const withInjection = selectMarkTo(30);
        assert.ok(withInjection, '应能选出 Cb 范围');
        // 区间 [1..30] 内可见事件 = 30 条 user × 10 = 300（注入块在区间内但那 200 不计）
        assert.equal(withInjection!.tokens, 300, '注入块正文不得计入总结区间 token');
        await h.service.flush();
    },

    /**
     * E13b：注入本身就 ≥ 保留目标 A 时**放弃总结**并记 `inject-exceeds-retain-target`。
     *
     * 否则每轮都判"需要总结"、总结完注入仍在 ⇒ 总结风暴（d3b G.4 下限保护）。
     * 注意：走 `afterRequestSent` 会被硬切稀释（切到注入块之后 ⇒ 块释放 ⇒ 注入归零），
     * 所以这里直接打 `selectMarkForTarget`，只测下限保护本身。
     */
    async testSelectMarkForTargetBailsWhenInjectionsExceedRetainTarget() {
        const h = makeHarness();
        append(h.service, alternating(20)); // 200 token
        // 锚在尾部（切不到它 ⇒ 不会释放），注入 ≈ 112 token
        h.service.appendInjection({ kind: 'memory', afterSeq: 20, items: [makeItem('m-huge', 'q'.repeat(400))] });
        const injectTokens = h.controller.estimateT() - h.service.head().unarchivedTokens;
        assert.ok(injectTokens > 100, `注入 token 应可观（实际 ${injectTokens}）`);

        const markFor = (h.controller as unknown as {
            selectMarkForTarget: (a: number) => unknown;
        }).selectMarkForTarget.bind(h.controller);
        // A 取比注入小的值（A = floor(L×30%)）
        const A = injectTokens - 1;
        const L = Math.floor(A / 0.3) + 1;
        assert.ok(h.controller.estimateT() > A, 'T 必须 > A（否则连候选都不用看就返回 null）');
        assert.equal(markFor(A), null, '注入 ≥ A ⇒ 必须放弃总结（否则每轮都总结、注入还在 ⇒ 风暴）');
        assert.ok(
            h.observed.includes('inject-exceeds-retain-target'),
            `注入 ≥ A 时必须打点（observed=${JSON.stringify(h.observed)}）`,
        );
        assert.equal(h.service.head().summarizedThrough, 0, '放弃总结 ⇒ 不产生摘要');
        // 对照：A 略大于注入时应当能选出范围（证明上面返回 null 是因为下限保护，不是因为没候选）
        assert.ok(markFor(injectTokens + 40), `A 大于注入时应能选出范围（L=${L}）`);
        await h.service.flush();
    },

    // -----------------------------------------------------------------------
    // E17 / D7-10/11 `L` 单一实现
    // -----------------------------------------------------------------------

    /**
     * E17：`resolveArchiveL` 与旧内联公式 `max(1, permanent − prefix − tools)` **逐值相等**。
     *
     * 注入侧与编译侧必须调同一个函数：口径漂移会出现"注入以为装得下、编译以为装不下"。
     */
    testResolveArchiveLMatchesLegacyFormula() {
        const cases: Array<[number, number, number]> = [
            [10000, 1000, 500],
            [1000, 0, 0],
            [1000, 1000, 0],
            [1000, 2000, 0],
            [1, 0, 0],
            [0, 0, 0],
            [-100, 10, 10],
            [12345.9, 234.6, 345.2],
            [1000000, 999999, 2],
        ];
        for (const [permanent, prefix, tools] of cases) {
            const expected = Math.max(
                1,
                Math.max(0, Math.floor(permanent)) - Math.max(0, Math.floor(prefix)) - Math.max(0, Math.floor(tools)),
            );
            const actual = resolveArchiveL({ permanentBudget: permanent, prefixTokens: prefix, toolsReserveTokens: tools, runtimeTokens: 0 });
            assert.equal(actual, expected, `L 口径必须与旧内联公式一致（permanent=${permanent}, prefix=${prefix}, tools=${tools}）`);
        }
        // runtimeTokens 字段保留但 PR-08 后恒为 0：传入非 0 时仍然参与扣减（保持单一口径的可测性）
        assert.equal(
            resolveArchiveL({ permanentBudget: 1000, prefixTokens: 100, toolsReserveTokens: 100, runtimeTokens: 50 }),
            750,
            'runtimeTokens 参与扣减',
        );
    },

    /** E17b：`L` 是纯函数 —— 同输入连续调用结果恒定（无时钟/无缓存失效问题） */
    testResolveArchiveLIsPure() {
        const input = { permanentBudget: 20000, prefixTokens: 3000, toolsReserveTokens: 1500, runtimeTokens: 0 };
        const first = resolveArchiveL(input);
        for (let i = 0; i < 5; i++) assert.equal(resolveArchiveL(input), first, '纯函数：同输入同输出');
        assert.equal(first, 15500);
    },
};
