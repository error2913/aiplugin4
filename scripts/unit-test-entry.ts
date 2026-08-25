// 提示词/上下文构建单元测试入口（由 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ）
// @ts-nocheck
import assert from "node:assert/strict";

import Config from "../src/config/config";
Config.registerConfig();

import { estimateTextTokens, estimateMessageTokens, handleMessages } from "../src/utils/message";
import { buildContentParts, normalizeMCPResult } from "../src/tool/mcp/result";
import { SUMMARY_PROMPT_TEMPLATE } from "../src/prompt/templates";
import { stripRenderTags } from "../src/utils/string";
import { resolveSendMessage } from "../src/transport/ob11/message_segments";
import SessionMemoryService, { parseLooseJson } from "../src/memory/session_memory";
import { MemoryEngine } from "../src/memory/v2/engine";
import { migrateLegacyMemory } from "../src/memory/v2/migrate";
import { buildMemoryPrompt } from "../src/memory/v2/prompt";
import { InMemoryMemoryStorage } from "../src/memory/v2/storage";
import { Context } from "../src/context/context";
import Image from "../src/resource/image";
import Tool, { toolMap } from "../src/tool/tool";
import { registerDispatchTools } from "../src/tool/tools/core/tool_dispatch";

const TC = (globalThis as any).__TEST_CONFIG__;

function resetConfigCache() {
    (Config as any).cache = {};
}

