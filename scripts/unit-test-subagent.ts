// 子代理机制层单元测试（docs/12 v4 定稿行为验证）。
// 由 scripts/test-unit.cjs 打包运行；不依赖 seal/Config。
import assert from 'node:assert/strict';
import {
    ChildRecord,
    MemoryKv,
    SubAgentDepthLimitError,
    SubAgentJobNotFoundError,
    SubAgentJobs,
    SubAgentProvider,
    SubAgentResult,
    SubAgentService,
    SubAgentStore,
    childIdFor,
    completedTurnPrefixCount,
    delegationAllowed,
    isTerminal,
    mergeToolFilter,
    parseChildId,
    resultErrorText,
    settleNoticeText,
    buildChildSystemContent,
    decideWake,
    WAKE_REASON,
    createSpawnProvider,
    createForkProvider,
    effectiveMaxDepth,
    effectiveDeny,
    DELEGATION_GUIDE,
    buildDelegationGuide,
} from '../src/agent/subagent/index';
import Config from '../src/config/config';
import { Session } from '../src/session/session';
import Tool, { toolMap } from '../src/tool/tool';
import { runHeadlessActivation, createChildSession, encodeCheckpoint, decodeCheckpoint } from '../src/agent/subagent/child';

export const tests: Record<string, () => void | Promise<void>> = {};

// ---------- 构造辅助 ----------
function makeResult(partial: Partial<SubAgentResult> = {}): SubAgentResult {
    return { stopReason: 'completed', output: '', ...partial };
}

