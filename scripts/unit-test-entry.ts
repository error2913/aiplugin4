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
import MemoryService from "../src/memory/memory";
import MemoryItem from "../src/memory/memory_item";
import SessionMemoryService, { parseLooseJson } from "../src/memory/session_memory";
import { MemoryEngine } from "../src/memory/v2/engine";
import { migrateLegacyMemory } from "../src/memory/v2/migrate";
import { buildMemoryPrompt } from "../src/memory/v2/prompt";
import { InMemoryMemoryStorage } from "../src/memory/v2/storage";
import { Context } from "../src/context/context";
import Image from "../src/resource/image";

const TC = (globalThis as any).__TEST_CONFIG__;

function resetConfigCache() {
    (Config as any).cache = {};
}

function makeCtx(): any {
    return { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:10000', name: '测试员' } };
}

/** 构造一个带默认值的 MemoryItem（embedding 关闭，vector 恒空） */
function mkMemory(id: string, content: string, opts: Partial<MemoryItem> = {}): MemoryItem {
    const m = new MemoryItem();
    m.id = id;
    m.content = content;
    m.users = opts.users || [];
    m.groups = opts.groups || [];
    m.tags = opts.tags || [];
    m.relatedMemories = opts.relatedMemories || [];
    m.vector = [];
    m.importance = opts.importance != null ? opts.importance : 0.5;
    m.createAt = opts.createAt || Math.floor(Date.now() / 1000);
    m.lastAccessedAt = opts.lastAccessedAt || Math.floor(Date.now() / 1000);
    m.type = opts.type || 'text';
    m.stale = !!opts.stale;
    m.accessCount = opts.accessCount || 0;
    return m;
}

/** 关闭嵌入并重置配置缓存（记忆相关测试的共同前置） */
function resetMemoryTestConfig() {
    TC.boolConfigs['是否开启嵌入模型'] = false;
    TC.intConfigs['长期记忆上限'] = 50;
    TC.intConfigs['长期记忆展示数量'] = 5;
    TC.intConfigs['核心事实注入条数'] = 3;
    resetConfigCache();
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

    /** 多用户记忆检索：传入多个 userIds 时全部参与过滤，而不是只按最后一位用户 */
    async testMemoryMultiUserRetrieval(): Promise<void> {
        TC.boolConfigs['是否开启嵌入模型'] = false;
        TC.intConfigs['长期记忆展示数量'] = 5;
        resetConfigCache();
        const svc = new MemoryService();
        const mk = (id: string, users: string[], content: string): MemoryItem => {
            const m = new MemoryItem();
            m.id = id;
            m.users = users;
            m.content = content;
            m.importance = 1;
            m.createAt = 1;
            m.tags = [];
            m.groups = [];
            m.relatedMemories = [];
            m.vector = [];
            return m;
        };
        svc.memoryMap['m1'] = mk('m1', ['QQ:10001'], '北京旅游 故宫 长城');
        svc.memoryMap['m2'] = mk('m2', ['QQ:10002'], '上海美食 生煎 小笼');

        const ctx = { isPrivate: true, endPoint: { userId: 'QQ:10001' }, group: null } as any;
        // 只检索一位用户 → 只命中该用户的记忆
        const p1 = await svc.buildMemoryPrompt(ctx, {} as any, '北京', [{ isPrivate: true, id: 'QQ:10001', name: '用户1' }], null);
        assert.ok(p1.includes('北京旅游'), '应命中用户1的记忆');
        assert.ok(!p1.includes('上海美食'), '不应命中其他用户的记忆');

        // 群聊多人在线：传入全部发言者 → 各自记忆都被检索到
        const p2 = await svc.buildMemoryPrompt(ctx, {} as any, '北京 上海', [
            { isPrivate: true, id: 'QQ:10001', name: '用户1' },
            { isPrivate: true, id: 'QQ:10002', name: '用户2' }
        ], null);
        assert.ok(p2.includes('北京旅游'), '多用户检索应命中用户1的记忆');
        assert.ok(p2.includes('上海美食'), '多用户检索应命中用户2的记忆');

        // 无匹配用户 → 无记忆可展示
        const p0 = await svc.buildMemoryPrompt(ctx, {} as any, '北京', [{ isPrivate: true, id: 'QQ:99999', name: '路人' }], null);
        assert.equal(p0, '');
    },

    /** OB11 发送路径：渲染标签解析为真实消息段，内部标签不外发（回归：#126 重构丢失发送标签解析） */
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

    /** addMemory 查重：同会话规范化内容一致时合并而非新增（B1 修复：模型重复记忆不再累积） */
    async testAddMemoryDedup(): Promise<void> {
        resetMemoryTestConfig();
        const svc = new MemoryService();
        const session = { sessionId: 'QQ:10001' } as any;
        const r1 = await svc.addMemory(null, session, [], [], [], [], '小明喜欢喝咖啡', 'public', 'fact', 0.8);
        const r2 = await svc.addMemory(null, session, [], [], [], [], '  小明 喜欢喝咖啡 ', 'public', 'fact', 0.9);
        assert.equal(r1.action, 'added');
        assert.equal(r2.action, 'merged', '规范化后内容一致应合并');
        assert.equal(r2.id, r1.id, '合并应命中同一条记忆');
        assert.equal(svc.memoryIds.length, 1, '不应产生重复记忆');
        assert.equal(svc.memoryMap[r1.id].importance, 0.9, '合并取较高重要性');
    },

    /** applyFact 管线：add → merge → update → delete → noop 全分支 */
    async testApplyFactPipeline(): Promise<void> {
        resetMemoryTestConfig();
        const svc = new MemoryService();
        const a = await svc.applyFact({ op: 'add', text: '小明喜欢喝咖啡', type: 'fact', importance: 0.9, keywords: ['咖啡'] });
        assert.equal(a.action, 'added');
        assert.ok(a.id);
        assert.equal(svc.memoryMap[a.id!].type, 'fact');
        assert.equal(svc.memoryMap[a.id!].importance, 0.9);

        const b = await svc.applyFact({ op: 'add', text: '小明喜欢喝咖啡', type: 'fact' });
        assert.equal(b.action, 'merged', '重复 add 应合并');
        assert.equal(b.id, a.id);

        const c = await svc.applyFact({ op: 'update', existing_id: a.id, text: '小明喜欢喝热咖啡', importance: 0.95 });
        assert.equal(c.action, 'updated');
        assert.equal(svc.memoryMap[a.id!].content, '小明喜欢喝热咖啡', 'update 应覆盖内容');
        assert.equal(svc.memoryMap[a.id!].importance, 0.95, 'update 应提升重要性');

        const d = await svc.applyFact({ op: 'delete', existing_id: a.id });
        assert.equal(d.action, 'deleted');
        assert.equal(svc.memoryIds.length, 0);

        const e = await svc.applyFact({ op: 'noop', text: '任意内容' });
        assert.equal(e.action, 'noop', 'noop 不写入');
        assert.equal(svc.memoryIds.length, 0);
    },

    /** 中文 n-gram 检索：无向量时关键词兜底能命中中文子串（B12 修复） */
    async testChineseNgramSearch(): Promise<void> {
        resetMemoryTestConfig();
        const svc = new MemoryService();
        svc.memoryMap['m1'] = mkMemory('m1', '小明喜欢喝咖啡，每天两杯');
        svc.memoryMap['m2'] = mkMemory('m2', '小明喜欢打篮球，周末去球场');
        const opts = { topK: 5, tags: [], relatedMemories: [], users: [], groups: [], method: 'score' as const };
        const r1 = await svc.search('咖啡', opts);
        assert.ok(r1.some(m => m.id === 'm1'), '查询「咖啡」应命中咖啡记忆');
        assert.equal(r1[0].id, 'm1', 'n-gram 命中者应排在最前');
        const r2 = await svc.search('篮球', opts);
        assert.ok(r2.some(m => m.id === 'm2'), '查询「篮球」应命中篮球记忆');
        assert.equal(r2[0].id, 'm2', 'n-gram 命中者应排在最前');
    },

    /** 三因子打分：importance 权重生效、向量相关性提升分数（Phase 2） */
    testThreeFactorScore(): void {
        const now = Math.floor(Date.now() / 1000);
        const mk = (importance: number): MemoryItem => {
            const m = new MemoryItem();
            m.createAt = now - 86400;
            m.lastAccessedAt = now;
            m.importance = importance;
            m.accessCount = 0;
            return m;
        };
        const hi = mk(1);
        const lo = mk(0.1);
        const sHi = hi.calculateScore([]);
        const sLo = lo.calculateScore([]);
        assert.ok(sHi > sLo, `重要性高者分数应更高 (${sHi} > ${sLo})`);
        assert.ok(Number.isFinite(sHi) && sHi >= 0 && sHi <= 1, '分数应在 0-1 区间');

        const m = new MemoryItem();
        m.vector = [1, 0];
        m.importance = 0.5;
        m.createAt = now;
        m.lastAccessedAt = now;
        assert.ok(m.calculateScore([1, 0]) > m.calculateScore([]), '查询向量相关时分数应更高');
    },

    /** stale 记忆治理：低重要性超期标记 stale；stale 再超期删除（Phase 3） */
    testMarkAndPruneStale(): void {
        const now = Math.floor(Date.now() / 1000);
        const day = 86400;
        const svc = new MemoryService();
        svc.memoryMap['old'] = mkMemory('old', '旧日常琐事', { importance: 0.1, createAt: now - 40 * day, lastAccessedAt: now - 40 * day });
        svc.memoryMap['imp'] = mkMemory('imp', '重要长期关系', { importance: 0.9, createAt: now - 100 * day, lastAccessedAt: now - 100 * day });
        svc.memoryMap['dead'] = mkMemory('dead', '已过期', { importance: 0.1, createAt: now - 100 * day, lastAccessedAt: now - 70 * day, stale: true });

        const r = svc.markAndPruneStale();
        assert.equal(r.marked, 1, '低重要性且超 30 天未访问应标记 stale');
        assert.deepEqual(r.deleted, ['dead'], 'stale 且超 60 天应删除');
        assert.equal(svc.memoryMap['old'].stale, true);
        assert.ok(svc.memoryMap['imp'], '高重要性记忆不应被标记');
        assert.ok(!svc.memoryMap['dead'], '过期记忆应被移除');
    },

    /** 总结条目合并：n-gram 相似度高者去重，保序（Phase 3） */
    testMergeSimilarSummaries(): void {
        const merged = MemoryService.mergeSimilarSummaries([
            '小明喜欢喝咖啡',
            '小明喜欢喝咖啡，也喜欢喝茶',
            '今天天气晴朗适合散步'
        ]);
        assert.ok(merged.length < 3, '相似总结应被合并');
        assert.ok(merged.includes('小明喜欢喝咖啡'), '保留先出现的条目');
        assert.ok(merged.includes('今天天气晴朗适合散步'), '不相似条目应保留');
    },

    /** stale 记忆不参与检索 */
    async testSearchStaleExcluded(): Promise<void> {
        resetMemoryTestConfig();
        const svc = new MemoryService();
        svc.memoryMap['m1'] = mkMemory('m1', '咖啡相关记忆', { stale: true });
        const r = await svc.search('咖啡', { topK: 5, tags: [], relatedMemories: [], users: [], groups: [], method: 'score' });
        assert.equal(r.length, 0, 'stale 记忆不应出现在检索结果');
    },

    /** 关联记忆一跳扩展：命中记忆的 relatedMemories 并入结果（Phase 3） */
    async testSearchRelatedExpansion(): Promise<void> {
        resetMemoryTestConfig();
        const svc = new MemoryService();
        svc.memoryMap['m1'] = mkMemory('m1', '北京旅游攻略', { relatedMemories: ['m2'] });
        svc.memoryMap['m2'] = mkMemory('m2', '故宫历史与门票');
        const r = await svc.search('北京', { topK: 5, tags: [], relatedMemories: [], users: [], groups: [], method: 'score' });
        const ids = r.map(m => m.id);
        assert.ok(ids.includes('m1'), '关键词命中记忆应返回');
        assert.ok(ids.includes('m2'), '关联记忆应一跳扩展进结果');
    },

    /** 核心事实常驻注入：重要性达阈值的事实进入 prompt，且不与检索段重复（Phase 2） */
    async testBuildMemoryPromptCoreFacts(): Promise<void> {
        resetMemoryTestConfig();
        const svc = new MemoryService();
        svc.memoryMap['f1'] = mkMemory('f1', '小明喜欢喝咖啡', { type: 'fact' as any, importance: 0.9 });
        svc.memoryMap['r1'] = mkMemory('r1', '小明提到想去日本旅游', { importance: 0.4 });
        const ctx = { isPrivate: true, endPoint: { userId: 'QQ:10000' }, group: null } as any;
        const p = await svc.buildMemoryPrompt(ctx, {} as any, '咖啡', [{ isPrivate: true, id: 'QQ:10000', name: '用户1' }], null);
        assert.ok(p.includes('核心事实'), 'prompt 应包含核心事实段');
        assert.ok(p.includes('小明喜欢喝咖啡'), '核心事实应注入');
        const first = p.indexOf('小明喜欢喝咖啡');
        assert.equal(p.indexOf('小明喜欢喝咖啡', first + 1), -1, '核心事实不应与检索段重复');
    },

    /** 上下文裁剪时总结游标同步回退，避免越界（B4 修复） */
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

    /** 旧存档「短期记忆」→「总结记忆」迁移：列表合并去重、开关合并（命名统一） */
    testMigrateShortToSummaryMemory(): void {
        const svc = new SessionMemoryService();
        svc.summaries = ['已有总结'];
        svc.shortMemoryList = ['旧短期记忆A', '旧短期记忆B', '旧短期记忆A'];
        svc.useShortMemory = true;
        svc.summaryStatus = false;
        svc.reviveMemoryMap();
        assert.deepEqual(svc.summaries, ['已有总结', '旧短期记忆A', '旧短期记忆B'], '旧短期记忆应并入总结记忆并去重');
        assert.equal(svc.shortMemoryList!.length, 0, '迁移后旧列表应清空');
        assert.equal(svc.summaryStatus, true, '旧开关应合并到 summaryStatus');
        assert.equal(svc.useShortMemory, false, '旧字段应复位');
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
        const old = new MemoryItem();
        old.id = 'legacy1';
        old.content = '小明喜欢喝咖啡';
        old.importance = 0.9;
        old.tags = ['咖啡'];
        old.users = ['QQ:1'];
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
