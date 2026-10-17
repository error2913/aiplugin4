// v5 模型配置的单元测试（纯逻辑，不依赖 seal）。
//
// 覆盖 docs/13-模型配置v5方案.md 第 3（校验/报错）、4（协议）、6.3（用途分层）节。
// 运行：npm run test:unit
//
// 注意：v5 **不做 v4 兼容/迁移**（方案 §1.1：海豹没有配置写入权限，
// "读旧→转换→写新"的第三步永远做不到），因此本文件没有迁移相关用例。
import assert from 'node:assert/strict';

import { PROVIDER_MAP } from '../src/config/static_config/providers';
import { adaptV5 } from '../src/config/v5/adapt';
import {
    API_DIALECTS, isEligibleKind, MODEL_KINDS, parseV5Config, validateV5Config, V5Config,
} from '../src/config/v5/schema';
import { hostOf, knownHosts, resolveVendor } from '../src/config/v5/vendor';
import { isAnthropicMessages, isOpenAiResponses, resolveApiDialect } from '../src/model/api_dialect';
import { classifyModel } from '../src/model/catalog';
import { composeMediaTemplate } from '../src/model/media_template';
import {
    bodyDefaultsFor, resetRuleRowsForTest, ruleBodyModeFor, setRuleRows,
} from '../src/model/request_rules';

/** 构造一条合法连接（可覆盖顶层字段） */
function goodConfig(over: Partial<V5Config> = {}): V5Config {
    return {
        version: 5,
        providers: [{
            api: 'openai-completions',
            baseURL: 'https://api.deepseek.com/v1',
            apiKey: 'sk-test',
            models: [{ id: 'flash', name: 'deepseek-v4-flash', kind: 'text' }],
        }],
        ...over,
    } as V5Config;
}

const issuePaths = (cfg: unknown) => validateV5Config(cfg).map(i => i.path);