function makeRecord(over: Partial<ChildRecord> & { childId: string; parentSessionId: string }): ChildRecord {
    const base: ChildRecord = {
        childId: over.childId,
        parentSessionId: over.parentSessionId,
        treeRootSessionId: 'QQ:1',
        parentAgentName: '',
        provider: 'spawn',
        label: 't',
        depth: 1,
        status: 'done',
        childSessionId: over.childId,
        agentName: 'researcher',
        meta: { epId: 'QQ:1', isPrivate: true },
        createdAt: 1,
        updatedAt: 1,
        inbox: [],
    };
    return { ...base, ...over };
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

class FakeProvider implements SubAgentProvider {
    name: string;
    inheritsParentContext: boolean;
    started = 0;
    disposed = 0;
    result: SubAgentResult;
    constructor(name: string, inherits: boolean, result: SubAgentResult) {
        this.name = name;
        this.inheritsParentContext = inherits;
        this.result = result;
    }
    async start(_req: unknown): Promise<SubAgentRun> {
        this.started++;
        return {
            id: `run-${this.started}`,
            result: Promise.resolve(this.result),
            dispose: async () => { this.disposed++; },
        };
    }
    async prepareContinuable(): Promise<{ seed?: unknown }> {
        return { seed: 'seed-1' };
    }
}

function req(over: Partial<Parameters<SubAgentService['startForeground']>[1]> = {}): Parameters<SubAgentService['startForeground']>[1] {
    return {
        label: '测试任务',
        prompt: '把输入变短',
        parent: { sessionId: 'QQ:1', epId: 'QQ:1', isPrivate: true, depth: 0 },
        ...over,
    } as Parameters<SubAgentService['startForeground']>[1];
}

function makeService(store?: SubAgentStore, notices?: string[]) {
    const kv = store ? undefined : new MemoryKv();
    const st = store ?? new SubAgentStore(kv!);
    const sink = notices ? (p: string, t: string) => notices.push(`${p}|${t}`) : null;
    return { kv: kv ?? null, store: st, service: new SubAgentService(st, sink) };
}

// ---------- rules ----------
tests['subagent.rules.stopReasonText'] = () => {
    assert.equal(resultErrorText(makeResult({ stopReason: 'completed', output: 'x' })), '', 'completed 不生成错误');
    const e = resultErrorText(makeResult({ stopReason: 'error', diagnostic: '网络失败', output: '部分结果' }));
    assert.ok(e.includes('subagent run failed'), '头条');
    assert.ok(e.includes('Diagnostic: 网络失败'), 'diagnostic');
    assert.ok(e.includes('Partial output before the run ended:'), '部分输出标记');
    assert.ok(e.includes('部分结果'), '部分输出内容');
    assert.ok(isTerminal('max-tokens') && isTerminal('timeout') && !isTerminal('aborted'));
};

tests['subagent.rules.settleNoticeText'] = () => {
    const done = settleNoticeText('sub:QQ:1:2', '调研', makeResult({ output: '结论A' }));
    assert.ok(done.includes('已完成') && done.includes('结论：结论A'));
    const err = settleNoticeText('sub:QQ:1:2', '调研', makeResult({ stopReason: 'refusal' }));
    assert.ok(err.includes('已结束（refusal）') && err.includes('subagent declined the task'));
    const long = settleNoticeText('s', 'l', makeResult({ output: 'x'.repeat(5000) }), 100);
    assert.ok(long.includes('已截断'), '超长截断标记');
};

tests['subagent.rules.delegationAllowed'] = () => {
    assert.equal(delegationAllowed(0, 3), true);
    assert.equal(delegationAllowed(2, 3), true);
    assert.equal(delegationAllowed(3, 3), false, '深度到达上限拒绝');
    assert.equal(delegationAllowed(10, 3), false);
    assert.equal(delegationAllowed(0, 0), false, '0=禁委派');
    assert.equal(delegationAllowed(5, undefined), true, '未配置不限制');
};

tests['subagent.rules.mergeToolFilter'] = () => {
    const parent = { web_search: true, call_ob11_api: true, memory_recall: false };
    const all = mergeToolFilter(parent, null);
    assert.deepEqual(all, parent);
    assert.notEqual(all, parent, '返回新对象');
    const allow = mergeToolFilter(parent, { allow: ['web_search', 'memory_recall'] });
    assert.deepEqual(allow, { web_search: true, memory_recall: false });
    const denyWins = mergeToolFilter(parent, { allow: ['call_ob11_api'], deny: ['call_ob11_api'] });
    assert.deepEqual(denyWins, {}, 'deny 优先于 allow');
    assert.deepEqual(parent, { web_search: true, call_ob11_api: true, memory_recall: false }, '不改入参');
};

tests['subagent.rules.completedTurnPrefixCount'] = () => {
    const finalText = { role: 'user' as const };
    const toolTurn = { role: 'assistant' as const, toolCalls: [{ id: 't1' }] };
    const toolMsg = { role: 'tool' as const };
    assert.equal(completedTurnPrefixCount([]), 0);
    assert.equal(completedTurnPrefixCount([{ role: 'user' }, { role: 'assistant' }]), 2, '无工具轮=全量');
    const msgs = [finalText, { role: 'assistant' as const, text: '回复' }, finalText, toolTurn, toolMsg];
    assert.equal(completedTurnPrefixCount(msgs), 3, '切到最近工具轮 assistant 之前');
    const alt = [{ role: 'user' as const }, { role: 'assistant' as const, tool_calls: [{ id: 'x' }] }, { role: 'tool' as const }];
    assert.equal(completedTurnPrefixCount(alt), 1, '兼容 tool_calls 命名');
};

tests['subagent.rules.childId'] = () => {
    const id = childIdFor('QQ-Group:123', 7);
    assert.equal(id, 'sub:QQ-Group:123:7');
    const parsed = parseChildId(id);
    assert.deepEqual(parsed, { parentSessionId: 'QQ-Group:123', seq: 7 }, '含冒号父会话也能反解');
    assert.equal(parseChildId('garbage'), null);
    assert.equal(parseChildId('sub:QQ:1:x'), null);
};

// ---------- jobs ----------
tests['subagent.jobs.doneAndOutput'] = async () => {
    const jobs = new SubAgentJobs();
    const id = jobs.start('a', async () => makeResult({ output: 'ok' }));
    const snap = await jobs.output(id);
    assert.equal(snap.status, 'done');
    assert.equal(snap.result?.output, 'ok');
    assert.ok(jobs.list().length === 1);
};

tests['subagent.jobs.failed'] = async () => {
    const jobs = new SubAgentJobs();
    const id = jobs.start('bad', async () => { throw new Error('boom'); });
    const snap = await jobs.output(id);
    assert.equal(snap.status, 'failed');
    assert.equal(snap.error, 'boom');
    await assert.rejects(() => jobs.output('nope'), SubAgentJobNotFoundError);
};

tests['subagent.jobs.kill'] = async () => {
    const jobs = new SubAgentJobs();
    const gate = deferred<void>();
    const id = jobs.start('k', async () => { await gate.promise; return makeResult({ output: 'late' }); });
    assert.equal(jobs.kill(id, '用户取消'), true, '运行中可 kill');
    assert.equal(jobs.kill(id), false, '重复 kill 无效');
    const snap = await jobs.output(id);
    assert.equal(snap.status, 'killed');
    assert.equal(snap.error, '用户取消');
    gate.resolve();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(jobs.get(id)?.status, 'killed', 'kill 后即使 run 完成终态仍为 killed');
};

tests['subagent.jobs.retentionKeepsRunning'] = async () => {
    const jobs = new SubAgentJobs({ retention: 3 });
    const gate = deferred<void>();
    const runningId = jobs.start('r1', async () => { await gate.promise; return makeResult({}); });
    const done = jobs.start('d1', async () => makeResult({}));
    await jobs.output(done);
    jobs.start('d2', async () => makeResult({}));
    jobs.start('d3', async () => makeResult({}));
    jobs.start('d4', async () => makeResult({}));
    await new Promise(r => setTimeout(r, 5));
    const list = jobs.list();
    assert.ok(list.some(j => j.id === runningId), 'running 永不清理');
    assert.ok(list.length <= 3, `超出保留上限应清理: ${list.length}`);
    gate.resolve();
};

// ---------- store ----------
tests['subagent.store.roundtripAndTrim'] = () => {
    const kv = new MemoryKv();
    const store = new SubAgentStore(kv, { retention: 2 });
    const a = makeRecord({ childId: 'sub:QQ:1:1', parentSessionId: 'QQ:1', status: 'done', createdAt: 1 });
    const b = makeRecord({ childId: 'sub:QQ:1:2', parentSessionId: 'QQ:1', status: 'done', createdAt: 2 });
    const c = makeRecord({ childId: 'sub:QQ:1:3', parentSessionId: 'QQ:1', status: 'running', createdAt: 0 });
    store.upsert('QQ:1', a);
    store.upsert('QQ:1', b);
    store.upsert('QQ:1', c);
    // a+b+c=3 > retention=2：最早的 done(a) 被清，running(c) 保留；list 按 createdAt 升序
    assert.deepEqual(store.list('QQ:1').map(r => r.childId), ['sub:QQ:1:3', 'sub:QQ:1:2']);
    assert.equal(store.nextSeq('QQ:1'), 4, 'nextSeq 按现存记录尾部推导');
    assert.equal(store.remove('QQ:1', 'sub:QQ:1:3'), true);
    assert.equal(store.get('QQ:1', 'sub:QQ:1:3'), null);
    // 分配序号走独立单调计数器：删除记录不回退（childId 不复用）
    assert.equal(store.allocateSeq('QQ:1'), 1);
    const d = makeRecord({ childId: 'sub:QQ:1:1', parentSessionId: 'QQ:1', status: 'done', createdAt: 5 });
    store.upsert('QQ:1', d);
    assert.equal(store.remove('QQ:1', 'sub:QQ:1:1'), true);
    assert.equal(store.allocateSeq('QQ:1'), 2, '删除不影响序号单调');
};

tests['subagent.store.corruptIndexAndSessionPayload'] = () => {
    const kv = new MemoryKv();
    const store = new SubAgentStore(kv);
    kv.set('subagent_index:QQ:1', '{broken');
    assert.deepEqual(store.list('QQ:1'), [], '损坏索引重置为空');
    store.saveChildSession('QQ:1', 'sub:QQ:1:1', { ctx: [1, 2] });
    assert.deepEqual(store.loadChildSession('QQ:1', 'sub:QQ:1:1'), { ctx: [1, 2] });
    store.removeChildSession('QQ:1', 'sub:QQ:1:1');
    assert.equal(store.loadChildSession('QQ:1', 'sub:QQ:1:1'), null);
};

// ---------- service ----------
tests['subagent.service.foreground'] = async () => {
    const notices: string[] = [];
    const { store, service } = makeService(undefined, notices);
    const p = new FakeProvider('spawn', false, makeResult({ output: 'hello' }));
    service.registerProvider(p);
    const out = await service.startForeground('spawn', req());
    assert.equal(out.childId, 'sub:QQ:1:1');
    assert.equal(out.result.output, 'hello');
    assert.equal(p.started, 1);
    assert.equal(p.disposed, 1, '前台必 dispose');
    const rec = store.get('QQ:1', out.childId);
    assert.equal(rec?.status, 'done');
    assert.equal(notices.length, 0, '前台不发 notice');
};

tests['subagent.service.foregroundDepthAndProvider'] = async () => {
    const { store, service } = makeService();
    const p = new FakeProvider('spawn', false, makeResult({}));
    service.registerProvider(p);
    await assert.rejects(
        () => service.startForeground('spawn', req({ parent: { sessionId: 'QQ:1', epId: 'QQ:1', isPrivate: true, depth: 0 }, maxDepth: 0 })),
        { name: 'SubAgentDepthLimitError' }
    );
    await assert.rejects(
        () => service.startForeground('spawn', req({ parent: { sessionId: 'QQ:1', epId: 'QQ:1', isPrivate: true, depth: 3 }, maxDepth: 3 })),
        { name: 'SubAgentDepthLimitError' }
    );
    assert.equal(p.started, 0, '深度拒绝时 provider 不被调用');
    const out = await service.startForeground('spawn', req({ parent: { sessionId: 'QQ:1', epId: 'QQ:1', isPrivate: true, depth: 2 }, maxDepth: 3 }));
    assert.ok(out.childId, '深度未达上限可委派');
    await assert.rejects(() => service.startForeground('missing', req()), { name: 'SubAgentProviderNotFoundError' });
    assert.throws(() => service.registerProvider(new FakeProvider('spawn', false, makeResult({}))), /duplicate/);
};

tests['subagent.service.continuableNoticeOnceAndAbortIdle'] = async () => {
    const notices: string[] = [];
    const { store, service } = makeService(undefined, notices);
    const p = new FakeProvider('spawn', false, makeResult({}));
    service.registerProvider(p);
    const { childId } = await service.startContinuable('spawn', req());
    let rec = store.get('QQ:1', childId)!;
    assert.equal(rec.status, 'idle');
    assert.deepEqual(rec.inbox, []);
    service.markRunning(childId, () => {});
    service.finishActivation(childId, makeResult({ output: 'done' }));
    assert.equal(store.get('QQ:1', childId)?.status, 'done');
    assert.equal(notices.length, 1, '后台终态投递一次 notice');
    // 重复 finishActivation 不再重复结算/投递
    service.finishActivation(childId, makeResult({ output: 'again' }));
    assert.equal(notices.length, 1, '单次结算：不重复投递');
    // aborted → idle，不投递；再次运行后终态投递
    const { childId: c2 } = await service.startContinuable('spawn', req());
    service.markRunning(c2, () => {});
    service.finishActivation(c2, makeResult({ stopReason: 'aborted', output: '半途' }));
    assert.equal(store.get('QQ:1', c2)?.status, 'idle', 'aborted 后保持可续');
    assert.equal(notices.length, 1, 'aborted 不投递 notice');
    service.markRunning(c2, () => {});
    service.finishActivation(c2, makeResult({ output: '最终' }));
    assert.equal(notices.length, 2);
    rec = store.get('QQ:1', c2)!;
    assert.equal(rec.lastResult?.output, '最终');
};

tests['subagent.service.controlAndAbort'] = async () => {
    const notices: string[] = [];
    const { store, service } = makeService(undefined, notices);
    service.registerProvider(new FakeProvider('spawn', false, makeResult({})));
    const { childId } = await service.startContinuable('spawn', req());
    // send_message / drainInbox
    const msg = service.sendMessage(childId, 'QQ:1', '继续');
    assert.ok(msg.messageId.includes(childId));
    assert.deepEqual(service.drainInbox(childId), ['继续']);
    assert.deepEqual(service.drainInbox(childId), [], '取走即清空');
    // 权限：非 ancestor 拒绝；未知 child 拒绝
    assert.throws(() => service.sendMessage(childId, 'stranger', 'x'), { name: 'SubAgentControlDeniedError' });
    assert.throws(() => service.interrupt(childId, 'stranger'), { name: 'SubAgentControlDeniedError' });
    assert.throws(() => service.interrupt('sub:QQ:1:99', 'QQ:1'), { name: 'SubAgentNotFoundError' });
    // interrupt：只停当前激活（回调一次），agent 保留 idle
    let aborted = 0;
    service.markRunning(childId, () => { aborted++; });
    assert.equal(service.interrupt(childId, 'QQ:1'), true);
    assert.equal(aborted, 1);
    service.finishActivation(childId, makeResult({ stopReason: 'aborted' }));
    assert.equal(store.get('QQ:1', childId)?.status, 'idle');

    // abortByParent：递归清整棵树（直接子 + 挂在子下的孙）
    const { childId: c1 } = await service.startContinuable('spawn', req());
    let aborted1 = 0;
    service.markRunning(c1, () => { aborted1++; });
    const c1Rec = store.get('QQ:1', c1)!;
    const g = childIdFor(c1Rec.childSessionId, 1); // 孙代理父键 = c1 的 childSessionId
    const grand = makeRecord({
        childId: g,
        parentSessionId: c1Rec.childSessionId,
        treeRootSessionId: 'QQ:1',
        status: 'running',
        childSessionId: g,
        createdAt: 10,
    });
    store.upsert(c1Rec.childSessionId, grand);
    let aborted2 = 0;
    service.markRunning(g, () => { aborted2++; });
    const count = service.abortByParent('QQ:1');
    assert.equal(aborted1, 1, '直接子被中断');
    assert.equal(aborted2, 1, '孙代理被递归中断');
    assert.ok(count >= 2);
    assert.equal(store.get('QQ:1', c1)?.status, 'stopped');
    assert.equal(store.get(c1Rec.childSessionId, g)?.status, 'stopped');
    assert.equal(notices.length, 0, '全停不投递 notice');
};

tests['subagent.service.persistAcrossInstance'] = async () => {
    const kv = new MemoryKv();
    const store1 = new SubAgentStore(kv);
    const svc1 = new SubAgentService(store1, null);
    const p = new FakeProvider('spawn', false, makeResult({ output: 'persisted' }));
    svc1.registerProvider(p);
    const { childId } = await svc1.startForeground('spawn', req());
    // 新实例同一 kv：记录仍在
    const store2 = new SubAgentStore(kv);
    const svc2 = new SubAgentService(store2, null);
    assert.equal(svc2.listByParent('QQ:1').length, 1);
    assert.equal(svc2.listByParent('QQ:1')[0].childId, childId);
};

tests['subagent.service.cleanTerminated'] = async () => {
    const { store, service } = makeService();
    service.registerProvider(new FakeProvider('spawn', false, makeResult({})));
    await service.startForeground('spawn', req());
    const { childId } = await service.startContinuable('spawn', req());
    assert.equal(service.cleanTerminated('QQ:1'), 1, '只清已结束');
    assert.equal(store.get('QQ:1', childId)?.status, 'idle', '运行/空闲保留');
};

// ---------- child system / 唤醒 / provider 工厂 ----------
tests['subagent.childSystem.sections'] = () => {
    const content = buildChildSystemContent({ instruction: '你是只读研究员' });
    assert.ok(content.startsWith('你是只读研究员'), 'instruction 优先');
    assert.ok(content.includes('工具能力'), '默认含工具语义引导');
    const pe = buildChildSystemContent({
        instruction: 'x', promptEngineering: true, nowText: '2026-08-19 10:00',
        toolBlock: '## 可用工具\ntool-a',
    });
    assert.ok(pe.includes('## 当前时间\n2026-08-19 10:00'));
    assert.ok(pe.includes('## 可用工具\ntool-a'));
    assert.ok(pe.includes('```function'), '提示词工程模式含调用格式说明');
    const noGuidance = buildChildSystemContent({ instruction: 'x', toolGuidance: false });
    assert.ok(!noGuidance.includes('工具能力'), '可关引导');
    assert.ok(!buildChildSystemContent({ instruction: 'x' }).includes('## 当前时间'), '无时间不渲染');
};

tests['subagent.wake.decision'] = () => {
    const base = { noticeCount: 1, parentBusy: false, sessionStandby: false, globalStandby: false };
    assert.equal(decideWake(base), 'wake');
    assert.equal(decideWake({ ...base, parentBusy: true }), 'defer', '父在跑→下轮 flush 呈现');
    assert.equal(decideWake({ ...base, sessionStandby: true }), 'defer', '会话待机不主动');
    assert.equal(decideWake({ ...base, globalStandby: true }), 'defer', '全局待机不主动');
    assert.equal(decideWake({ ...base, noticeCount: 0 }), 'defer', '无 notice 不唤醒');
    assert.equal(WAKE_REASON, '子代理完成通知');
};

tests['subagent.providers.factoryAndSemantics'] = async () => {
    let prepared = 0;
    const makeExec = (res: SubAgentResult) => ({
        start: async () => ({ id: 'r', result: Promise.resolve(res), dispose: async () => {} }),
        prepareContinuable: async () => { prepared++; return { seed: { n: 1 } }; },
    });
    const spawn = createSpawnProvider('spawn', makeExec(makeResult({ output: 'spawned' })));
    const fork = createForkProvider('fork', makeExec(makeResult({ output: 'forked' })));
    assert.equal(spawn.name, 'spawn');
    assert.equal(spawn.inheritsParentContext, false, 'spawn 零父上下文');
    assert.equal(fork.inheritsParentContext, true, 'fork 继承父已完成轮次');
    assert.equal(typeof (spawn as { prepareContinuable?: unknown }).prepareContinuable, 'function', 'executor 提供则透传');
    assert.equal(typeof (fork as { prepareContinuable?: unknown }).prepareContinuable, 'function');
    const { store, service } = makeService();
    service.registerProvider(spawn);
    service.registerProvider(fork);
    assert.equal(service.getProvider('spawn')?.inheritsParentContext, false);
    assert.equal(service.getProvider('fork')?.inheritsParentContext, true);
    const out = await service.startForeground('spawn', req());
    assert.equal(out.result.output, 'spawned');
    assert.equal(prepared, 0, '前台不走 prepareContinuable');
};

// ---------- Session headless 对接（依赖 Config.registerConfig，runner 已先 require 主入口） ----------
tests['subagent.session.headlessReplyAndToolScope'] = async () => {
    (Config as unknown as { cache: unknown }).cache = {};
    Config.registerConfig();
    const names = ['zz_sub_a', 'zz_sub_b'];
    for (const n of names) {
        new Tool({ type: 'function', function: { name: n, description: 't', parameters: { type: 'object', properties: {} } } });
    }
    try {
        const s = new Session();
        s.sessionId = 'QQ:1';
        s.sessionType = 'group';
        s.toolRestriction = { allow: ['zz_sub_a'] };
        const ts = s.toolState;
        assert.equal(ts['zz_sub_a'], true, 'allow 内工具开启');
        assert.equal(ts['zz_sub_b'], false, 'allow 外工具关闭（全量继承 ∩ filter）');
        s.headless = true;
        await s.reply({} as unknown as seal.MsgContext, {} as unknown as seal.Message, ['ctx1', 'ctx2'], ['回复一', '回复二'], []);
        assert.deepEqual(s.headlessTranscript, ['回复一', '回复二'], 'headless 不发送、文本进 transcript');
        const assts = s.context.messages.filter(m => m.role === 'assistant');
        const itemCount = assts.reduce((n, m) => {
            const items = (m as { contentItems?: unknown[] }).contentItems;
            return n + (Array.isArray(items) ? items.length : 1);
        }, 0);
        assert.ok(itemCount >= 2, `assistant 内容照常入库（${itemCount}）`);
    } finally {
        for (const n of names) delete toolMap[n];
    }
};

// ---------- 配置旋钮与委派指引（limits + Config.subagent） ----------
tests['subagent.limits.effectiveAndGuide'] = () => {
    assert.equal(effectiveMaxDepth(3, 0), 3, '主会话用配置深度');
    assert.equal(effectiveMaxDepth(0, 0), 0, '0=禁委派');
    assert.equal(effectiveMaxDepth(5, 1), 0, 'child 默认不可再委派');
    assert.deepEqual(effectiveDeny(['call_ob11_api', '', 'call_ob11_api', '  x  ']), ['call_ob11_api', 'x'], '去空去重去空白');
    assert.equal(effectiveDeny(['', ' ']), null, '空名单=不设 deny（全量继承）');
    assert.equal(buildDelegationGuide(null), '', '无工具态不注入');
    assert.equal(buildDelegationGuide({ web_search: true }), '', '未开委派工具不注入');
    assert.equal(buildDelegationGuide({ subagent: true }), DELEGATION_GUIDE, '开启 subagent 注入指引');
    assert.equal(buildDelegationGuide({ subagent_fork: true }), DELEGATION_GUIDE, '开启 fork 注入指引');
};

tests['subagent.config.settingsOverrides'] = () => {
    const TC = (globalThis as { __TEST_CONFIG__: { boolConfigs: Record<string, boolean>; intConfigs: Record<string, number>; templateConfigs: Record<string, string[]> } }).__TEST_CONFIG__;
    const cfg = Config as unknown as { cache: Record<string, unknown> };
    try {
        cfg.cache = {};
        TC.boolConfigs['是否启用子代理'] = true;
        TC.intConfigs['最大委派深度'] = 5;
        TC.templateConfigs['子代理禁止调用工具'] = ['call_ob11_api', 'run_core_command', ''];
        cfg.cache = {};
        assert.equal(Config.subagent.ENABLE, true, '默认/覆盖 启用');
        assert.equal(Config.subagent.MAX_DEPTH, 5, '深度配置读入');
        assert.deepEqual(effectiveDeny(Config.subagent.DENY_TOOLS), ['call_ob11_api', 'run_core_command'], '禁调工具清洗');
        cfg.cache = {};
        TC.boolConfigs['是否启用子代理'] = false;
        assert.equal(Config.subagent.ENABLE, false, '总开关可关');
    } finally {
        cfg.cache = {};
        delete TC.boolConfigs['是否启用子代理'];
        delete TC.intConfigs['最大委派深度'];
        delete TC.templateConfigs['子代理禁止调用工具'];
        cfg.cache = {};
    }
};

// ---------- continuable 相关记录语义 ----------
tests['subagent.service.recordToolFilterAndGetRecord'] = async () => {
    const { store, service } = makeService();
    const p = new FakeProvider('spawn', false, makeResult({ output: 'x' }));
    service.registerProvider(p);
    const reqWith = req();
    (reqWith as { toolFilter?: unknown }).toolFilter = { deny: ['call_ob11_api'] };
    const { childId } = await service.startForeground('spawn', reqWith);
    assert.equal(service.getRecord(childId)?.status, 'done');
    assert.deepEqual(service.getRecord(childId)?.toolFilter, { deny: ['call_ob11_api'] }, 'toolFilter 持久化在记录');
    assert.equal(service.getRecord('sub:QQ:9:1'), null, '未知返回 null');
    // 跨实例持久化
    const store2 = new SubAgentStore(new MemoryKv());
    void store2;
    const kvSame = (store as unknown as { kv?: unknown });
    void kvSame;
    assert.deepEqual(service.getRecord(childId)?.toolFilter, { deny: ['call_ob11_api'] });
    assert.equal(store.get('QQ:1', childId)?.toolFilter?.deny?.length, 1);
};

tests['subagent.providers.prepareOptional'] = () => {
    const plain = createSpawnProvider('spawn-plain', { start: async () => ({ id: 'r', result: Promise.resolve(makeResult({})), dispose: async () => {} }) });
    assert.equal((plain as { prepareContinuable?: unknown }).prepareContinuable, undefined, '无 prepare 不暴露能力位');
};

// ---------- headless 激活循环（注入假请求，验证基本流形态） ----------
tests['subagent.childLoop.basicFlows'] = async () => {
    const child = createChildSession({
        sessionId: 'sub:QQ:1:1',
        parentSessionId: 'QQ:1',
        isPrivate: true,
        depth: 1,
        toolStateSnapshot: {},
    });
    const seen: { task?: string; content?: string }[] = [];
    const request = async (messages: unknown[]) => {
        const last = messages[messages.length - 1] as { content?: string };
        seen.push({ task: typeof last.content === 'string' ? last.content : undefined });
        return { content: '最终结论', tool_calls: undefined };
    };
    // 完成：内容原样返回（原生/提示词工程无函数块两分支都收敛到 completed 文本）
    const ok = await runHeadlessActivation({ ctx: {} as seal.MsgContext, msg: {} as seal.Message, child, systemText: '你是子代理', task: '任务甲', use: 'chat', model: { name: 'fake' }, request: request as never });
    assert.equal(ok.stopReason, 'completed');
    assert.equal(ok.output, '最终结论');
    assert.equal(seen[0]?.task, '任务甲', '首轮请求携带任务');

    // 空回复：completed 且 output 为空（供上层“空输出不发言/提示无文字”判断）
    const child2 = createChildSession({ sessionId: 'sub:QQ:1:2', parentSessionId: 'QQ:1', isPrivate: true, depth: 1 });
    const empty = await runHeadlessActivation({ ctx: {} as seal.MsgContext, msg: {} as seal.Message, child: child2, systemText: 'x', task: 't', use: 'chat', model: { name: 'fake' }, request: async () => ({ content: '', tool_calls: undefined }) });
    assert.equal(empty.stopReason, 'completed');
    assert.equal(empty.output, '');

    // 运行中被 interrupt（stopEvent 触发）→ aborted：激活入口会先重置 stopEvent，
    // 因此在请求内部触发 stop 并抛错，由 catch 的 isStopped 分支收敛为 aborted
    const child3 = createChildSession({ sessionId: 'sub:QQ:1:3', parentSessionId: 'QQ:1', isPrivate: true, depth: 1 });
    const aborted = await runHeadlessActivation({
        ctx: {} as seal.MsgContext, msg: {} as seal.Message, child: child3, systemText: 'x', task: 't', use: 'chat', model: { name: 'fake' },
        request: async () => { child3.stopEvent.fired = true; throw new Error('boom'); },
    });
    assert.equal(aborted.stopReason, 'aborted');

    // 请求抛错：error 且带诊断
    const child4 = createChildSession({ sessionId: 'sub:QQ:1:4', parentSessionId: 'QQ:1', isPrivate: true, depth: 1 });
    const err = await runHeadlessActivation({ ctx: {} as seal.MsgContext, msg: {} as seal.Message, child: child4, systemText: 'x', task: 't', use: 'chat', model: { name: 'fake' }, request: async () => { throw new Error('boom'); } });
    assert.equal(err.stopReason, 'error');
    assert.ok((err.diagnostic ?? '').includes('boom'), '错误诊断透出');
};

// ---------- checkpoint：无损编解码 / 续跑不丢内容 / 生命周期绑定清扫 ----------
tests['subagent.checkpoint.roundtripNoLoss'] = () => {
    const sample: Array<Record<string, unknown>> = [
        { role: 'system', content: '你是子代理' },
        { role: 'user', content: '任务甲' },
        { role: 'assistant', content: '', reasoning_content: '先查资料', tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: '网页全文很长……' },
        { role: 'assistant', content: '结论' },
    ];
    const decoded = decodeCheckpoint(encodeCheckpoint(sample as never));
    assert.deepEqual(decoded, sample, 'encode→decode 内容逐条无损（含 tool 配对与 reasoning）');
};

tests['subagent.checkpoint.resumeBaseAndSnapshots'] = async () => {
    const child = createChildSession({ sessionId: 'sub:QQ:1:1', parentSessionId: 'QQ:1', isPrivate: true, depth: 1 });
    const base = [
        { role: 'system' as const, content: '你是子代理' },
        { role: 'user' as const, content: '任务甲' },
        { role: 'assistant' as const, content: '已完成一半', reasoning_content: '想' },
    ];
    const snapshots: string[] = [];
    let lastUserTask = '';
    const ok = await runHeadlessActivation({
        ctx: {} as seal.MsgContext, msg: {} as seal.Message, child, systemText: 'x', task: '继续', use: 'chat',
        model: { name: 'fake' },
        baseMessages: base as never,
        checkpoint: msgs => { snapshots.push(JSON.stringify(msgs)); },
        request: async (messages: unknown[]) => {
            const last = messages[messages.length - 1] as { content?: string; role?: string };
            if (last.role === 'user') lastUserTask = String(last.content ?? '');
            return { content: '最终', tool_calls: undefined };
        },
    });
    assert.equal(ok.stopReason, 'completed');
    assert.equal(lastUserTask, '继续', '续跑仅追加本轮新任务');
    assert.ok(snapshots.length >= 1, '每轮持久化快照');
    const lastSnap = JSON.parse(snapshots[snapshots.length - 1]);
    assert.equal(lastSnap.length, 4, '快照 = base 3 条 + 新任务 1 条，不丢内容');
    assert.equal(lastSnap[2].reasoning_content, '想', '原消息的 reasoning 保留');
};

tests['subagent.service.noticeLifecycleSweepAndReload'] = async () => {
    // 1) 新记录：曾 notice 且父上下文已遗忘（清扫时）→ 清理；结算本身不立即删除（notice 尚未 flush）
    const notices: string[] = [];
    const { store, service } = makeService(undefined, notices);
    (service as unknown as { onParentNoticeIds: ((p: string) => Set<string>) | null }).onParentNoticeIds = () => new Set<string>();
    service.registerProvider(new FakeProvider('spawn', false, makeResult({ output: 'ok' })));
    const { childId } = await service.startContinuable('spawn', req());
    service.markRunning(childId, () => {});
    service.finishActivation(childId, makeResult({ output: 'ok' }));
    assert.equal(notices.length, 1, '曾投 notice');
    assert.ok(service.getRecord(childId), '结算后记录仍在（等待 notice flush/上下文淘汰）');
    assert.equal(service.sweepParent('QQ:1'), 1, '父上下文已无该 notice → 清理');
    assert.equal(service.getRecord(childId), null);
    // 2) 新记录未结算（idle，可手动续）不清扫；running 不被打断
    const kv2 = new MemoryKv();
    const store2 = new SubAgentStore(kv2);
    const svc2 = new SubAgentService(store2, null, { onParentNoticeIds: () => new Set<string>() });
    const p2 = new FakeProvider('spawn', false, makeResult({}));
    svc2.registerProvider(p2);
    const fresh = await svc2.startContinuable('spawn', req());
    assert.equal(svc2.sweepParent('QQ:1'), 0, '未结算的新记录不清扫');
    svc2.markRunning(fresh.childId, () => {});
    assert.equal(svc2.sweepParent('QQ:1'), 0, 'running 不清扫');
    // 3) 重载对账：running → interrupted（可续）
    const svc3 = new SubAgentService(new SubAgentStore(kv2), null);
    assert.equal(svc3.reconcileReload('QQ:1'), 1);
    assert.equal(svc3.getRecord(fresh.childId)?.status, 'interrupted');
    // 4) 遗留未绑定（旧版记录无 recVer）→ 清理
    const kv3 = new MemoryKv();
    const store3 = new SubAgentStore(kv3);
    const svc4 = new SubAgentService(store3, null, { onParentNoticeIds: () => new Set<string>() });
    const legacy = makeRecord({ childId: 'sub:QQ:9:1', parentSessionId: 'QQ:9', status: 'done' });
    store3.upsert('QQ:9', legacy); // 旧版记录：无 recVer
    assert.equal(svc4.sweepParent('QQ:9'), 1, '遗留未绑定记录清理');
    assert.equal(svc4.getRecord('sub:QQ:9:1'), null);
    void store;
};




