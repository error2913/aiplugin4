// 子代理独立模块 + 独立上下文单测（P3）。
// 覆盖：消息叠加上限/自动压缩/滚动摘要/工具组原子/失败降级/checkpoint 生命周期/child 接线/依赖边界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import './test-host';
import Config from '../src/config/config';
import type { RequestMessage } from '../src/utils/message';
import {
    DEFAULT_SUBAGENT_CONTEXT_TOKENS,
    MemoryKv,
    SubAgentContext,
    SubAgentService,
    SubAgentStore,
    createChildSession,
    decodeCheckpoint,
    encodeCheckpoint,
    estimateSubAgentMessageTokens,
    estimateSubAgentTextTokens,
    extractInjectedSummary,
    resolveSubAgentContextTokens,
    runHeadlessActivation,
    stripInjectedContextSections,
} from '../src/subagent';

export const tests: Record<string, () => void | Promise<void>> = {};

const msg = (role: RequestMessage['role'], content: string, extra: Partial<RequestMessage> = {}): RequestMessage =>
    ({ role, content, ...extra }) as RequestMessage;

/** 工具调用/结果必须成组：tool 前必须能追溯到发起它的 assistant(tool_calls) */
function assertToolPairing(messages: RequestMessage[]): void {
    for (let i = 0; i < messages.length; i++) {
        const current = messages[i] as unknown as { role: string; tool_call_id?: string };
        if (current.role !== 'tool') continue;
        let j = i - 1;
        while (j >= 0 && (messages[j] as unknown as { role: string }).role === 'tool') j--;
        assert.ok(j >= 0, 'tool 结果不能出现在最前面（会 400）');
        const owner = messages[j] as unknown as { role: string; tool_calls?: Array<{ id: string }> };
        assert.equal(owner.role, 'assistant', 'tool 结果前必须是发起它的 assistant');
        assert.ok(
            Array.isArray(owner.tool_calls) && owner.tool_calls.some(tc => tc.id === current.tool_call_id),
            `tool 结果的 tool_call_id=${current.tool_call_id} 必须在前面 assistant.tool_calls 中`,
        );
    }
    for (let i = 0; i < messages.length; i++) {
        const calls = (messages[i] as unknown as { tool_calls?: Array<{ id: string }> }).tool_calls;
        if (!Array.isArray(calls) || calls.length === 0) continue;
        for (const call of calls) {
            assert.ok(
                messages.some(m => (m as unknown as { role: string }).role === 'tool' && (m as unknown as { tool_call_id?: string }).tool_call_id === call.id),
                `assistant.tool_calls(${call.id}) 必须有对应 tool 结果`,
            );
        }
    }
}

function makeChildRecord(childId: string, status: 'done' | 'idle' = 'done') {
    return {
        childId,
        parentSessionId: 'QQ:1',
        treeRootSessionId: 'QQ:1',
        parentAgentName: '',
        provider: 'spawn',
        label: 'test',
        depth: 1,
        status,
        childSessionId: childId,
        agentName: '',
        meta: { epId: 'QQ:0', isPrivate: true },
        createdAt: 1,
        updatedAt: 1,
        inbox: [],
        toolFilter: null,
    } as unknown as import('../src/subagent').ChildRecord;
}

// ---------- 基础叠加上限 ----------

tests['subagentContext.orderingAndSnapshot'] = () => {
    const context = new SubAgentContext({
        systemText: '你是子代理',
        seed: [msg('user', 'seed-user'), msg('assistant', 'seed-bot')],
        task: '做任务',
        maxTokens: 100000,
    });
    const messages = context.snapshot();
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, 'system');
    assert.equal((messages[1] as { content?: string }).content, 'seed-user');
    assert.equal((messages[3] as { content?: string }).content, '做任务');
    // 快照是数组浅拷贝：追加/改数组不影响内部
    messages.push(msg('user', '外部追加'));
    assert.equal(context.messageCount(), 4);
    context.append(msg('assistant', '完成'));
    assert.equal(context.messageCount(), 5);
};

tests['subagentContext.noCompressBelowLimit'] = async () => {
    const context = new SubAgentContext({ systemText: 's', task: '短任务', maxTokens: 100000 });
    const before = context.tokenCount();
    const result = await context.maybeCompress();
    assert.equal(result.compressed, false);
    assert.equal(result.mode, 'none');
    assert.equal(result.beforeTokens, before);
    assert.equal(result.afterTokens, before);
    // 重复调用保持幂等
    assert.equal((await context.maybeCompress()).compressed, false);
};