export const tests: Record<string, () => void | Promise<void>> = {

    // ---------------------------------------------------------------- 解析与校验

    /** 合法配置：最小 / 完整 / 密集格式都能解析 */
    testV5ParseValid(): void {
        const minimal = goodConfig();
        assert.equal(validateV5Config(minimal).length, 0, '最小配置应合法');

        const full: V5Config = {
            version: 5,
            providers: [{
                api: 'anthropic-messages',
                baseURL: 'https://api.anthropic.com/v1',
                apiKey: 'sk-ant',
                enabled: true,
                displayName: 'Claude',
                timeout: 30,
                request: { list_url: 'https://api.anthropic.com/v1/models' },
                models: [{
                    id: 'sonnet', name: 'claude-sonnet-4-5', kind: 'vision',
                    contextWindow: 200000, maxTokens: 8192,
                }],
            }],
            purposes: { chat: 'sonnet' },
            groups: [{ purposes: ['chat'], body: { max_tokens: 4096 } }],
        };
        assert.equal(validateV5Config(full).length, 0, '完整配置应合法');

        // 密集格式（生成器的产出形态）
        const dense = JSON.stringify(minimal);
        const r = parseV5Config(dense);
        assert.ok(r.config, '密集 JSON 应解析成功');
        assert.equal(r.issues.length, 0);
        assert.equal(r.config!.providers.length, 1);
    },

    /** 空 / 非 JSON / 非法 JSON 都要给出可读错误而不是抛异常 */
    testV5ParseMalformed(): void {
        assert.equal(parseV5Config('').config, null);
        assert.ok(parseV5Config('').issues[0].msg.includes('空'));

        const notObj = parseV5Config('[1,2,3]');
        assert.equal(notObj.config, null);
        assert.ok(notObj.issues.some(i => i.msg.includes('对象')));

        const bad = parseV5Config('{ "version": 5, ');
        assert.equal(bad.config, null);
        assert.ok(bad.issues[0].msg.includes('JSON 语法错误'), bad.issues[0].msg);
    },

    /** 版本不符要拒绝（不做迁移，直接拒绝） */
    testV5VersionGate(): void {
        assert.ok(issuePaths({ ...goodConfig(), version: 4 }).includes('$.version'));
        assert.ok(issuePaths({ ...goodConfig(), version: undefined }).includes('$.version'));
    },

    /** 每一条校验规则都有一例（方案 3.2） */
    testV5ValidationRules(): void {
        const P = (p: any) => ({ ...goodConfig(), providers: [p] });
        const M = (o: any) => P({ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [o] });

        // providers 为空
        assert.ok(issuePaths({ ...goodConfig(), providers: [] }).includes('$.providers'));

        // api 非法
        assert.ok(issuePaths(P({ api: 'grpc', baseURL: 'https://a.com/v1', apiKey: 'k' })).includes('$.providers[0].api'));

        // baseURL 缺失 / 缺协议头
        assert.ok(issuePaths(P({ api: 'openai-completions', apiKey: 'k' })).includes('$.providers[0].baseURL'));
        assert.ok(issuePaths(P({ api: 'openai-completions', baseURL: 'a.com/v1', apiKey: 'k' }))
            .includes('$.providers[0].baseURL'));

        // apiKey 缺失 / 含不可打印字符
        assert.ok(issuePaths(P({ api: 'openai-completions', baseURL: 'https://a.com/v1' }))
            .includes('$.providers[0].apiKey'));
        assert.ok(issuePaths(P({ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'sk-a\nb' }))
            .includes('$.providers[0].apiKey'));

        // enabled 类型
        assert.ok(issuePaths(P({ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', enabled: 'yes' }))
            .includes('$.providers[0].enabled'));

        // provider 显式给了空串 → 合法（留空即自动识别）
        assert.equal(validateV5Config(P({
            api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', provider: '',
        })).length, 0);

        // 模型 id 缺失 / name 缺失 / kind 非法 / bodyMode 非法
        assert.ok(issuePaths(M({ name: 'x' })).includes('$.providers[0].models[0].id'));
        assert.ok(issuePaths(M({ id: 'm1' })).includes('$.providers[0].models[0].name'));
        assert.ok(issuePaths(M({ id: 'm1', name: 'x', kind: 'audio' })).includes('$.providers[0].models[0].kind'));
        assert.ok(issuePaths(M({ id: 'm1', name: 'x', bodyMode: 'append' })).includes('$.providers[0].models[0].bodyMode'));

        // 模型 id 必须全局唯一
        const dup = {
            ...goodConfig(),
            providers: [
                { api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ id: 'same', name: 'x' }] },
                { api: 'openai-completions', baseURL: 'https://b.com/v1', apiKey: 'k', models: [{ id: 'same', name: 'y' }] },
            ],
        };
        assert.ok(issuePaths(dup).includes('$.providers[1].models[0].id'), '模型 id 需全局唯一');

        // models 类型
        assert.ok(issuePaths(P({ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: 'x' }))
            .includes('$.providers[0].models'));
    },

    /** purposes：未知用途 / 悬空引用 / 类型不匹配 */
    testV5PurposesValidation(): void {
        const cfg = (purposes: any) => ({ ...goodConfig(), purposes });

        assert.ok(issuePaths(cfg({ nonsense: 'flash' })).includes('$.purposes.nonsense'));
        assert.ok(issuePaths(cfg({ chat: 'ghost' })).includes('$.purposes.chat'));
        // 类型不匹配：text 模型不能做 image-generation
        assert.ok(issuePaths(cfg({ 'image-generation': 'flash' })).includes('$.purposes.image-generation'));

        // 正确类型可以通过
        const genCfg: V5Config = {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'k',
                models: [{ id: 'flux', name: 'black-forest-labs/FLUX.1-schnell', kind: 'gen' }],
            }],
            purposes: { 'image-generation': 'flux' },
        };
        assert.equal(validateV5Config(genCfg).length, 0);
    },

    /** groups：purposes 必须非空且用途合法 */
    testV5GroupsValidation(): void {
        assert.ok(issuePaths({ ...goodConfig(), groups: [{ purposes: [] }] }).includes('$.groups[0].purposes'));
        assert.ok(issuePaths({ ...goodConfig(), groups: [{ purposes: ['bogus'] }] }).includes('$.groups[0].purposes[0]'));
        assert.equal(validateV5Config({
            ...goodConfig(), groups: [{ purposes: ['chat'], body: { max_tokens: 1 } }],
        }).length, 0);
    },

    /** 报错必须带 $.a.b[0].c 形式的路径，且一次报全部 */
    testV5ErrorPaths(): void {
        const cfg = {
            version: 5,
            providers: [
                { api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ id: 'm1', name: 'x' }] },
                { api: 'grpc', baseURL: '', apiKey: '', models: [{ id: 'm1', name: '' }] },
            ],
            purposes: { chat: 'ghost' },
        };
        const issues = validateV5Config(cfg);
        const paths = issues.map(i => i.path);
        assert.ok(paths.includes('$.providers[1].api'), JSON.stringify(paths));
        assert.ok(paths.includes('$.providers[1].baseURL'));
        assert.ok(paths.includes('$.providers[1].apiKey'));
        assert.ok(paths.includes('$.providers[1].models[0].id'));
        assert.ok(paths.includes('$.purposes.chat'));
        assert.ok(issues.length >= 5, `应一次报出全部问题，实际 ${issues.length}`);
    },

    /** 用途 × 类型：必须与 model.ts 的 isEligible 一致 */
    testIsEligibleKind(): void {
        assert.ok(isEligibleKind('text-embedding', 'embed'));
        assert.ok(!isEligibleKind('text-embedding', 'text'));
        assert.ok(isEligibleKind('image-understanding', 'vision'));
        assert.ok(isEligibleKind('image-generation', 'gen'));
        assert.ok(isEligibleKind('tts', 'tts'));
        for (const u of ['chat', 'compression', 'summarization', 'judge'] as const) {
            assert.ok(isEligibleKind(u, 'text'), `${u} 应接受 text`);
            assert.ok(isEligibleKind(u, 'vision'), `${u} 应接受 vision`);
            for (const k of ['embed', 'gen', 'tts'] as const) {
                assert.ok(!isEligibleKind(u, k), `${u} 应排除 ${k}`);
            }
        }
        // 缺省 kind 视为 text
        assert.ok(isEligibleKind('chat', undefined));
        assert.ok(!isEligibleKind('text-embedding', undefined));
    },

    // ---------------------------------------------------------------- vendor 识别

    /** 每个内置供应商的默认地址都必须能反查回自己的 vendor（防止表与识别漂移） */
    testVendorReverseLookup(): void {
        for (const vendor of Object.keys(PROVIDER_MAP)) {
            assert.equal(resolveVendor(PROVIDER_MAP[vendor]), vendor, `${PROVIDER_MAP[vendor]} 应识别为 ${vendor}`);
        }
        // 显式声明优先
        assert.equal(resolveVendor('https://gw.example.com/v1', 'deepseek'), 'deepseek');
        // 未收录 → 空串（按 OpenAI 兼容处理）
        assert.equal(resolveVendor('https://gw.example.com/v1'), '');
        assert.equal(resolveVendor(''), '');
        assert.equal(resolveVendor('not-a-url'), '');
        // 带端口 / 带 userinfo 仍能识别
        assert.equal(resolveVendor('https://api.deepseek.com:8443/v1'), 'deepseek');
        assert.equal(resolveVendor('https://user:pass@api.deepseek.com/v1'), 'deepseek');
        // hostOf
        assert.equal(hostOf('https://API.DeepSeek.com/v1'), 'api.deepseek.com');
        assert.equal(hostOf('http://127.0.0.1:8080/v1'), '127.0.0.1');
        assert.ok(Object.keys(knownHosts()).length > 0);
    },

    // ---------------------------------------------------------------- 协议分派

    /** api 字段优先；缺省时按 provider 名兜底（兼容既有无 api 字段的调用点） */
    testApiDialect(): void {
        assert.equal(resolveApiDialect('anthropic-messages', 'anything'), 'anthropic-messages');
        assert.equal(resolveApiDialect('openai-completions', 'anthropic'), 'openai-completions', '显式 api 应压过 provider 名');
        assert.equal(resolveApiDialect('openai-responses'), 'openai-responses');
        // 缺省兜底
        assert.equal(resolveApiDialect(undefined, 'anthropic'), 'anthropic-messages');
        assert.equal(resolveApiDialect('', 'anthropic'), 'anthropic-messages');
        assert.equal(resolveApiDialect(undefined, 'deepseek'), 'openai-completions');
        // 非法值 → 兜底
        assert.equal(resolveApiDialect('grpc', 'deepseek'), 'openai-completions');
        // 谓词
        assert.ok(isAnthropicMessages(undefined, 'anthropic'));
        assert.ok(!isAnthropicMessages('openai-completions', 'anthropic'));
        assert.ok(isOpenAiResponses('openai-responses'));
        assert.equal(API_DIALECTS.length, 3);
    },

    // ---------------------------------------------------------------- classifyModel 瘦身

    /** 终值类型仍能识别；视觉不再猜（v5 起改为显式声明） */
    testClassifySlimmed(): void {
        // 保留：嵌入 / 生图 / 语音 / rerank
        assert.deepEqual(classifyModel('', 'text-embedding-v4'), ['embed']);
        assert.deepEqual(classifyModel('', 'bge-m3'), ['embed']);
        assert.deepEqual(classifyModel('', 'gpt-image-1'), ['gen']);
        assert.deepEqual(classifyModel('', 'some-reranker'), ['gen']);
        assert.deepEqual(classifyModel('', 'cosyvoice-v1'), ['tts']);
        assert.deepEqual(classifyModel('', 'gpt-4o-mini-tts'), ['tts'], '语音必须在视觉之前判定');
        // 生图用词边界：厂商前缀名要能识别（原先锚定开头会漏）
        assert.deepEqual(classifyModel('', 'black-forest-labs/FLUX.1-schnell'), ['gen']);
        assert.deepEqual(classifyModel('', 'google/imagen-4'), ['gen']);
        // 不误伤
        assert.deepEqual(classifyModel('', 'influx-db-model'), ['text']);
        assert.deepEqual(classifyModel('', 'video-generation-helper'), ['text']);
        // 视觉不再靠命名猜测（v5 变更点）
        assert.deepEqual(classifyModel('', 'gpt-4o'), ['text']);
        assert.deepEqual(classifyModel('', 'glm-4v'), ['text']);
        assert.deepEqual(classifyModel('', 'qwen-vl-max'), ['text']);
        // 手动声明与接口能力位仍然优先
        assert.deepEqual(classifyModel('', 'glm-4v', { manual: 'vision' }), ['vision']);
        assert.deepEqual(classifyModel('', 'mystery', { vision: true }), ['vision']);
        assert.deepEqual(classifyModel('', 'mystery', { embed: true }), ['embed']);
        assert.deepEqual(classifyModel('', 'gpt-4o', { manual: 'text' }), ['text']);
        assert.equal(MODEL_KINDS.length, 5);
    },

    // ---------------------------------------------------------------- 适配

    /** adaptV5：模型名→id/kind 映射、vendor 反查、空模型清单 → null（触发自动拉取） */
    testAdaptV5(): void {
        const cfg: V5Config = {
            version: 5,
            providers: [
                {
                    api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', apiKey: 'k',
                    models: [{ id: 'sonnet', name: 'claude-sonnet-4-5', kind: 'vision' }],
                },
                { api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'k' },
                { api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [], enabled: false },
            ],
            groups: [{ purposes: ['chat'], body: { max_tokens: 1 } }],
        };
        const { conns, rules } = adaptV5(cfg);

        assert.equal(conns.length, 3);
        // vendor 由 URL 反查
        assert.equal(conns[0].provider, 'anthropic');
        assert.equal(conns[1].provider, 'siliconflow');
        assert.equal(conns[2].provider, '');
        // api 透传
        assert.equal(conns[0].api, 'anthropic-messages');
        // 模型清单：有则钉住，空则 null（自动拉取）
        assert.deepEqual(conns[0].models, ['claude-sonnet-4-5']);
        assert.equal(conns[1].models, null, '空 models 应为 null = 自动拉取');
        assert.equal(conns[2].models, null);
        // name → id / kind
        assert.equal(conns[0].modelIds!['claude-sonnet-4-5'], 'sonnet');
        assert.equal(conns[0].modelTypes!['claude-sonnet-4-5'], 'vision');
        // enabled:false → ignore
        assert.equal(conns[2].ignore, true);
        assert.equal(conns[0].ignore, false);
        // 用途组 → 规则
        assert.equal(rules.length, 1);
        assert.deepEqual(rules[0].use, ['chat']);
        assert.deepEqual(rules[0].body, { max_tokens: 1 });
    },

    /** per-model request → models 定向规则；bodyMode 透传 */
    testAdaptPerModelRequest(): void {
        const cfg: V5Config = {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'k',
                models: [{
                    id: 'flux', name: 'black-forest-labs/FLUX.1-schnell', kind: 'gen',
                    bodyMode: 'replace',
                    request: { body: { model: '{model}', prompt: '{prompt}' }, response: { data_path: 'images.0.url' } },
                }],
            }],
        };
        const { rules } = adaptV5(cfg);
        assert.equal(rules.length, 1);
        assert.deepEqual(rules[0].models, ['flux']);
        assert.equal(rules[0].bodyMode, 'replace');
        assert.ok(rules[0].body!.prompt === '{prompt}');
        assert.equal(rules[0].response!.data_path, 'images.0.url');
    },

    /** 无 request 的模型不产出规则（避免空规则命中） */
    testAdaptSkipsEmptyModelRequest(): void {
        const cfg: V5Config = {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'k',
                models: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y', request: {} }],
            }],
        };
        assert.equal(adaptV5(cfg).rules.length, 0);
    },

    // ---------------------------------------------------------------- bodyMode

    /** merge 与预设逐键合并；不写 / replace 维持"整体替换"既有语义 */
    testBodyMode(): void {
        // 无规则 → 用预设
        resetRuleRowsForTest();
        const preset = composeMediaTemplate('tts', 'openai', 'tts-1', 'r1').body as Record<string, unknown>;
        assert.ok('input' in preset && 'voice' in preset);

        // replace（显式）→ 只剩规则里的字段
        resetRuleRowsForTest();
        setRuleRows([{
            use: ['tts'], models: ['r1'], body: { text: '{text}' }, bodyMode: 'replace',
            params: {}, prompt: {}, request: {}, response: {},
        }]);
        const replaced = composeMediaTemplate('tts', 'openai', 'tts-1', 'r1').body as Record<string, unknown>;
        assert.deepEqual(Object.keys(replaced), ['text'], 'replace 应整体替换预设');

        // merge（显式）→ 预设 + 规则
        resetRuleRowsForTest();
        setRuleRows([{
            use: ['tts'], models: ['r1'], body: { speed: 1.5 }, bodyMode: 'merge',
            params: {}, prompt: {}, request: {}, response: {},
        }]);
        const merged = composeMediaTemplate('tts', 'openai', 'tts-1', 'r1').body as Record<string, unknown>;
        assert.equal(merged.speed, 1.5, '规则字段应生效');
        assert.ok('input' in merged && 'voice' in merged, 'merge 应保留预设字段');

        // 不写 bodyMode → 维持"有规则 body 即整体替换"
        resetRuleRowsForTest();
        setRuleRows([{
            use: ['tts'], models: ['r1'], body: { text: '{text}' },
            params: {}, prompt: {}, request: {}, response: {},
        }]);
        const implicit = composeMediaTemplate('tts', 'openai', 'tts-1', 'r1').body as Record<string, unknown>;
        assert.deepEqual(Object.keys(implicit), ['text'], '未声明 bodyMode 时应保持整体替换');
        assert.equal(ruleBodyModeFor('tts', 'r1'), undefined);
        resetRuleRowsForTest();
    },

    /** 深合并必须判两侧都是普通对象（防止字符串 "{text}" 被展开成 {0:'{',1:'t'…}） */
    testDeepMergeDoesNotExplodeStrings(): void {
        resetRuleRowsForTest();
        setRuleRows([
            { use: ['tts'], body: { input: '{text}' }, params: {}, prompt: {}, request: {}, response: {} },
            { use: ['tts'], body: { input: { nested: 1 } }, bodyMode: 'merge', params: {}, prompt: {}, request: {}, response: {} },
        ]);
        // 后一行把 input 从字符串换成对象：不应把字符串拆成字符表，也不应把对象合并进字符串
        const body = bodyDefaultsFor('tts') as Record<string, unknown>;
        assert.deepEqual(body.input, { nested: 1 });
        resetRuleRowsForTest();
    },

    /**
     * 用途解析是**先按类型精确筛，再取候选第一个** —— 不是"顺序取第一个能用的"。
     *
     * 这条容易误解（生成器里曾把它写成「自动」），故用反例钉死：
     * 把**类型不符**的模型排在前面，它不得被选中。
     * 与 model.ts 的 isEligible / listModelsForUse / resolveForUse 对应。
     *
     * 分层验证：
     *   A. 适配层 → 候选（本文件可独立验证）
     *   B. 真正跑 Model（在 unit-test-entry.ts 的 testPurposeExactTypeSelection，需要 seal 桩）
     */
    testPurposeResolvesByExactTypeNotByOrder(): void {
        const cfg: V5Config = {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'k',
                models: [
                    // 故意把"错类型"的排在前面
                    { id: 'chat-a', name: 'deepseek-chat', kind: 'text' },
                    { id: 'embed-a', name: 'text-embedding-v4', kind: 'embed' },
                    { id: 'gen-a', name: 'black-forest-labs/FLUX.1-schnell', kind: 'gen' },
                ],
            }],
        };
        const { conns } = adaptV5(cfg);
        const names = conns[0].models!;              // 钉住清单：模型名数组
        const types = conns[0].modelTypes!;          // 模型名 → kind

        // 候选筛选（复刻 model.ts 的 isEligible：先按类型筛，再取第一个）
        const candidatesFor = (use: string) => names.filter(n => isEligibleKind(use as any, types[n]));
        const firstFor = (use: string) => candidatesFor(use)[0] ?? null;

        // 精确性：每个用途只拿到自己类型的模型，且不受排列顺序影响
        assert.equal(firstFor('text-embedding'), 'text-embedding-v4', '嵌入用途应精确命中 embed 模型');
        assert.equal(firstFor('image-generation'), 'black-forest-labs/FLUX.1-schnell', '生图用途应精确命中 gen 模型');
        assert.equal(firstFor('chat'), 'deepseek-chat', '对话用途应命中 text 模型（跳过 embed/gen）');
        assert.equal(firstFor('tts'), null, '没有 tts 模型时应为 null，而不是退而求其次');

        // 反例：把错类型的排在前面，仍不得被选中
        assert.notEqual(firstFor('image-generation'), 'deepseek-chat', '不得因顺序把 text 模型当生图模型');
        assert.notEqual(firstFor('chat'), 'text-embedding-v4', '不得因顺序把嵌入模型当对话模型');

        // 从 configPurposes 角度：绑定了就不看顺序；未绑定才落到候选第一个
        const bound: V5Config = { ...cfg, purposes: { chat: 'gen-a' } };
        const issues = validateV5Config(bound);
        assert.ok(issues.some(i => i.path === '$.purposes.chat'),
            '把 gen 模型绑到 chat 用途应被校验拒绝（类型不匹配）');
    },
};