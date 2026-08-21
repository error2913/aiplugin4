// 提示词/上下文构建单元测试入口（由 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ）
// @ts-nocheck
import assert from "node:assert/strict";

import Config from "../src/config/config";
Config.registerConfig();

import { estimateTextTokens, estimateMessageTokens, handleMessages } from "../src/utils/message";
import { SUMMARY_PROMPT_TEMPLATE } from "../src/prompt/templates";
import { resolveSendMessage } from "../src/transport/ob11/message_segments";
import MemoryService from "../src/memory/memory";
import MemoryItem from "../src/memory/memory_item";
import Image from "../src/resource/image";

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

    /** 总结记忆模板：示例 JSON 必须可被 JSON.parse 解析，且不含单引号键 */
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
        assert.ok(parsed.content && parsed.content.type === 'string');
        assert.ok(parsed.memories && parsed.memories.items.properties.related_user_ids.type === 'array');
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
    }
};