tests['subagentContext.disabledWhenLimitZero'] = async () => {
    const context = new SubAgentContext({ systemText: 's', task: 'x'.repeat(1000), maxTokens: 0 });
    const result = await context.maybeCompress();
    assert.equal(result.mode, 'disabled');
    assert.equal(result.compressed, false);
    assert.ok(context.tokenCount() > 0);
};

tests['subagentContext.estimateTokens'] = () => {
    assert.equal(estimateSubAgentTextTokens(''), 0);
    assert.ok(estimateSubAgentTextTokens('你好世界') >= 4);
    assert.ok(estimateSubAgentTextTokens('hello world') > 0);
    const withCalls = msg('assistant', 'x', {
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    } as never);
    assert.ok(estimateSubAgentMessageTokens(withCalls) > estimateSubAgentMessageTokens(msg('user', 'x')));
};

// ---------- 摘要压缩 ----------

function bigBody(): RequestMessage[] {
    const body: RequestMessage[] = [];
    for (let i = 0; i < 12; i++) {
        body.push(msg('user', `第 ${i} 轮用户问题：${'细节'.repeat(20)}`));
        body.push(msg('assistant', `第 ${i} 轮回答：${'结论'.repeat(20)}`));
    }
    return body;
}

tests['subagentContext.summaryCompressAndRoll'] = async () => {
    const summaries: string[] = [];
    const inputs: string[] = [];
    const context = new SubAgentContext({
        systemText: '你是子代理，请完成委派任务',
        seed: bigBody(),
        task: '最终任务：汇总',
        maxTokens: 600,
        keepRatio: 0.5,
        summarize: (input, opts) => {
            inputs.push(input);
            assert.ok(opts.maxTokens > 0);
            summaries.push(`摘要${summaries.length + 1}`);
            return summaries[summaries.length - 1];
        },
    });
    const before = context.tokenCount();
    const result = await context.maybeCompress();
    assert.equal(result.compressed, true);
    assert.equal(result.mode, 'summary');
    assert.ok(result.droppedMessages > 0);
    assert.ok(result.afterTokens <= 600, `压缩后应在上限内（实际 ${result.afterTokens}）`);
    assert.ok(result.afterTokens < before);
    const messages = context.snapshot();
    const system = String((messages[0] as { content?: string }).content ?? '');
    assert.ok(system.includes('你是子代理'), '原 system 提示词必须保留');
    assert.equal((system.match(/## Earlier context summary \(auto-compacted\)/g) || []).length, 1, '摘要段只能有一份（滚动合并）');
    assert.ok(system.includes('摘要1'));
    assert.ok(messages.some(m => String((m as { content?: string }).content ?? '').includes('最终任务：汇总')), '最新任务必须保留');
    assertToolPairing(messages);
    // 再压一次：旧摘要要作为输入（滚动），且仍只有一份摘要段
    const second = await context.maybeCompress();
    if (second.compressed) {
        const system2 = String((context.snapshot()[0] as { content?: string }).content ?? '');
        assert.equal((system2.match(/## Earlier context summary \(auto-compacted\)/g) || []).length, 1);
        assert.ok(inputs.some(text => text.includes('[existing summary]')), '滚动压缩应带上已有摘要');
    }
};

tests['subagentContext.keepRatioBoundsRecent'] = async () => {
    const context = new SubAgentContext({
        systemText: 's',
        seed: bigBody(),
        task: '任务',
        maxTokens: 800,
        keepRatio: 0.5,
        summarize: () => '摘要正文',
    });
    await context.maybeCompress();
    const messages = context.snapshot();
    assert.ok(context.tokenCount() <= 800);
    // 最近一条 user 任务必须在
    const contents = messages.map(m => String((m as { content?: string }).content ?? ''));
    assert.ok(contents[contents.length - 1].includes('任务'));
    assertToolPairing(messages);
};

tests['subagentContext.toolGroupAtomic'] = async () => {
    const body: RequestMessage[] = [
        msg('user', '查天气，'.repeat(40)),
        {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{"city":"x"}' } }],
        } as RequestMessage,
        msg('tool', '晴天，25度', { tool_call_id: 'call-1' } as never),
        msg('user', '再查一次，'.repeat(40)),
        {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'weather', arguments: '{"city":"y"}' } }],
        } as RequestMessage,
        msg('tool', '雨天，18度', { tool_call_id: 'call-2' } as never),
        msg('user', '给结论'),
    ];
    const context = new SubAgentContext({
        systemText: 's',
        seed: body,
        task: '汇总天气',
        maxTokens: 200,
        keepRatio: 0.5,
        summarize: () => '更早内容摘要',
    });
    const result = await context.maybeCompress();
    assert.equal(result.compressed, true);
    const messages = context.snapshot();
    assert.ok(!((messages[1] as unknown as { role: string })?.role === 'tool'), '保留窗口不能以孤儿 tool 开头');
    assertToolPairing(messages);
    assert.ok(context.tokenCount() <= 200);
};

// ---------- 失败降级 ----------

tests['subagentContext.fallbackWithoutSummarizer'] = async () => {
    const context = new SubAgentContext({
        systemText: 's',
        seed: bigBody(),
        task: '任务',
        maxTokens: 400,
    });
    const result = await context.maybeCompress();
    assert.equal(result.compressed, true);
    assert.equal(result.mode, 'fallback');
    assert.ok(result.diagnostic);
    const system = String((context.snapshot()[0] as { content?: string }).content ?? '');
    assert.ok(system.includes('[earlier context omitted]'), '降级必须有明确省略标记');
    assert.ok(context.tokenCount() <= 400, `降级后仍须有界（实际 ${context.tokenCount()}）`);
    assert.ok(context.snapshot().some(m => String((m as { content?: string }).content ?? '').includes('任务')));
};

tests['subagentContext.fallbackOnSummarizerError'] = async () => {
    const context = new SubAgentContext({
        systemText: 's',
        seed: bigBody(),
        task: '任务',
        maxTokens: 400,
        summarize: () => {
            throw new Error('模型不可用');
        },
    });
    const result = await context.maybeCompress();
    assert.equal(result.mode, 'fallback');
    assert.ok(String(result.diagnostic).includes('模型不可用'));
    assert.ok(context.tokenCount() <= 400);
    assertToolPairing(context.snapshot());
};

tests['subagentContext.emptySummaryFallsBack'] = async () => {
    const context = new SubAgentContext({
        systemText: 's',
        seed: bigBody(),
        task: '任务',
        maxTokens: 400,
        summarize: () => '   ',
    });
    const result = await context.maybeCompress();
    assert.equal(result.mode, 'fallback');
};

tests['subagentContext.hugeLatestTruncated'] = async () => {
    const huge = '巨'.repeat(4000);
    const context = new SubAgentContext({
        systemText: 's',
        task: huge,
        maxTokens: 200,
        summarize: () => '不应被调用（没有可压缩的旧消息）',
    });
    const result = await context.maybeCompress();
    assert.equal(result.compressed, true);
    assert.equal(result.mode, 'truncate');
    assert.ok(result.afterTokens <= 200, `截断后应在上限内（实际 ${result.afterTokens}）`);
    const task = String((context.snapshot()[1] as { content?: string }).content ?? '');
    assert.ok(task.length < huge.length);
    assert.ok(task.includes('… (original too long; truncated)'));
};

tests['subagentContext.preservesReasoningAndToolIds'] = async () => {
    const body: RequestMessage[] = [
        msg('user', '开始'),
        {
            role: 'assistant',
            content: '',
            reasoning_content: '先想一下',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        } as RequestMessage,
        msg('tool', '工具输出', { tool_call_id: 'c1' } as never),
        msg('assistant', '中间结论'),
        msg('user', '继续'),
    ];
    const context = new SubAgentContext({
        systemText: 's',
        seed: body,
        task: '最终任务',
        maxTokens: 80,
        summarize: () => '摘要',
    });
    await context.maybeCompress();
    const messages = context.snapshot();
    assertToolPairing(messages);
    for (const message of messages) {
        const view = message as unknown as { reasoning_content?: string; tool_call_id?: string };
        if (view.tool_call_id !== undefined) assert.equal(typeof view.tool_call_id, 'string');
        if (view.reasoning_content !== undefined) assert.equal(typeof view.reasoning_content, 'string');
    }
};

// ---------- 注入段落工具函数 ----------

tests['subagentContext.injectedSectionHelpers'] = () => {
    const text = '原始 system\n\n## Earlier context summary (auto-compacted)\n摘要正文\n[earlier context omitted] x';
    assert.equal(stripInjectedContextSections(text), '原始 system');
    assert.ok(extractInjectedSummary(text).includes('摘要正文'));
    assert.equal(extractInjectedSummary('无摘要'), '');
};

// ---------- checkpoint 与存储生命周期 ----------

tests['subagentContext.checkpointKeepsCompressedState'] = async () => {
    const context = new SubAgentContext({
        systemText: 's',
        seed: bigBody(),
        task: '最后任务',
        maxTokens: 400,
        summarize: () => '压缩摘要',
    });
    await context.maybeCompress();
    const encoded = encodeCheckpoint(context.snapshot());
    const decoded = decodeCheckpoint(encoded);
    assert.deepEqual(decoded, context.snapshot());
    assertToolPairing(decoded);
    assert.ok(encoded.some(m => m.content?.includes('压缩摘要')));
};

tests['subagentStore.checkpointClearedWithRecord'] = () => {
    const kv = new MemoryKv();
    const store = new SubAgentStore(kv);
    const childId = 'sub:QQ:1:1';
    store.upsert('QQ:1', makeChildRecord(childId, 'done'));
    store.saveChildSession('QQ:1', childId, { version: 1, at: 1, messages: encodeCheckpoint([msg('system', 's'), msg('user', 'u')]) });
    assert.ok(store.loadChildSession('QQ:1', childId), 'checkpoint 应能读回');
    assert.ok(Object.keys(kv.dump()).includes(`session_sub:QQ:1:${childId}`), 'checkpoint key 形态必须保持 session_sub:<parent>:<child>');
    const svc = new SubAgentService(store, null);
    const cleaned = svc.cleanTerminated('QQ:1');
    assert.ok(cleaned >= 1);
    assert.equal(store.get('QQ:1', childId), null);
    assert.equal(store.loadChildSession('QQ:1', childId), null, '记录淘汰时必须清 checkpoint');
};

// ---------- child 接线：压缩生效 ----------

tests['subagentChildLoop.compressionIntegration'] = async () => {
    // 依赖 Config.tool（流式/PE 开关）；runner 可能尚未注册配置，这里幂等注册一次
    Config.registerConfig();
    const child = createChildSession({ sessionId: 'sub:QQ:9:1', parentSessionId: 'QQ:9', isPrivate: true, depth: 1 });
    const seed: RequestMessage[] = [
        msg('user', '旧问题：'.repeat(200)),
        msg('assistant', '旧回答：'.repeat(200)),
    ];
    let summarizeCalls = 0;
    const captured: RequestMessage[][] = [];
    const result = await runHeadlessActivation({
        ctx: {} as seal.MsgContext,
        msg: {} as seal.Message,
        child,
        systemText: '你是子代理',
        task: '新任务：'.repeat(200),
        use: 'chat',
        model: { name: 'fake' },
        seed,
        maxContextTokens: 300,
        summarize: () => {
            summarizeCalls++;
            return '子代理历史摘要';
        },
        request: async messages => {
            captured.push(messages.map(m => ({ ...m })));
            assertToolPairing(messages);
            return { content: '完成', tool_calls: undefined };
        },
    });
    assert.equal(result.stopReason, 'completed');
    assert.ok(summarizeCalls >= 1, '超上限应触发一次摘要压缩');
    assert.ok(captured.length >= 1);
    const system = String((captured[0][0] as { content?: string }).content ?? '');
    assert.ok(system.includes('子代理历史摘要'));
    assert.ok(captured[0].some(m => String((m as { content?: string }).content ?? '').includes('新任务：')));
};

// ---------- 模块边界与公共入口 ----------

tests['subagentModule.boundaryAndPublicExports'] = () => {
    const root = path.resolve(process.cwd(), 'src');
    // 1) 迁移完成：旧目录必须消失
    assert.equal(fs.existsSync(path.join(root, 'agent/subagent')), false, 'src/agent/subagent 应已迁移');
    // 2) 不得 import src/context/** 或主 Agent 编排
    const dir = path.join(root, 'subagent');
    assert.ok(fs.existsSync(dir), 'src/subagent 必须存在');
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.ts'))) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.equal(/from\s+['"](?:\.\.\/)+(?:context|agent\/agent)(?:\/|['"])/.test(source), false, `${file} 不得 import src/context/** 或主 Agent 编排`);
    }
    // 3) 公共入口导出关键能力（外部只从 index 取）
    assert.equal(typeof SubAgentContext, 'function');
    assert.equal(typeof runHeadlessActivation, 'function');
    assert.equal(typeof resolveSubAgentContextTokens, 'function');
    assert.equal(DEFAULT_SUBAGENT_CONTEXT_TOKENS, 32000);
};
