// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：quota-token 域，19 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Image, Model, SubCmd, TC,
    TokenCalibration, Tool, assert, buildContentParts,
    estimateMessageTokens, estimateTextTokens, formatMcpError, handleMessages,
    makeCtx, makeMemoScc, normalizeMCPResult, parseBalancePayload,
    registerCmdBalance, registerDispatchTools, registerImageTools, resetConfigCache,
    resolveBalanceEndpoint, seedPinnedConns, toolMap,
} from './unit-test-helpers';

export const tests: Record<string, () => void | Promise<void>> = {
testBalanceEndpointResolution(): void {
        const deep = resolveBalanceEndpoint({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', request: {} });
        assert.equal(deep.url, 'https://api.deepseek.com/user/balance', 'deepseek 默认 base 带 /v1 应去版本段');
        assert.equal(deep.headers.Authorization, 'Bearer k');
        const deep2 = resolveBalanceEndpoint({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k' });
        assert.equal(deep2.url, 'https://api.deepseek.com/user/balance', 'deepseek base 无 /v1 也应能推导');
        const moon = resolveBalanceEndpoint({ provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'k' });
        assert.equal(moon.url, 'https://api.moonshot.cn/v1/users/me/balance');
        const sil = resolveBalanceEndpoint({ provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'k' });
        assert.equal(sil.url, 'https://api.siliconflow.cn/v1/user/info');
        // provider 省略（纯 OpenAI 兼容）但 host 命中官方域名 → 兜底识别
        const hostDeep = resolveBalanceEndpoint({ provider: '', baseUrl: 'https://api.deepseek.com/custom/v1', apiKey: 'k' });
        assert.equal(hostDeep.url, 'https://api.deepseek.com/custom/user/balance', 'host 兜底应生效且只去尾部版本段');
        // 无内置端点且未配 balance_url → 不支持（null，不报错）
        assert.equal(resolveBalanceEndpoint({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }), null);
        assert.equal(resolveBalanceEndpoint({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k' }), null);
        assert.equal(resolveBalanceEndpoint({ provider: '', baseUrl: 'https://gw.example.com/v1', apiKey: 'k' }), null);
        // balance_url 覆盖 + 默认 Authorization: Bearer（与列表拉取同语义：one-api/new-api 兼容 Bearer 前缀）
        const ov = resolveBalanceEndpoint({
            provider: '', baseUrl: 'https://gw.example.com/v1', apiKey: 'sys-token',
            request: { balance_url: 'https://gw.example.com/api/user/self' }
        });
        assert.equal(ov.url, 'https://gw.example.com/api/user/self');
        assert.equal(ov.headers.Authorization, 'Bearer sys-token');
        // auth_header_name 给自定义头名 → 原样放 key、不拼 Bearer
        const ovRaw = resolveBalanceEndpoint({
            provider: '', baseUrl: 'https://gw.example.com/v1', apiKey: 'sys-token',
            request: { balance_url: 'https://gw.example.com/api/user/self', auth_header_name: 'X-Api-Key' }
        });
        assert.equal(ovRaw.headers['X-Api-Key'], 'sys-token', '自定义头名应原样放 key');
        assert.equal(ovRaw.headers.Authorization, undefined);
        // balance_url 覆盖优先生效（即使 provider 是原生三家）
        const ovNative = resolveBalanceEndpoint({
            provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k',
            request: { balance_url: 'https://relay.example.com/api/user/self' }
        });
        assert.equal(ovNative.url, 'https://relay.example.com/api/user/self');
    }
,

    /** DeepSeek 解析：多币种、字符串金额、充值/赠送拆分、is_available=false 告警、异常结构报错 */
    testBalanceParseDeepSeek(): void {
        const entries = parseBalancePayload('deepseek', {
            is_available: false,
            balance_infos: [
                { currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' },
                { currency: 'USD', total_balance: '0.50', granted_balance: '0', topped_up_balance: '0.50' }
            ]
        }, { baseUrl: 'https://api.deepseek.com/v1' });
        assert.equal(entries.length, 2, '多币种应各出一条');
        assert.equal(entries[0].currency, 'CNY');
        assert.equal(entries[0].available, 12.34);
        assert.equal(entries[0].availableFlag, false, 'is_available=false 应透传告警');
        assert.deepEqual(entries[0].parts, [{ label: '充值', amount: 10 }, { label: '赠送', amount: 2.34 }]);
        assert.equal(entries[1].currency, 'USD');
        assert.equal(entries[1].available, 0.5);
        assert.equal(entries[1].parts.length, 1, 'granted=0 的分项不应展示');
        assert.equal(entries[1].parts[0].label, '充值');
        assert.throws(() => parseBalancePayload('deepseek', { is_available: true }, { baseUrl: '' }), /balance_infos/, '缺 balance_infos 应报错');
    }
,

    /** Moonshot / SiliconFlow / 自定义网关键解析 */
    testBalanceParseMoonshot(): void {
        const cn = parseBalancePayload('moonshot', { code: 0, status: true, data: { available_balance: 3.0, cash_balance: 3.0, voucher_balance: 0 } }, { baseUrl: 'https://api.moonshot.cn/v1' });
        assert.equal(cn[0].currency, 'CNY');
        assert.equal(cn[0].available, 3);
        assert.deepEqual(cn[0].parts, [{ label: '现金', amount: 3 }], '券为 0 不应展示');
        const us = parseBalancePayload('moonshot', { status: true, data: { available_balance: -5, cash_balance: -5, voucher_balance: 1 } }, { baseUrl: 'https://api.moonshot.ai/v1' });
        assert.equal(us[0].currency, 'USD', '国际域名应为 USD');
        assert.equal(us[0].available, -5, '欠费为负');
        assert.deepEqual(us[0].parts, [{ label: '现金', amount: -5 }, { label: '券', amount: 1 }]);
        assert.throws(() => parseBalancePayload('moonshot', { status: false, message: 'invalid key' }, { baseUrl: '' }), /invalid key/, 'status:false 信封应带 message 报错');
    }
,

    testBalanceParseSiliconFlow(): void {
        // data.balance 为主；charge/total 与 available 相同则不重复展示
        const e1 = parseBalancePayload('siliconflow', { status: true, data: { name: 'u', balance: '10.50', chargeBalance: '10.50', totalBalance: '10.50' } }, { baseUrl: 'https://api.siliconflow.cn/v1' });
        assert.equal(e1[0].currency, 'CNY');
        assert.equal(e1[0].available, 10.5);
        assert.equal(e1[0].parts, undefined);
        // totalBalance 与 available 不同 → 展示「总额」
        const e2 = parseBalancePayload('siliconflow', { data: { balance: 8, chargeBalance: 8, totalBalance: 15 } }, { baseUrl: 'https://api.siliconflow.com/v1' });
        assert.equal(e2[0].currency, 'USD', '.com 应为 USD');
        assert.deepEqual(e2[0].parts, [{ label: '总额', amount: 15 }]);
        // 只回 totalBalance 也能兜底识别
        const e3 = parseBalancePayload('siliconflow', { data: { totalBalance: 42 } }, { baseUrl: 'https://api.siliconflow.cn/v1' });
        assert.equal(e3[0].available, 42);
        // 结构识别失败应报可读错误
        assert.throws(() => parseBalancePayload('siliconflow', { data: { name: 'u' } }, { baseUrl: '' }), /未识别 SiliconFlow/);
        // status:false 信封
        assert.throws(() => parseBalancePayload('siliconflow', { status: false, message: 'forbidden' }, { baseUrl: '' }), /forbidden/);
    }
,

    testBalanceParseCustom(): void {
        const req = { balance_url: 'https://gw/api/user/self', balance_json_path: 'data.quota', balance_divisor: 500000, balance_currency: 'CNY' };
        const e = parseBalancePayload('', { success: true, data: { quota: 12345678 } }, { request: req });
        assert.ok(Math.abs(e[0].available - 12345678 / 500000) < 1e-9, `quota 应按 divisor 折算，实际 ${e[0].available}`);
        assert.equal(e[0].currency, 'CNY');
        const e2 = parseBalancePayload('', { data: { quota: 100 } }, { request: { balance_url: 'x', balance_json_path: 'data.quota' } });
        assert.equal(e2[0].available, 100, '不配 divisor 默认原值');
        assert.throws(() => parseBalancePayload('', { data: {} }, { request: { balance_url: 'x', balance_json_path: 'data.quota' } }), /未取到数字/, '路径缺失应报错');
        assert.throws(() => parseBalancePayload('', { data: {} }, { request: { balance_url: 'x' } }), /balance_json_path/, '配 balance_url 缺路径应报错');
    }
,

    /** 端到端命令行为：成功/无接口/网关自定义/失败四类连接并行查询，回复文本正确 */
    async testBalanceCmdFullQuery(): Promise<void> {
        if (!SubCmd.map['balance']) registerCmdBalance();
        const conns = [
            { provider: 'deepseek', apiKey: 'k1', baseUrl: 'https://api.deepseek.com/v1', ignore: false, models: ['deepseek-chat'], request: {} },
            { provider: 'openai', apiKey: 'k2', baseUrl: 'https://api.openai.com/v1', ignore: false, models: ['gpt-4o'], request: {} },
            { provider: 'siliconflow', apiKey: 'bad', baseUrl: 'https://api.siliconflow.cn/v1', ignore: false, models: ['Qwen/Qwen2.5-7B'], request: {} },
            {
                provider: '', apiKey: 'sys-token', baseUrl: 'https://gw.example.com/v1', ignore: false, models: ['x'],
                request: { balance_url: 'https://gw.example.com/api/user/self', balance_json_path: 'data.quota', balance_divisor: 500000, balance_currency: 'CNY' }
            },
        ];
        seedPinnedConns(conns as any);

        const called: string[] = [];
        const fakeOk = (body: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, opts: any) => {
            const s = String(url);
            called.push(s);
            if (s.includes('/user/balance')) {
                return fakeOk({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }] });
            }
            if (s.includes('/api/user/self')) {
                return fakeOk({ success: true, data: { quota: 12345678 } });
            }
            if (s.includes('/user/info')) {
                return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Unauthorized' } }) };
            }
            throw new Error('不应请求其他地址:' + s);
        };
        try {
            const origReply = (globalThis as any).seal.replyToSender;
            let replied = '';
            (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { replied = text; };
            try {
                await SubCmd.map['balance'].solve(makeMemoScc());
            } finally {
                (globalThis as any).seal.replyToSender = origReply;
            }
            assert.ok(replied.includes('各连接余额（4 条）'), `头部应统计 4 条连接，实际:\n${replied}`);
            assert.ok(replied.includes('[0] deepseek'), '应包含 deepseek 连接行');
            assert.ok(replied.includes('可用 ¥12.5（充值 10 · 赠送 2.5）'), `deepseek 展示拆分:\n${replied}`);
            assert.ok(replied.includes('[1] openai') && replied.includes('platform.openai.com/usage'), 'openai 应提示控制台入口');
            assert.ok(replied.includes('[2] siliconflow') && replied.includes('查询失败：认证失败(401)'), `siliconflow 401 应降级为认证失败:\n${replied}`);
            assert.ok(replied.includes('[3]') && replied.includes('可用 ¥24.69'), `网关自定义应折算 quota:\n${replied}`);
            assert.ok(called.some(u => u.includes('/user/balance')) && called.some(u => u.includes('/api/user/self')) && called.some(u => u.includes('/user/info')), '应只请求内置三家的余额端点');
        } finally {
            (globalThis as any).fetch = origFetch;
            Model.reset();
        }
    }
,

    testEstimateTextTokens(): void {
        assert.equal(estimateTextTokens('abcd'), 1);
        assert.equal(estimateTextTokens('abcdefgh'), 2);
        assert.equal(estimateTextTokens('你好'), 2);
        assert.equal(estimateTextTokens('abc你好'), 3);
        assert.equal(estimateTextTokens(''), 0);
        // Emoji 不应被当作 1 个字符 1 token
        assert.ok(estimateTextTokens('😀') >= 2, `emoji 估算应至少 2 token，实际 ${estimateTextTokens('😀')}`);
    }
,

    /** 单条消息估算：覆盖文本/contentItems/多模态/工具调用/思维链/结构 overhead */
    testEstimateMessageTokens(): void {
        // 基础内容 2 token + 消息结构 overhead 4 token
        assert.equal(estimateMessageTokens({ role: 'user', content: '你好' } as any), 6);
        assert.equal(
            estimateMessageTokens({ role: 'user', contentItems: [{ text: '你好', time: 0 }] } as any),
            6
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
        // tool_calls JSON 与结构 overhead 计入估算
        const withTools = {
            role: 'assistant',
            content: '调用',
            tool_calls: [{ id: '1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }]
        };
        assert.ok(estimateMessageTokens(withTools as any) > estimateTextTokens('调用'));
        // reasoning_content 必须计入估算
        const withoutReasoning = { role: 'assistant', content: '结果' };
        const withReasoning = { role: 'assistant', content: '结果', reasoning_content: '因为A所以B' };
        assert.ok(
            estimateMessageTokens(withReasoning as any) > estimateMessageTokens(withoutReasoning as any),
            'reasoning_content 应使单条消息估算增加'
        );
    }
,

    /** MCP 错误格式化：401/403 必须提示鉴权失败，而不是容易误解的「服务器未初始化」 */
    testFormatMcpErrorAuth(): void {
        const auth = formatMcpError(401, { error: { code: -32001, message: 'unauthorized' } });
        assert.match(auth, /鉴权失败/);
        assert.match(auth, /401/);
        assert.match(auth, /unauthorized/);
        assert.match(auth, /Authorization/);
        assert.match(formatMcpError(403, {}), /鉴权失败/);
        assert.match(formatMcpError(500, { error: { code: -32603 } }), /服务器内部错误/);
    }
,

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
    }
,

    /** 多模态工具结果：contentParts 直接进入请求体，非多模态退化为文本 */
    async testToolMultimodalContentParts(): Promise<void> {
        TC.intConfigs['上下文预算'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        const system = { role: 'system', text: '系统' };
        const session = {
            context: {
                messages: [
                    { role: 'assistant', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'browser_take_screenshot', arguments: '{}' } }] },
                    { role: 'tool', text: '图[img:mcp_1]', contentParts: [
                        { type: 'text', text: '图' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                    ], toolCallId: 'call_1', toolName: 'browser_take_screenshot' }
                ]
            }
        };
        const out = await handleMessages(makeCtx(), session as any, true, undefined, system as any);
        const tool = out.find(m => m.role === 'tool');
        assert.ok(Array.isArray(tool.content), '多模态下工具结果应为 content 数组');
        assert.ok((tool.content as any[]).some((p: any) => p.type === 'image_url'));
        const outText = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
        const toolText = outText.find(m => m.role === 'tool');
        assert.equal(toolText.content, '[tool_result:call_1]\n图[img:mcp_1]\n[/tool_result]', '非多模态应退化为带边界标签的文本');
    }
,

    /** 提示词工程模式：工具结果里的 image contentParts 不能被丢弃（image_view / MCP 图片） */
    async testPEKeepsToolImageParts(): Promise<void> {
        TC.intConfigs['上下文预算'] = 0;
        TC.boolConfigs['切换为提示词工程'] = true;
        resetConfigCache();
        const system = { role: 'system', text: '系统' };
        const session = {
            context: {
                messages: [
                    { role: 'assistant', toolCalls: [{ id: 'call_pe', type: 'function', function: { name: 'image_view', arguments: '{}' } }] },
                    { role: 'tool', text: '图片[img:mcp_pe]', contentParts: [
                        { type: 'text', text: '图片[img:mcp_pe]' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                    ], toolCallId: 'call_pe', toolName: 'image_view' }
                ]
            }
        };
        try {
            const out = await handleMessages(makeCtx(), session as any, true, undefined, system as any);
            const msg = out.find(m => m.role === 'user' && Array.isArray(m.content));
            assert.ok(msg, 'PE 模式下工具结果应转成 user 多模态内容');
            assert.ok((msg!.content as any[]).some((p: any) => p.type === 'image_url'), 'PE 模式也必须保留 image_url');
        } finally {
            TC.boolConfigs['切换为提示词工程'] = false;
            resetConfigCache();
        }
    }
,

    /** image_view / image_to_text：批量上限、CIR 解析、无模型时降级/失败文案 */
    async testImageViewAndTextBatchLimits(): Promise<void> {
        // 工具可能已在别的用例注册；这里单独注册图片工具，避免依赖执行顺序
        registerImageTools();
        TC.stringConfigs['后端配置'] = JSON.stringify({ version: 1, backends: { 'image-host': { url: '' } } });
        resetConfigCache();
        const img = new Image();
        img.imageId = 'view_test_a';
        img.base64 = 'QUJD';
        img.format = 'png';
        Image.imageMap['view_test_a'] = img;
        try {
            const view = toolMap['image_view'];
            const itt = toolMap['image_to_text'];
            assert.ok(view && itt, 'image_view / image_to_text 应已注册');
            const over = await view.solve(makeCtx(), {} as any, {} as any, { ids: ['1', '2', '3', '4', '5'] });
            assert.ok(String(over).includes('最多 4'), 'image_view 超过 4 张应拒绝');
            const both = await view.solve(makeCtx(), {} as any, {} as any, { id: 'a', ids: ['b'] });
            assert.ok(String(both).includes('二选一'));
            const one = await view.solve(makeCtx(), {} as any, {} as any, { id: '[img:view_test_a]' });
            const oneText = typeof one === 'string' ? one : (one as any).text;
            assert.ok(String(oneText).includes('view_test_a'), '应解析 CIR 并返回摘要');
            // 多模态 chat 模型：应返回 image contentParts（base64 图片直接内联）
            const origGetChat = (Model as any).getChatModel;
            try {
                (Model as any).getChatModel = () => ({ isMultimodal: true, baseUrl: '', name: 'fake-vl' });
                const multi = await view.solve(makeCtx(), {} as any, {} as any, { id: '[img:view_test_a]' });
                assert.equal(typeof multi, 'object');
                const parts = (multi as any).contentParts || [];
                assert.ok(parts.some((p: any) => p.type === 'image_url'), '多模态模型应拿到 image_url');
            } finally {
                (Model as any).getChatModel = origGetChat;
            }
            const overItt = await itt.solve(makeCtx(), {} as any, {} as any, { ids: ['1', '2', '3', '4'] });
            assert.ok(String(overItt).includes('最多 3'), 'image_to_text 超过 3 张应拒绝');
            const missing = await itt.solve(makeCtx(), {} as any, {} as any, { id: '[img:h' + 'a'.repeat(64) + ']' });
            assert.ok(String(missing).includes('未找到'), '未配置图床时 hosted 引用应明确未找到');
        } finally {
            delete Image.imageMap['view_test_a'];
            delete TC.stringConfigs['后端配置'];
            resetConfigCache();
        }
    }
,

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
    }
,



    /** 预算裁剪：整条丢弃最早的未保护消息，system 永不丢弃 */
    async testTokenBudgetDropsEarliest(): Promise<void> {
        TC.intConfigs['上下文预算'] = 220;
        TC.intConfigs['插入system message间隔轮数'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        const system = { role: 'system', text: '系'.repeat(100) }; // 100 汉字内容 token + 4 结构 overhead
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
    }
,

    /** 预算裁剪：单条超大消息不再整条丢弃清空上下文，而是按缺口截断并保留尾部 */
    async testTokenBudgetTruncatesHugeMessage(): Promise<void> {
        TC.intConfigs['上下文预算'] = 208;
        TC.intConfigs['插入system message间隔轮数'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        const system = { role: 'system', text: '系'.repeat(100) }; // 100 汉字内容 token + 4 结构 overhead
        const huge = '超'.repeat(300); // 300 汉字内容 token + 4 结构 overhead，单条超出整个可用预算
        const session = { context: { messages: [{ role: 'user', text: huge }] } };
        const out = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
        assert.equal(out.length, 2, '超大消息应被截断而不是整条丢弃');
        assert.ok(out[1].content.length < 300, '超大消息应被截断');
        assert.equal(out[1].content, huge.slice(-100), '应保留最近 100 字符');
        // 总估算不超过预算
        const total = estimateMessageTokens(out[0] as any) + estimateMessageTokens(out[1] as any);
        assert.ok(total <= 208, `裁剪后应不超预算，实际 ${total}`);
    }
,
    /** TokenCalibration：默认系数 1、记录样本后 EMA 更新预测 */
    testTokenCalibrationEma(): void {
        TokenCalibration.resetAllForTest();
        try {
            assert.equal(TokenCalibration.getFactor('cal-model'), 1);
            assert.equal(TokenCalibration.predict('cal-model', 100), 100);

            TokenCalibration.record('cal-model', 100, 150);
            assert.equal(TokenCalibration.getFactor('cal-model'), 1.5);
            assert.equal(TokenCalibration.predict('cal-model', 100), 150);

            // 第二次 ratio = 1，alpha = 1/2：1.5 + 0.5 * (1 - 1.5) = 1.25
            TokenCalibration.record('cal-model', 100, 100);
            assert.equal(TokenCalibration.getFactor('cal-model'), 1.25);

            // 无效样本不更新
            TokenCalibration.record('cal-model', 0, 100);
            TokenCalibration.record('cal-model', 100, 0);
            assert.equal(TokenCalibration.getFactor('cal-model'), 1.25);
        } finally {
            // 必须用 resetAllForTest：record() 会落盘，只清内存会把样本留给后面的用例
            TokenCalibration.resetAllForTest();
        }
    }
,

    /** 预算裁剪应使用模型校准系数：factor > 1 时比默认更早裁剪 */
    async testTokenBudgetUsesCalibrationFactor(): Promise<void> {
        TC.intConfigs['上下文预算'] = 300;
        TC.intConfigs['插入system message间隔轮数'] = 0;
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfigCache();
        TokenCalibration.resetAllForTest();
        try {
            TokenCalibration.record('cal-model', 100, 200); // factor = 2
            const system = { role: 'system', text: '系'.repeat(100) }; // 104 token
            const session = { context: { messages: [{ role: 'user', text: '一'.repeat(50) }] } }; // 54 token

            const normal = await handleMessages(makeCtx(), session as any, false, undefined, system as any);
            assert.equal(normal.length, 2, '未校准时 158 token 应留在 300 预算内');

            const calibrated = await handleMessages(makeCtx(), session as any, false, undefined, system as any, 'cal-model');
            assert.equal(calibrated.length, 2, 'factor=2 时不应直接清空历史，而应触发更早的预算裁剪');
            assert.ok((calibrated[1].content as string).length < 50, 'factor=2 时历史消息应被截断以降低预测 token');
        } finally {
            TokenCalibration.resetAllForTest();
            delete TC.intConfigs['上下文预算'];
            delete TC.intConfigs['插入system message间隔轮数'];
            delete TC.boolConfigs['切换为提示词工程'];
            resetConfigCache();
        }
    }
,

    /** prompt 工程模式：工具结果转 user 时保留工具名来源 */
    async testPromptEngineeringToolName(): Promise<void> {
        TC.intConfigs['上下文预算'] = 0; // 不限
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
        assert.ok((toolMsg.content as string).startsWith('[tool_result:get_weather]'), '应带工具名');

        // 旧上下文无 toolName 时退化为通用标记
        const session2 = { context: { messages: [{ role: 'tool', text: '结果', toolCallId: 'call_2' }] } };
        const out2 = await handleMessages(makeCtx(), session2 as any, false, undefined, system as any);
        const toolMsg2 = out2.find(m => typeof m.content === 'string' && m.content.includes('结果'));
        assert.ok((toolMsg2.content as string).startsWith('[tool_result]'));
        assert.ok(!(toolMsg2.content as string).startsWith('[tool_result:'));
    }
};