function makeCtx(): any {
    return { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:10000', name: '测试员' } };
}



export const tests: Record<string, () => void | Promise<void>> = {
    /** token 估算口径：ASCII 4 字符/token，非 ASCII 1 字符/token */
    testEstimateTextTokens(): void {
        assert.equal(estimateTextTokens('abcd'), 1);
        assert.equal(estimateTextTokens('abcdefgh'), 2);
        assert.equal(estimateTextTokens('你好'), 2);
        assert.equal(estimateTextTokens('abc你好'), 3);
        assert.equal(estimateTextTokens(''), 0);
    },

    /** 单条消息估算：覆盖文本/contentItems/多模态/工具调用，多模态图片按固定开销而非 base64 原文 */
    testEstimateMessageTokens(): void {
        assert.equal(estimateMessageTokens({ role: 'user', content: '你好' } as any), 2);
        assert.equal(
            estimateMessageTokens({ role: 'user', contentItems: [{ text: '你好', time: 0 }] } as any),
            2
        );
        // 10KB base64 图片只按 [image] 占位估算，总估算必须远小于把 base64 当文本算的结果
        const multimodal = {
            role: 'user',
            content: [
                { type: 'text', text: '图' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(10000) } }
            ]
        };
        const multimodalEst = estimateMessageTokens(multimodal as any);
        assert.ok(multimodalEst < 10, `多模态估算应远小于 base64 原文(${multimodalEst})`);
        // tool_calls JSON 计入估算
        const withTools = {
            role: 'assistant',
            content: '调用',
            tool_calls: [{ id: '1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]
        };
        assert.ok(estimateMessageTokens(withTools as any) > estimateTextTokens('调用'));
    },

    /** MCP 结果归一化：text/image/resource 转成文本引用 + 多模态 contentParts */
    testNormalizeMCPResult(): void {
        const normalized = normalizeMCPResult({
            content: [
                { type: 'text', text: '标题' },
                { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', mimeType: 'image/png' },
                { type: 'resource', resource: { uri: 'mcp://mcp-files-exec/output/a.txt', mimeType: 'text/plain', text: '文件内容' } }
            ],
            structuredContent: { url: 'https://example.com' }
        });
        assert.ok(normalized.text.includes('标题'), '应保留文本');
        assert.ok(normalized.text.includes('图片[img:'), '图片应转成 [img:] 引用');
        assert.ok(normalized.text.includes('文件内容'), 'resource 文本应并入');
        assert.equal(normalized.images.length, 1);
        assert.ok(normalized.images[0].src.startsWith('data:image/png;base64,'));
        assert.equal(normalized.resources.length, 1);
        assert.equal(normalized.resources[0].uri, 'mcp://mcp-files-exec/output/a.txt');

        const parts = buildContentParts(normalized);
        assert.ok(parts.some(p => p.type === 'text'));
        assert.ok(parts.some(p => p.type === 'image_url' && (p as any).image_url.url.startsWith('data:image/png;base64,')));
    },

    /** 多模态工具结果：contentParts 直接进入请求体，非多模态退化为文本 */
    async testToolMultimodalContentParts(): Promise<void> {
        TC.intConfigs['上下文最大token'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        const system = { role: 'system', text: '系统' };
        const session = {
            context: {
                messages: [
                    { role: 'assistant', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'screenshot_url', arguments: '{}' } }] },
                    { role: 'tool', text: '图[img:mcp_1]', contentParts: [
                        { type: 'text', text: '图' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                    ], toolCallId: 'call_1', toolName: 'screenshot_url' }
                ]
            }
        };
        const out = await handleMessages(makeCtx(), session as any, true, undefined, system as any);
        const tool = out.find(m => m.role === 'tool');
        assert.ok(Array.isArray(tool.content), '多模态下工具结果应为 content 数组');
        assert.ok((tool.content as any[]).some((p: any) => p.type === 'image_url'));
        const outText = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
        const toolText = outText.find(m => m.role === 'tool');
        assert.equal(toolText.content, '图[img:mcp_1]', '非多模态应退化为文本');
    },

    /** call_tool 必须透传 ToolSolveContent，不能把对象 toString 成 [object Object] */
    async testCallToolPropagatesContentParts(): Promise<void> {
        registerDispatchTools();
        const inner = new Tool({
            type: 'function',
            function: {
                name: 'mcp_fake_image',
                description: 'fake mcp image tool',
                parameters: { type: 'object', properties: {} }
            }
        });
        inner.solve = async () => ({
            text: '图片[img:mcp_fake_1]',
            contentParts: [
                { type: 'text', text: '图片[img:mcp_fake_1]' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
            ]
        });
        const callTool = toolMap['call_tool'];
        assert.ok(callTool, 'call_tool 应已注册');
        const session = {
            sessionType: 'group',
            toolState: { mcp_fake_image: true }
        };
        const result = await callTool.solve(makeCtx(), {} as any, session as any, {
            name: 'mcp_fake_image',
            arguments: {}
        });
        assert.equal(typeof result, 'object');
        assert.ok((result as any).text.includes('图片[img:mcp_fake_1]'), '应包含文本结果而非 [object Object]');
        assert.ok(Array.isArray((result as any).contentParts), '应透传多模态 contentParts');
        assert.equal((result as any).contentParts[1].type, 'image_url');
    },



    /** 预算裁剪：整条丢弃最早的未保护消息，system 永不丢弃 */
    async testTokenBudgetDropsEarliest(): Promise<void> {
        TC.intConfigs['上下文最大token'] = 200;
        TC.intConfigs['插入system message间隔轮数'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        const system = { role: 'system', text: '系'.repeat(100) }; // 100 token
        const session = {
            context: {
                messages: [
                    { role: 'user', text: '一'.repeat(50) },
                    { role: 'user', text: '二'.repeat(50) },
                    { role: 'user', text: '三'.repeat(50) }
                ]
            }
        };
        const out = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
        assert.equal(out.length, 3, '应保留 system + 2 条最近消息');
        assert.equal(out[0].content, '系'.repeat(100));
        assert.equal(out[1].content, '二'.repeat(50), '最早的「一」应被丢弃');
        assert.equal(out[2].content, '三'.repeat(50));
    },

    /** 预算裁剪：单条超大消息不再整条丢弃清空上下文，而是按缺口截断并保留尾部 */
    async testTokenBudgetTruncatesHugeMessage(): Promise<void> {
        TC.intConfigs['上下文最大token'] = 200;
        TC.intConfigs['插入system message间隔轮数'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        const system = { role: 'system', text: '系'.repeat(100) }; // 100 token
        const huge = '超'.repeat(300); // 300 token，单条超出整个可用预算
        const session = { context: { messages: [{ role: 'user', text: huge }] } };
        const out = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
        assert.equal(out.length, 2, '超大消息应被截断而不是整条丢弃');
        assert.ok(out[1].content.length < 300, '超大消息应被截断');
        assert.equal(out[1].content, huge.slice(-100), '应保留最近 100 字符');
        // 总估算不超过预算
        const total = estimateMessageTokens(out[0] as any) + estimateMessageTokens(out[1] as any);
        assert.ok(total <= 200, `裁剪后应不超预算，实际 ${total}`);
    },

    /** prompt 工程模式：工具结果转 user 时保留工具名来源 */
    async testPromptEngineeringToolName(): Promise<void> {
        TC.intConfigs['上下文最大token'] = 0; // 不限
        TC.boolConfigs['切换为提示词工程'] = true;
        resetConfigCache();
        const system = { role: 'system', text: '系统' };
        const session = {
            context: {
                messages: [
                    { role: 'user', text: '帮我查天气' },
                    { role: 'tool', text: '晴，25度', toolCallId: 'call_1', toolName: 'get_weather' }
                ]
            }
        };
        const out = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
        const toolMsg = out.find(m => typeof m.content === 'string' && m.content.includes('晴，25度'));
        assert.ok(toolMsg, '工具结果应出现在输出中');
        assert.equal(toolMsg.role, 'user', 'prompt 工程下工具结果转成 user');
        assert.ok((toolMsg.content as string).startsWith('【工具返回:get_weather】'), '应带工具名');

        // 旧上下文无 toolName 时退化为通用标记
        const session2 = { context: { messages: [{ role: 'tool', text: '结果', toolCallId: 'call_2' }] } };
        const out2 = await handleMessages(makeCtx(), session2 as any, false, undefined, system as any);
        const toolMsg2 = out2.find(m => typeof m.content === 'string' && m.content.includes('结果'));
        assert.ok((toolMsg2.content as string).startsWith('【工具返回】'));
        assert.ok(!(toolMsg2.content as string).startsWith('【工具返回:'));
    },

    /** 总结记忆模板：示例 JSON 必须可被 JSON.parse 解析，且不含单引号键；协议为 summary + facts(op) */
    testSummaryTemplateValidJson(): void {
        const rendered = SUMMARY_PROMPT_TEMPLATE({
            '角色设定': '测试角色',
            '平台': '',
            '私聊': true,
            '用户名称': '小明',
            '用户号码': '10001',
            '对话内容': '一些对话'
        });
        const start = rendered.indexOf('返回格式为JSON');
        assert.ok(start >= 0, '模板应包含返回格式说明');
        const brace = rendered.indexOf('{', start);
        const block = rendered.slice(brace, rendered.lastIndexOf('}') + 1);
        const parsed = JSON.parse(block); // 必须不抛异常
        assert.ok(parsed.summary && parsed.summary.type === 'string');
        assert.ok(parsed.facts && parsed.facts.type === 'array');
        assert.ok(parsed.facts.items.properties.op, 'facts 条目应包含 op 操作类型');
        assert.ok(parsed.facts.items.properties.related_user_ids.type === 'array');
        assert.ok(parsed.facts.items.properties.importance.type === 'number');
        assert.ok(!block.includes("'"), '示例 JSON 不应再包含单引号');
    },

    async testSendMessageResolveRenderTags(): Promise<void> {
        const ctx = makeCtx();
        const img = new Image();
        img.url = 'http://example.com/gen.png';
        const session = {
            context: {
                findImage: async (_c: any, id: string) => (id === '噩梦之石照片_abc' || id === 'img1' ? img : null)
            }
        };

        // 字符串消息：剥内部标签、[img:] 解析成图片段、[at]/[poke]/[quote]/[face] 转段
        const segs = await resolveSendMessage(
            ctx as any,
            session as any,
            '图来了[img:噩梦之石照片_abc][msg_id:9pzh8k][system:x][time:2026]好[at:123][poke:456][quote:abc][face:撇嘴]'
        ) as any[];
        assert.deepEqual(
            segs.map(s => s.type),
            ['text', 'image', 'text', 'at', 'poke', 'reply', 'face'],
            '渲染标签应全部转换为对应消息段'
        );
        assert.equal(segs[0].data.text, '图来了');
        assert.equal(segs[1].data.file, 'http://example.com/gen.png', '[img:] 应解析为真实图片段');
        assert.equal(segs[2].data.text, '好');
        assert.equal(segs[3].data.qq, '123');
        assert.equal(segs[4].data.qq, '456');
        assert.ok(segs[5].data.id !== undefined && !String(segs[5].data.id).includes('NaN'), 'quote 应转 reply 段');
        assert.ok(segs[6].data.id !== undefined, 'face 应转 face 段');
        const joined = JSON.stringify(segs);
        assert.ok(!joined.includes('msg_id') && !joined.includes('[system') && !joined.includes('[time'),
            '内部标签不得原样外发');

        // 数组消息：只处理 text 段，结构化段原样保留
        const arr = await resolveSendMessage(ctx as any, session as any, [
            { type: 'text', data: { text: '配图[img:img1]' } },
            { type: 'at', data: { qq: '789' } }
        ]) as any[];
        assert.deepEqual(arr.map(s => s.type), ['text', 'image', 'at']);
        assert.equal(arr[1].data.file, 'http://example.com/gen.png');

        // 找不到的图片：丢弃，不泄露原文
        const miss = await resolveSendMessage(ctx as any, session as any, '无图[img:不存在]') as any[];
        assert.deepEqual(miss.map(s => s.type), ['text']);
        assert.equal(miss[0].data.text, '无图');
    },

    /** 纯文本出口清洗：论坛等不支持消息段的场景剥掉全部插件标签，只留正文（回归：发帖/评论裸发内部标签） */
    testStripRenderTags(): void {
        assert.equal(
            stripRenderTags('图来了[img:abc][msg_id:9pzh8k][system:x][time:2026][from:别人][at:123][poke:456][quote:abc][face:撇嘴]正文'),
            '图来了正文',
            '内部标签与渲染标签应全部剥离'
        );
        assert.equal(stripRenderTags('  [img:a][at:b]  '), '', '纯标签内容应清空');
        assert.equal(stripRenderTags('纯文本 **加粗** `code` [CQ:at,qq=1]'), '纯文本 **加粗** `code` [CQ:at,qq=1]', 'Markdown 与 CQ 码不应被误伤');
        assert.equal(stripRenderTags('旧<|msg_id:abc|>版<|img:x|>文'), '旧版文', '旧版 <|...|> 变体应归一化后剥离');
        assert.equal(stripRenderTags(''), '');
    },

    /** 宽容 JSON 解析：代码块围栏/前后缀文本都应能提取；垃圾输入返回 null */
    testParseLooseJson(): void {
        assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 }, '应剥离 markdown 围栏');
        assert.deepEqual(parseLooseJson('```\n{"a":1}\n```'), { a: 1 }, '无 json 标识的围栏也应剥离');
        assert.deepEqual(parseLooseJson('好的，结果是 {"a":1,"b":"x"} 这就是了'), { a: 1, b: 'x' }, '应容忍前后缀文本');
        assert.equal(parseLooseJson('完全不是 JSON'), null, '垃圾输入返回 null');
        assert.equal(parseLooseJson(''), null, '空串返回 null');
    },

    testContextSummaryCursorAdjustsOnTrim(): void {
        TC.intConfigs['对话保存轮数'] = 2;
        resetConfigCache();
        const ctx = new Context();
        ctx.messages = [
            { role: 'user' }, { role: 'user' }, { role: 'user' }, { role: 'user' }
        ] as any;
        ctx.lastSummarizedIndex = 3;
        ctx.limitMessages();
        assert.equal(ctx.messages.length, 2, '应裁剪头部保留最近窗口');
        assert.equal(ctx.lastSummarizedIndex, 1, '游标应随头部裁剪回退');
    },


    /** Hindsight-like 新引擎：Retain 精确查重与关键词召回 */
    async testV2RetainDedupAndRecall(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage() });
        const r1 = await engine.addMemory('user_test', { content: '小明喜欢喝咖啡', tags: ['user:QQ1'] });
        const r2 = await engine.addMemory('user_test', { content: '小明喜欢喝咖啡', tags: ['user:QQ1'] });
        assert.equal(r1.action, 'added');
        assert.equal(r2.action, 'merged', '同 bank 同文本应合并');
        assert.equal(r1.unitIds[0], r2.unitIds[0]);
        const results = await engine.recall('user_test', '咖啡', { tags: ['user:QQ1'], maxTokens: 200 });
        assert.ok(results.some(r => r.unit.text.includes('咖啡')), '关键词应召回咖啡记忆');
    },

    /** Hindsight-like 新引擎：时间检索窗口 */
    async testV2TemporalRecall(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage() });
        const now = Date.now();
        await engine.addMemory('user_t', {
            content: '去年去了日本旅游',
            occurredStart: new Date(now - 400 * 86400000).getTime(),
            occurredEnd: new Date(now - 370 * 86400000).getTime(),
        });
        await engine.addMemory('user_t', { content: '今天买了咖啡' });
        const results = await engine.recall('user_t', '去年发生了什么', { maxTokens: 200 });
        assert.ok(results.some(r => r.unit.text.includes('日本旅游')), '时间检索应命中去年事件');
    },

    /** Hindsight-like 新引擎：Consolidation 生成 Observation */
    async testV2ConsolidationCreatesObservation(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage() });
        await engine.addMemory('user_c', { content: '小明喜欢 Python', entities: ['小明', 'Python'] });
        await engine.addMemory('user_c', { content: '小明喜欢写类型注解', entities: ['小明', 'Python'] });
        const result = await engine.consolidate('user_c');
        assert.ok(result.created.length > 0, '应生成至少一条 Observation');
        const observations = engine.repository.listObservations('user_c');
        assert.ok(observations.length > 0);
        assert.ok(observations[0].evidence.length >= 2, 'Observation 应携带多条证据');
    },

    /** Hindsight-like 新引擎：MentalModel 与 Observation 的 Prompt 渲染 */
    async testV2PromptRendersMentalModel(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage() });
        await engine.createMentalModel('user_p', '这个用户的偏好是什么？', '用户喜欢简洁的回复');
        const prompt = buildMemoryPrompt({
            isPrivate: true,
            sessionName: '测试员',
            mentalModels: engine.listMentalModels('user_p'),
            observations: [],
            recalls: [],
        });
        assert.ok(prompt.includes('心智模型'), 'Prompt 应包含心智模型段');
        assert.ok(prompt.includes('用户喜欢简洁的回复'), 'Prompt 应包含心智模型答案');
    },

    /** Hindsight-like 新引擎：旧记忆迁移到新 Bank */
    async testV2MigrateLegacyMemory(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage() });
        const old = {
            id: 'legacy1',
            content: '小明喜欢喝咖啡',
            importance: 0.9,
            tags: ['咖啡'],
            users: ['QQ:1']
        };
        const count = await migrateLegacyMemory('user_m', { memoryMap: { legacy1: old }, summaries: ['旧总结'], persona: '喜欢简洁' }, engine);
        assert.ok(count >= 2, '应迁移旧记忆/总结，实际 ' + count);
        const results = await engine.recall('user_m', '咖啡', { maxTokens: 200 });
        assert.ok(results.some(r => r.unit.text.includes('咖啡')), '迁移后应能检索到旧记忆');
        const models = engine.listMentalModels('user_m');
        assert.ok(models.some(m => m.answer === '喜欢简洁'), 'persona 应迁移为心智模型');
    },

    /** Hindsight-like 新引擎：LLM 抽取 / Rerank / Observation 合成 / MentalModel 刷新 */
    async testV2ExtractorRerankSynthesisAndRefresh(): Promise<void> {
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            extract: async () => [
                { text: '小明喜欢喝咖啡', entities: ['小明'] },
                { text: '小红喜欢喝茶', entities: ['小红'] },
            ],
            rerank: async (_query, candidates) => candidates.map(c => c.id).reverse(),
            synthesizeObservation: async (quotes) => '综合观察：' + quotes.join(' | '),
        });
        await engine.retain('user_r', { content: '对话原文', verbatim: false });
        assert.equal(engine.repository.listUnits('user_r').length, 2, 'LLM 抽取应生成两条事实');
        await engine.addMemory('user_r', { content: '小明喜欢喝茶', entities: ['小明'] });
        const recalls = await engine.recall('user_r', '咖啡', { maxTokens: 200 });
        assert.ok(recalls.length > 0, 'Rerank 后仍应返回结果');
        await engine.consolidate('user_r');
        const observations = engine.repository.listObservations('user_r');
        assert.ok(observations.some(o => o.text.startsWith('综合观察：')), 'Observation 应使用合成器生成');
        await engine.createMentalModel('user_m2', '偏好是什么？', '旧答案');
        await engine.refreshMentalModels('user_m2');
        const model = engine.listMentalModels('user_m2')[0];
        assert.ok(model.version > 1, 'MentalModel 应被刷新版本号');
    }

};
