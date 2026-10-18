// 联测：配置生成器（aiplugin4-config）的**真实产出**喂给插件的 v5 解析/校验/适配层。
//
// 为什么需要：生成器与插件是两套独立实现（一个静态页面、一个插件沙箱），
// 但必须对"什么是合法配置"达成一致 —— 否则用户按生成器配好却装不进插件。
// 本脚本建立两条不变式：
//   A. 生成器产出的每一份配置，插件都必须接受，且适配出的运行时结构符合预期；
//   B. 对同一份配置，两边对"合法/非法"的判定必须一致（否则报错信息会互相打脸）。
//
// 运行：npm run test:integration
// 生成器仓库默认取同级目录 ../aiplugin4-config，可用 AIPLUGIN4_CONFIG_REPO 覆盖。
// 找不到生成器仓库时**跳过**（不失败），保证 CI 在没有该仓库时仍能跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const genRoot = process.env.AIPLUGIN4_CONFIG_REPO
    || path.resolve(repoRoot, '..', 'aiplugin4-config');

const genV5 = path.join(genRoot, 'js', 'v5.js');
const genTpl = path.join(genRoot, 'js', 'templates.js');
const genDomains = path.join(genRoot, 'js', 'domains', 'index.js');

if (!fs.existsSync(genV5)) {
    console.log(`SKIP 未找到配置生成器仓库（${genRoot}）。`);
    console.log('     如需联测，把 aiplugin4-config 放到同级目录，或设置 AIPLUGIN4_CONFIG_REPO。');
    process.exit(0);
}

// 插件侧是 TS：用 esbuild 打成 ESM 后动态 import。
// 只打包 v5 目录下的**纯逻辑**模块（schema/adapt/vendor/default）——它们不依赖 seal，
// 因此不需要 stub 整个 SealDice 环境。
const esbuild = await import('esbuild');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-itg-'));
const entryFile = path.join(tmpDir, 'plugin-v5-entry.ts');
const outFile = path.join(tmpDir, 'plugin-v5.mjs');
fs.writeFileSync(entryFile, [
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/v5/schema.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/v5/adapt.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/v5/vendor.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/v5/default.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/static_config/providers.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/model/media_template.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/static_config/media_presets.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/model/request_rules.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/model/catalog.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/domain/parse.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/domain/defaults.ts'))};`,
    `export * from ${JSON.stringify(path.join(repoRoot, 'src/config/domain/types.ts'))};`,
].join('\n'));
await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: outFile,
    logLevel: 'silent',
});

const plugin = await import(pathToFileURL(outFile).href);
const {
    adaptV5, parseV5Config, validateV5Config, resolveVendor, DEFAULT_V5_CONFIG, PROVIDER_MAP,
    purposeBindings, normalizePurposeList,
    vendorByUrlSuffix, knownVendorSuffixes,
    composeMediaTemplate, resolveMediaUrl, renderMediaBody, MEDIA_PRESETS, resolveMediaPreset, classifyModel,
    setRuleRows, resetRuleRowsForTest,
    templateParamKeys, normalizeMediaParams,
    parseRolesConfig, parseSkillsConfig, parseMcpConfig, parseKbConfig,
    DEFAULT_ROLES, DEFAULT_SKILLS, DEFAULT_MCP, DEFAULT_KB,
} = plugin;

const gen = await import(pathToFileURL(genV5).href);
const tpl = await import(pathToFileURL(genTpl).href);
const genDomain = await import(pathToFileURL(genDomains).href);

process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
};

/** 生成器 UI 状态 → 真实产出 → 插件解析；返回插件侧结果 */
function roundTrip(providers, purposes) {
    const built = gen.build(providers, purposes);
    const json = gen.serialize(built);
    const parsed = parseV5Config(json);
    return { built, json, parsed };
}

/** 逐字断言的辅助：插件接受的路径 */
function pluginAccepts(cfg) {
    const issues = validateV5Config(cfg);
    return issues.length === 0;
}

/** 仅在插件接受时适配（否则 adaptV5 会因 config 为 null 而抛） */
const adaptIfOk = (p) => (p.config ? adaptV5(p.config) : { conns: [], rules: [] });

console.log(`配置生成器：${genRoot}`);
console.log('');

// ---------------------------------------------------------------- A. 生成器产出 → 插件必须接受

console.log('=== A. 生成器产出的配置，插件必须接受 ===');

/** 一条 UI 侧的连接（与生成器 state 同形） */
const uiConn = (over = {}) => ({
    id: 'c1', templateId: 'deepseek', mode: 'vendor',
    provider: '', api: 'openai-completions',
    baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-real-key',
    models: [{ id: 'flash', name: 'deepseek-v4-flash', kind: 'text' }],
    enabled: true, displayName: '', timeout: 0, request: {},
    ...over,
});

const scenarios = [
    {
        name: '单连接（deepseek + 文本模型）',
        providers: [uiConn()],
        purposes: { chat: 'flash' },
        expect: (rt, p) => {
            ok('  插件解析成功', p.config !== null, JSON.stringify(p.issues));
            ok('  无校验问题', p.issues.length === 0, JSON.stringify(p.issues));
            ok('  provider 未写入（可从 URL 反查）', rt.built.providers[0].provider === undefined);
            return true;
        },
    },
    {
        name: '多连接（含生图 + 视觉，各自 kind）',
        providers: [
            uiConn(),
            uiConn({
                id: 'c2', templateId: 'siliconflow', provider: '',
                baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-2',
                models: [{ id: 'flux', name: 'black-forest-labs/FLUX.1-schnell', kind: 'gen' }],
            }),
            uiConn({
                id: 'c3', templateId: 'anthropic', provider: 'anthropic', api: 'anthropic-messages',
                baseURL: 'https://api.anthropic.com/v1', apiKey: 'sk-3',
                models: [{ id: 'sonnet', name: 'claude-sonnet-4-5', kind: 'vision' }],
            }),
        ],
        purposes: { chat: 'flash', 'image-generation': 'flux', 'image-understanding': 'sonnet' },
        expect: (rt, p) => {
            ok('  插件解析成功', p.config !== null, JSON.stringify(p.issues));
            ok('  无校验问题', p.issues.length === 0, JSON.stringify(p.issues));
            ok('  3 条连接', p.config.providers.length === 3);
            const { conns } = adaptIfOk(p);
            ok('  vendor 由 URL 反查', conns[0].provider === 'deepseek' && conns[1].provider === 'siliconflow');
            ok('  anthropic 协议透传', conns[2].api === 'anthropic-messages');
            return true;
        },
    },
    {
        name: '自定义网关（无 vendor 可反查）',
        providers: [uiConn({
            id: 'gw', templateId: 'custom', mode: 'custom', provider: '',
            baseURL: 'https://my-gateway.example.com/v1', apiKey: 'sk-gw',
            displayName: '我的网关',
            models: [{ id: 'gw-1', name: 'inhouse-vl', kind: 'vision' }],
        })],
        purposes: { 'image-understanding': 'gw-1' },
        expect: (rt, p) => {
            ok('  插件解析成功', p.config !== null, JSON.stringify(p.issues));
            const { conns } = adaptIfOk(p);
            ok('  vendor 识别为空（按 OpenAI 兼容处理）', conns[0].provider === '');
            ok('  displayName 保留', p.config.providers[0].displayName === '我的网关');
            return true;
        },
    },
    {
        name: '空模型清单（= 启动时自动拉取）',
        providers: [uiConn({ models: [] })],
        purposes: {},
        expect: (rt, p) => {
            ok('  插件解析成功', p.config !== null, JSON.stringify(p.issues));
            const { conns } = adaptIfOk(p);
            ok('  models 未写入配置', rt.built.providers[0].models === undefined);
            ok('  适配为 null = 自动拉取', conns[0].models === null, String(conns[0].models));
            return true;
        },
    },
    {
        name: '手工指定 vendor（覆盖自动识别，媒体专用厂商）',
        providers: [uiConn({
            id: 'mm', templateId: 'custom', mode: 'custom', provider: 'minimax',
            baseURL: 'https://api.minimax.chat/v1', apiKey: 'sk-mm',
            models: [{ id: 'speech-01', name: 'speech-01', kind: 'tts' }],
        })],
        purposes: { tts: 'speech-01' },
        expect: (rt, p) => {
            ok('  插件解析成功', p.config !== null, JSON.stringify(p.issues));
            const { conns } = adaptIfOk(p);
            ok('  provider 显式写入', rt.built.providers[0].provider === 'minimax');
            ok('  适配后 vendor 为 minimax（供 media_presets 用）', conns[0].provider === 'minimax');
            return true;
        },
    },
    {
        name: '禁用连接：生成器直接从输出移除（不写 enabled 字段）',
        providers: [
            uiConn(),
            uiConn({
                id: 'off', templateId: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
                apiKey: 'k', enabled: false,
                // 模型 id 需全局唯一，故这里不再重复用 flash
                models: [],
            }),
        ],
        purposes: {},
        expect: (rt, p) => {
            ok('  插件解析成功', p.config !== null, JSON.stringify(p.issues));
            ok('  停用连接不写入配置', rt.built.providers.length === 1, JSON.stringify(rt.built.providers));
            const { conns } = adaptIfOk(p);
            ok('  适配后只剩启用连接', conns.length === 1 && conns[0].ignore === false, JSON.stringify(conns));
            ok('  输出不含 enabled 字段', !gen.serialize(rt.built).includes('"enabled"'));
            return true;
        },
    },
    {
        name: '遮蔽 API Key 后仍合法',
        providers: [uiConn()],
        purposes: {},
        mask: true,
        expect: (rt, p) => {
            const masked = gen.maskKeys(rt.built);
            const json = gen.serialize(masked);
            const mp = parseV5Config(json);
            ok('  遮蔽后插件仍接受', mp.config !== null, JSON.stringify(mp.issues));
            ok('  不含真实 key', !json.includes('sk-real-key'));
            return true;
        },
    },
];

for (const sc of scenarios) {
    console.log(`--- ${sc.name} ---`);
    const rt = roundTrip(sc.providers, sc.purposes);
    // 生成器自检：它自己也得认为这份配置合法
    const genIssues = gen.validate(sc.providers, sc.purposes);
    ok('  生成器自检通过', genIssues.length === 0, JSON.stringify(genIssues));
    sc.expect(rt, rt.parsed);
}

// ---------------------------------------------------------------- B. 两边对合法性的判定必须一致

console.log('\n=== B. 生成器与插件对"合法/非法"的判定必须一致 ===');

/** 生成器的合法判定（**完整配置**，含 version/groups，与插件同口径） */
const genValid = (cfg) => gen.validateConfig(cfg).length === 0;
/** 插件的合法判定 */
const pluginValid = (cfg) => pluginAccepts(cfg);

const base = (over = {}) => ({
    version: 5,
    providers: [{
        api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x',
        models: [{ id: 'm1', name: 'deepseek-chat', kind: 'text' }],
    }],
    purposes: { chat: 'm1' },
    ...over,
});

const cases = [
    ['合法最小配置', base()],
    ['api 非法', base({ providers: [{ api: 'grpc', baseURL: 'https://a.com/v1', apiKey: 'k' }] })],
    ['baseURL 缺失', base({ providers: [{ api: 'openai-completions', apiKey: 'k' }] })],
    ['baseURL 无协议头', base({ providers: [{ api: 'openai-completions', baseURL: 'a.com/v1', apiKey: 'k' }] })],
    ['apiKey 缺失', base({ providers: [{ api: 'openai-completions', baseURL: 'https://a.com/v1' }] })],
    ['kind 非法', base({ providers: [{ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ id: 'm1', name: 'x', kind: 'audio' }] }] })],
    ['模型 id 缺失', base({ providers: [{ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ name: 'x' }] }] })],
    ['模型名缺失', base({ providers: [{ api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ id: 'm1' }] }] })],
    ['模型 id 重复', base({
        providers: [
            { api: 'openai-completions', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ id: 'dup', name: 'x' }] },
            { api: 'openai-completions', baseURL: 'https://b.com/v1', apiKey: 'k', models: [{ id: 'dup', name: 'y' }] },
        ],
    })],
    ['purposes 悬空引用', base({ purposes: { chat: 'ghost' } })],
    ['purposes 未知用途', base({ purposes: { nonsense: 'm1' } })],
    ['用途×类型不匹配（text 当生图）', base({ purposes: { 'image-generation': 'm1' } })],
    ['providers 为空', base({ providers: [] })],
    ['groups 空 purposes', base({ groups: [{ purposes: [] }] })],
    ['版本错误', base({ version: 4 })],
];

for (const [name, cfg] of cases) {
    const g = genValid(cfg);
    const p = pluginValid(cfg);
    ok(`${name}：两边判定一致（生成器=${g ? '合法' : '非法'}，插件=${p ? '合法' : '非法'}）`, g === p,
        g === p ? '' : '两边对同一份配置的合法性判定不同');
}

// ---------------------------------------------------------------- C. 往返：插件接受的配置，生成器也认

console.log('\n=== C. 插件的出厂默认配置，生成器也必须认 ===');

{
    const defCfg = JSON.parse(DEFAULT_V5_CONFIG);
    ok('出厂默认能被插件接受', pluginValid(defCfg));
    ok('出厂默认能被生成器接受', genValid(defCfg),
        JSON.stringify(gen.validateConfig(defCfg)));
    ok('出厂 baseURL 与 PROVIDER_MAP 一致', defCfg.providers[0].baseURL === PROVIDER_MAP.deepseek);
    ok('出厂 apiKey 是占位符（非空，能过校验）', defCfg.providers[0].apiKey === 'sk-xxxx');
    // 出厂默认的 vendor 必须能被插件反查出来（media_presets / balance 依赖）
    ok('出厂连接的 vendor 可反查', resolveVendor(defCfg.providers[0].baseURL) === 'deepseek');
}

// ---------------------------------------------------------------- D. 生成器的供应商模板 vs 插件识别表

console.log('\n=== D. 生成器模板的默认地址，插件必须能反查回同一 vendor ===');

// **现在没有任何模板需要显式写 provider**。
//
// 曾经有例外：「百炼原生」（dashscope.aliyuncs.com → dashscope）与「阿里百炼」
// （dashscope.aliyuncs.com/compatible-mode/v1 → alibaba）**共用同一 host**，
// 而插件的 resolveVendor 只看 host，必然都判成 alibaba —— 所以那个模板必须显式写
// provider=dashscope 才正确。
//
// 但它已随兼容层一并**删除**：插件侧现在按模型名分流（qwen-image 走兼容模式、
// wanx 与 TTS 走主机根的原生端点），"选兼容还是选原生"不该让用户决定。
// dashscope 仍作为**逃生舱**保留（供应商标识可手填），只是不再有对应模板。
// 注意区分两件事：`t.provider` 是**模板声明的 vendor**（每个模板都有），
// 而"要不要把它写进配置"由 `providerForTemplate` 决定 —— 地址能反查回自己就留空。
let needExplicit = 0;
for (const t of tpl.PROVIDER_TEMPLATES.filter(x => x.id !== 'custom')) {
    const derived = resolveVendor(t.baseUrl);
    ok(`${t.label}（${t.provider}）→ ${derived || '(空)'}`, derived === t.provider,
        `生成器模板 provider=${JSON.stringify(t.provider)}，插件反查得 ${derived}`);
    if (tpl.providerForTemplate(t) !== '') needExplicit++;
}
ok('没有任何模板需要显式写 provider（兼容层已接管）', needExplicit === 0,
    `需要显式写的模板数=${needExplicit}`);
ok('生成器的「百炼原生」模板已删除（百炼只剩一个入口）',
    !tpl.PROVIDER_TEMPLATES.some(t => t.id === 'dashscope'),
    JSON.stringify(tpl.PROVIDER_TEMPLATES.map(t => t.id)));
// 但 dashscope 作为**逃生舱**仍须可用：只暴露原生接口的部署靠它反查出来
ok('dashscope 仍可由原生端点路径反查（逃生舱保留）',
    resolveVendor('https://x.example/api/v1/services/aigc/multimodal-generation/generation') === 'dashscope');

// ---------------------------------------------------------------- E. 供应商自报能力位 → 可用的视觉模型

console.log('\n=== E. /models 自报能力位 → kind=vision → 插件图片识别候选（方案 9.3.3） ===');

{
    // 生成器侧的模块（与插件同源但独立实现）
    const genClassify = await import(pathToFileURL(path.join(genRoot, 'js', 'classify.js')).href);
    const genFetch = await import(pathToFileURL(path.join(genRoot, 'js', 'fetch-models.js')).href);

    // 模拟 DeepSeek GET /models 的真实返回（含 input_modalities）
    const fakeModelsResponse = {
        object: 'list',
        data: [
            { id: 'deepseek-chat', object: 'model', input_modalities: ['text'], context_window: 128000 },
            {
                id: 'deepseek-flash', object: 'model', name: 'DeepSeek Flash',
                input_modalities: ['text', 'image'], context_window: 128000,
            },
        ],
    };

    // 生成器的解析路径：只保留元数据里"自报"的能力，不猜 text
    const entries = fakeModelsResponse.data.map(it => {
        const kind = genFetch.kindFromMetadata(it);
        return { id: it.id, ...(kind ? { kind } : {}) };
    });
    ok('自报：deepseek-chat 不产出 kind（只报 text，不当作证据）',
        !entries.find(e => e.id === 'deepseek-chat').kind);
    ok('自报：deepseek-flash → vision',
        entries.find(e => e.id === 'deepseek-flash').kind === 'vision');

    // 用户点选两个模型 → 生成器按 decideKind 决定写不写 kind
    const models = entries.map(e => ({
        id: e.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase(),
        name: e.id,
        kind: genClassify.decideKind({ meta: e.kind, name: e.id }),
    }));
    ok('decideKind：deepseek-flash 写 vision', models[1].kind === 'vision');
    ok('decideKind：deepseek-chat 不写 kind（留空让插件判断）', models[0].kind === undefined,
        String(models[0].kind));

    const built = gen.build([{
        id: 'c1', templateId: 'deepseek', mode: 'vendor', provider: '',
        api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-real',
        models, enabled: true, displayName: '', timeout: 0, request: {},
    }], { 'image-understanding': models[1].id, chat: models[0].id });

    ok('生成器自检通过', gen.validateConfig(built).length === 0,
        JSON.stringify(gen.validateConfig(built)));

    const parsed = parseV5Config(gen.serialize(built));
    ok('插件接受这份配置', parsed.config !== null, JSON.stringify(parsed.issues));

    if (parsed.config) {
        const cfg = parsed.config;
        const flash = cfg.providers[0].models.find(m => m.name === 'deepseek-flash');
        const chat = cfg.providers[0].models.find(m => m.name === 'deepseek-chat');
        ok('配置里 deepseek-flash 的 kind = vision', flash.kind === 'vision', String(flash?.kind));
        ok('配置里 deepseek-chat **没有** kind 字段（不被错误钉死）',
            !('kind' in chat), JSON.stringify(chat));

        // 适配到运行时后，插件据 kind 把它放进图片识别候选
        const { conns } = adaptV5(cfg);
        ok('适配后 modelTypes 带上 vision', conns[0].modelTypes['deepseek-flash'] === 'vision',
            JSON.stringify(conns[0].modelTypes));

        // 关键：用途×类型资格 —— vision 才能进 image-understanding
        const { isEligibleKind } = plugin;
        ok('vision 可用于图片识别', isEligibleKind('image-understanding', 'vision'));
        ok('vision 同时仍可用于对话（多模态模型也能聊天）', isEligibleKind('chat', 'vision'));
        ok('text 不能用于图片识别（反例）', !isEligibleKind('image-understanding', 'text'));
    }
}

// ---------------------------------------------------------------- F. 真实场景：百炼 MaaS 自建网关

console.log('\n=== F. 百炼 MaaS 自建网关（host 无法识别 → 必须显式 provider）===');

{
    // 真实用户场景：百炼专属部署域名（不是 dashscope.aliyuncs.com），
    // 模型是 qwen-image-3.0-pro（同步返回的百炼原生结构）。
    const genClassify = await import(pathToFileURL(path.join(genRoot, 'js', 'classify.js')).href);
    const MAAS_HOST = 'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com';
    const MAAS_FULL = MAAS_HOST + '/api/v1/services/aigc/multimodal-generation/generation';

    // 1) 这个 host 不在 PROVIDER_MAP 里 —— 反查不到 vendor，所以必须手填 provider
    ok('MaaS 专属域名反查不到 vendor（故须显式指定）', resolveVendor(MAAS_HOST) === '',
        resolveVendor(MAAS_HOST));

    // 2) 生成器侧：供应商建议列表里要有 dashscope，否则用户没法填
    const vendors = tpl.KNOWN_VENDORS.map(v => v.value);
    ok('生成器建议列表含 dashscope', vendors.includes('dashscope'));
    ok('生成器建议列表含 alibaba（兼容模式）', vendors.includes('alibaba'));

    // 3) 生成器能不能识别 qwen-image 为生图？—— 不能，必须手选
    // 本轮把 qwen-image 补进了生图白名单（此前要用户在 UI 手选，是多余的摩擦）
    ok('按名字就能识别 qwen-image 为生图', genClassify.classifyModel('qwen-image-3.0-pro') === 'gen',
        `实际判定为 ${genClassify.classifyModel('qwen-image-3.0-pro')}`);
    ok('decideKind 据此直接写 kind=gen',
        genClassify.decideKind({ name: 'qwen-image-3.0-pro' }) === 'gen',
        String(genClassify.decideKind({ name: 'qwen-image-3.0-pro' })));

    // 4) 用户在 UI 手选「生图」后的配置
    const built = gen.build([{
        id: 'c1', templateId: 'custom', mode: 'custom',
        provider: 'dashscope',                       // ← 逃生舱：host 认不出，手工指定
        api: 'openai-completions',
        baseURL: MAAS_HOST,                          // ← 用 host 根地址，路径交给内置预设
        apiKey: 'sk-REPLACE-ME',
        models: [{ id: 'qwen-image', name: 'qwen-image-3.0-pro', kind: 'gen' }],
        enabled: true, displayName: '', timeout: 0, request: {},
    }], { 'image-generation': 'qwen-image' });

    ok('生成器自检通过', gen.validateConfig(built).length === 0,
        JSON.stringify(gen.validateConfig(built)));

    const parsed = parseV5Config(gen.serialize(built));
    ok('插件接受这份配置', parsed.config !== null, JSON.stringify(parsed.issues));

    if (parsed.config) {
        const { conns } = adaptV5(parsed.config);
        ok('适配后 vendor = dashscope（显式覆盖生效）', conns[0].provider === 'dashscope',
            conns[0].provider);
        ok('适配后 kind 进了 modelTypes', conns[0].modelTypes['qwen-image-3.0-pro'] === 'gen',
            JSON.stringify(conns[0].modelTypes));

        // 5) 请求体来自内置预设（用户**不需要**手写 body/response）
        const composed = composeMediaTemplate('image-generation', 'dashscope', 'qwen-image-3.0-pro', 'qwen-image');
        ok('预设 response.data_path 正确',
            composed.response?.data_path === 'output.choices.0.message.content.0.image',
            String(composed.response?.data_path));

        // 渲染成**真正要发出去的请求体**（占位符在这一步替换）
        const rendered = renderMediaBody(composed.body, {
            builtin: { model: 'qwen-image-3.0-pro', prompt: '一只猫', negative_prompt: '模糊', api_key: 'k' },
            params: { size: '1024*1024' },
            meta: { size: { type: 'string', default: '1024*1024', desc: '' } },
        });
        const body = rendered.body;
        ok('渲染后 body.model = 真实模型名', body.model === 'qwen-image-3.0-pro', JSON.stringify(body.model));
        ok('渲染后 prompt 已代入',
            body.input?.messages?.[0]?.content?.[0]?.text === '一只猫',
            JSON.stringify(body.input));
        ok('渲染后 negative_prompt 已代入',
            body.parameters?.negative_prompt === '模糊', JSON.stringify(body.parameters));
        ok('渲染后 size 用预设默认值', body.parameters?.size === '1024*1024',
            JSON.stringify(body.parameters));
        ok('渲染后 prompt_extend 保持布尔真值（不被字符串化）',
            body.parameters?.prompt_extend === true, JSON.stringify(body.parameters));
        ok('渲染后没有遗留未替换的占位符',
            !/\{[a-z_]+\}/i.test(JSON.stringify(body)), JSON.stringify(body));

        // 6) URL 解析：host 根地址 → 拼上预设后缀
        const render = (s) => String(s ?? '');
        const urlFromRoot = resolveMediaUrl('image-generation', composed, MAAS_HOST, render);
        ok('host 根地址 + 预设后缀 = 完整接口地址', urlFromRoot === MAAS_FULL, urlFromRoot);

        // 7) 直接粘完整地址也不能把路径拼两遍（joinMediaUrl 有去重保护）
        const urlFromFull = resolveMediaUrl('image-generation', composed, MAAS_FULL, render);
        ok('粘完整地址不会重复拼路径', urlFromFull === MAAS_FULL, urlFromFull);

        // 8) 不显式指定 provider 会怎样？——预设选不中，落到通用 /images/generations
        const composedGeneric = composeMediaTemplate('image-generation', '', 'qwen-image-3.0-pro', 'qwen-image');
        const urlGeneric = resolveMediaUrl('image-generation', composedGeneric, MAAS_HOST, render);
        ok('不填 provider 会走错地址（故 provider 必填）', urlGeneric !== MAAS_FULL, urlGeneric);
        ok('  → 实际会请求通用路径', urlGeneric === MAAS_HOST + '/images/generations', urlGeneric);
    }
}

// ---------------------------------------------------------------- G. 真防漂移守卫
//
// 为什么必须放在**跨仓库**联测里：生成器自己的 tests/run.mjs 曾有一条自称"防漂移守卫"
// 的用例，实际是拿 templates.js 的 MEDIA_VENDORS 去比 templates.js 的 KNOWN_VENDORS ——
// 自引用、恒真，插件加第 17 个 vendor 它照样过。只有这里能同时 import 两边。

console.log('\n=== G. 防漂移：生成器的表必须跟上插件的真实数据 ===');

{
    // G1) 生成器的 vendor 建议列表必须覆盖插件 media_presets 的全部 vendor
    const pluginVendors = new Set();
    for (const use of Object.keys(MEDIA_PRESETS)) {
        for (const k of Object.keys(MEDIA_PRESETS[use])) {
            if (k) pluginVendors.add(k);      // '' 是通用预设，不是 vendor
        }
    }
    const genVendors = new Set(tpl.MEDIA_VENDORS);
    const missing = [...pluginVendors].filter(v => !genVendors.has(v));
    ok(`生成器覆盖 media_presets 全部 ${pluginVendors.size} 个 vendor`, missing.length === 0,
        `缺：${missing.join(', ')}`);
    const extra = [...genVendors].filter(v => !pluginVendors.has(v));
    ok('生成器没有插件不认识的 media vendor', extra.length === 0, `多：${extra.join(', ')}`);

    // G2) 按用途拆开核对
    const byUse = {};
    for (const use of Object.keys(MEDIA_PRESETS)) {
        byUse[use] = new Set(Object.keys(MEDIA_PRESETS[use]).filter(k => k));
    }
    for (const use of Object.keys(byUse)) {
        const miss = [...byUse[use]].filter(v => !genVendors.has(v));
        ok(`  ${use} 的 ${byUse[use].size} 个 vendor 都在建议列表里`, miss.length === 0,
            `缺：${miss.join(', ')}`);
    }

    // G3) 用途支持矩阵必须与插件真实表一致
    const matrix = tpl.MEDIA_VENDOR_USES;
    if (!matrix) {
        ok('生成器提供 vendor→用途 支持矩阵（供 UI 标注）', false, '缺 MEDIA_VENDOR_USES');
    } else {
        const mismatch = [];
        for (const [vendor, uses] of Object.entries(matrix)) {
            for (const use of ['tts', 'image-generation']) {
                const reallyHas = byUse[use].has(vendor);
                const claims = uses.includes(use);
                if (reallyHas !== claims) {
                    mismatch.push(`${vendor}/${use}: 插件=${reallyHas ? '有' : '无'} 生成器标=${claims ? '有' : '无'}`);
                }
            }
        }
        ok('vendor→用途 支持矩阵与插件一致', mismatch.length === 0, mismatch.join('； '));
    }

    // G4) 关键 vendor 的实际预设必须真的能取到
    for (const [vendor, use] of [
        ['dashscope', 'image-generation'], ['dashscope', 'tts'],
        ['elevenlabs', 'tts'], ['volcengine', 'image-generation'],
        ['openai', 'tts'], ['openai', 'image-generation'],
    ]) {
        const p = resolveMediaPreset(vendor, use, '');
        ok(`  ${vendor}/${use} 取到预设且带 body`, !!p && !!p.body, JSON.stringify(p && p.body));
    }

    // G5) 用途组 body 必须与插件出厂默认一致
    const defCfg = JSON.parse(DEFAULT_V5_CONFIG);
    const pluginChatGroup = (defCfg.groups || []).find(g => g.purposes.includes('chat'));
    ok('插件出厂默认含 chat 用途组', !!pluginChatGroup);
    if (pluginChatGroup) {
        const genBody = gen.DEFAULT_USE_BODIES.chat;
        ok('生成器 chat 组默认 body 与插件出厂默认逐字段一致',
            JSON.stringify(pluginChatGroup.body) === JSON.stringify(genBody),
            `生成器=${JSON.stringify(genBody)} 插件=${JSON.stringify(pluginChatGroup.body)}`);
    }
    const genDefaultCfg = gen.build([{
        id: 'c', templateId: 'deepseek', mode: 'vendor', provider: '', api: 'openai-completions',
        baseURL: 'https://api.deepseek.com/v1', apiKey: 'k',
        models: [{ id: 'flash', name: 'deepseek-v4-flash' }],
        enabled: true, displayName: '', timeout: 0, request: {},
    }], { chat: 'flash', compression: 'flash', summarization: 'flash', judge: 'flash' });
    const genChatGroup = (genDefaultCfg.groups || []).find(g => g.purposes.includes('chat'));
    ok('生成器默认产出的 chat 组与插件出厂默认一致',
        !!genChatGroup && !!pluginChatGroup
        && JSON.stringify(genChatGroup.body) === JSON.stringify(pluginChatGroup.body),
        JSON.stringify(genChatGroup && genChatGroup.body));

    // G6) 识图 / 嵌入：确认插件**确实没有** vendor 预设（有的话结论要改）
    ok('插件 media_presets 只覆盖 tts 与 image-generation（识图/嵌入无 vendor 预设）',
        Object.keys(MEDIA_PRESETS).sort().join(',') === 'image-generation,tts',
        Object.keys(MEDIA_PRESETS).join(','));
}
// ---------------------------------------------------------------- H. 逐模型「请求覆盖」端到端

console.log('\n=== H. 逐模型请求覆盖 → 插件真实请求体 ===');

{
    const customBody = { model: '{model}', prompt: '{prompt}', style: 'anime' };

    const built = gen.build([{
        id: 'c1', templateId: 'custom', mode: 'custom', provider: 'stability',
        api: 'openai-completions', baseURL: 'https://api.stability.ai', apiKey: 'sk-x',
        models: [{
            id: 'sd', name: 'sd3-large', kind: 'gen',
            request: { body: customBody, response: { data_path: 'artifacts.0.base64', data_type: 'base64' } },
            bodyMode: 'merge',
        }],
        enabled: true, displayName: '', timeout: 0, request: {},
    }], { 'image-generation': 'sd' });

    ok('生成器自检通过', gen.validateConfig(built).length === 0, JSON.stringify(gen.validateConfig(built)));
    const parsed = parseV5Config(gen.serialize(built));
    ok('插件接受这份配置', parsed.config !== null, JSON.stringify(parsed.issues));

    if (parsed.config) {
        const m = parsed.config.providers[0].models[0];
        ok('request 原样进了配置',
            JSON.stringify(m.request) === JSON.stringify({
                body: customBody, response: { data_path: 'artifacts.0.base64', data_type: 'base64' },
            }), JSON.stringify(m.request));
        ok('bodyMode 进了配置', m.bodyMode === 'merge', String(m.bodyMode));

        const { conns, rules } = adaptV5(parsed.config);
        // 与插件一致：bootstrap 会把规则装进模块状态（model.ts:358），
        // composeMediaTemplate 读的是那份状态，不是这里返回的数组
        setRuleRows(rules);
        ok('适配后 kind=gen', conns[0].modelTypes['sd3-large'] === 'gen');
        const rule = rules.find(r => Array.isArray(r.models) && r.models.includes('sd'));
        ok('per-model request 变成 models 定向规则', !!rule, JSON.stringify(rules));
        ok('规则带上 bodyMode', rule && rule.bodyMode === 'merge', rule && String(rule.bodyMode));

        const composed = composeMediaTemplate('image-generation', 'stability', 'sd3-large', 'sd');
        const rendered = renderMediaBody(composed.body, {
            builtin: { model: 'sd3-large', prompt: '一只猫', api_key: 'k' },
            params: {}, meta: {},
        });
        ok('merge：自定义字段生效', rendered.body.style === 'anime', JSON.stringify(rendered.body));
        ok('merge：预设字段被保留（不是整体替换）',
            Object.keys(rendered.body).length > 3, JSON.stringify(rendered.body));
        ok('merge：占位符已替换',
            rendered.body.model === 'sd3-large' && rendered.body.prompt === '一只猫',
            JSON.stringify(rendered.body));
        ok('response 取数规则生效',
            composed.response?.data_path === 'artifacts.0.base64'
            && composed.response?.data_type === 'base64',
            JSON.stringify(composed.response));
    }
}
// ---------------------------------------------------------------- I. 导入往返后插件仍须接受

console.log('\n=== I. 导入→导出往返后，插件仍须接受（且语义不变）===');

{
    // 导入是生成器单方面的能力，但**往返后的产物必须仍是插件认的配置** ——
    // 否则用户"导入改一下再导出"就会得到一份装不进插件的配置。
    const gen2 = await import(pathToFileURL(path.join(genRoot, 'js', 'v5.js')).href);

    const cases = [
        ['标准分组', gen2.build([{
            id: 'c', templateId: 'deepseek', mode: 'vendor', provider: '', api: 'openai-completions',
            baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-a',
            models: [{ id: 'm', name: 'deepseek-chat' }], enabled: true, displayName: '', timeout: 0, request: {},
        }], { chat: 'm' })],
        ['非标准分组', {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-a',
                models: [{ id: 'm', name: 'deepseek-chat' }],
            }],
            purposes: { chat: 'm' },
            groups: [{ purposes: ['chat'], body: { max_tokens: 7 } }],
        }],
        ['含逐模型覆盖', {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-a',
                models: [{
                    id: 'flux', name: 'black-forest-labs/FLUX.1-schnell', kind: 'gen',
                    request: { body: { model: '{model}', prompt: '{prompt}' }, response: { data_path: 'images.0.url' } },
                    bodyMode: 'replace',
                }],
            }],
            purposes: { 'image-generation': 'flux' },
        }],
    ];

    for (const [name, cfg] of cases) {
        const text = JSON.stringify(cfg);
        // 往返：导入 → 导出
        const imp = gen2.parseImport(text);
        ok(`  ${name}：生成器导入成功`, imp.ok, JSON.stringify(imp.issues));
        if (!imp.ok) continue;
        const out = gen2.build(imp.state.providers, imp.state.purposes, imp.state.useBodies, imp.state.extraGroups);
        const outText = JSON.stringify(out);

        // 关键断言：往返产物仍被**插件**接受
        const parsed = parseV5Config(outText);
        ok(`  ${name}：往返产物仍被插件接受`, parsed.config !== null, JSON.stringify(parsed.issues));

        // 且用途组内容没有漂移（按键序规范化比较）
        const canon = (v) => JSON.stringify(v, (k, val) =>
            (val && typeof val === 'object' && !Array.isArray(val))
                ? Object.keys(val).sort().reduce((o, kk) => (o[kk] = val[kk], o), {})
                : val);
        ok(`  ${name}：用途组往返无漂移`,
            canon(cfg.groups || []) === canon(out.groups || []),
            `\n      前=${canon(cfg.groups || [])}\n      后=${canon(out.groups || [])}`);
    }
}
// ---------------------------------------------------------------- J. 官方百炼兼容模式：零自定义配置

console.log('\n=== J. 官方百炼（兼容模式）生图：不填 URL、不写结构就该能用 ===');

{
    // 官方文档：POST /compatible-mode/v1/images/generations
    //   body { model, prompt, size:"1024x1024", n, prompt_extend }
    //   响应 { created, data:[{url}] }
    // 这一组要证明：用户只要选「阿里百炼」模板 + 填 key + 把模型标成生图，
    // 插件内置的 alibaba 预设就能凑齐 URL / 请求体 / 取数路径 —— 不需要任何自定义。
    const OFFICIAL_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const DOC_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations';

    // 1) 官方地址能被自动识别成 alibaba（连手填 vendor 都不必）
    ok('官方兼容模式地址自动识别为 alibaba', resolveVendor(OFFICIAL_BASE) === 'alibaba',
        resolveVendor(OFFICIAL_BASE));

    // 2) 生成器模板里就有「阿里百炼」，选中即填好 baseURL/api/provider
    const tplAlibaba = tpl.PROVIDER_TEMPLATES.find(x => x.id === 'alibaba');
    ok('生成器有「阿里百炼」模板', !!tplAlibaba);
    ok('模板 baseURL 就是官方兼容模式地址', tplAlibaba.baseUrl === OFFICIAL_BASE, tplAlibaba.baseUrl);
    ok('模板 provider = alibaba', tplAlibaba.provider === 'alibaba', tplAlibaba.provider);

    // 3) 走生成器正常路径（选模板 → 加模型 → 标生图），不碰 URL、不写 request
    const built = gen.build([{
        id: 'c1', templateId: 'alibaba', mode: 'vendor', provider: tplAlibaba.provider,
        api: tplAlibaba.api, baseURL: tplAlibaba.baseUrl, apiKey: 'sk-real',
        models: [{ id: 'qwen-image', name: 'qwen-image-3.0-pro', kind: 'gen' }],
        enabled: true, displayName: '', timeout: 0, request: {},
    }], { 'image-generation': 'qwen-image' });

    ok('生成的配置里没有自定义 request（用户没写结构）',
        !('request' in built.providers[0].models[0]), JSON.stringify(built.providers[0].models[0]));
    ok('生成器自检通过', gen.validateConfig(built).length === 0, JSON.stringify(gen.validateConfig(built)));
    const parsed = parseV5Config(gen.serialize(built));
    ok('插件接受这份配置', parsed.config !== null, JSON.stringify(parsed.issues));

    if (parsed.config) {
        const { conns } = adaptV5(parsed.config);
        ok('适配后 vendor = alibaba', conns[0].provider === 'alibaba', conns[0].provider);

        // 4) URL：预设拼出来的必须**正好等于官方文档的端点**
        const composed = composeMediaTemplate('image-generation', 'alibaba', 'qwen-image-3.0-pro', 'qwen-image');
        const render = (s) => String(s ?? '');
        const url = resolveMediaUrl('image-generation', composed, OFFICIAL_BASE, render);
        ok('预设拼出的 URL 与官方文档端点一致', url === DOC_ENDPOINT, url);

        // 5) 请求体：渲染后必须与官方文档的字段一致
        //    参数按插件真实流程归一（rawParams 为空 → 取 meta 里的默认值），
        //    这样测的才是"用户什么都不填"时真正会发出去的 body
        const meta = composed.params;
        const norm = normalizeMediaParams({}, templateParamKeys(composed), meta, {});
        ok('参数归一无错误', norm.errors.length === 0, JSON.stringify(norm.errors));
        const rendered = renderMediaBody(composed.body, {
            builtin: { model: 'qwen-image-3.0-pro', prompt: '一只猫', api_key: 'k' },
            params: norm.params,
            meta,
        });
        const b = rendered.body;
        ok('请求体含 model/prompt（官方必填）', b.model === 'qwen-image-3.0-pro' && b.prompt === '一只猫',
            JSON.stringify(b));
        ok('size 用字母 x 分隔（兼容模式要求，非 DashScope 原生的 *）',
            b.size === '1024x1024', String(b.size));
        ok('n 是整数 1（文档要求整数，字符串会 400）', b.n === 1, JSON.stringify(b.n));
        ok('没有多出 DashScope 原生才有的 input/parameters 字段',
            !('input' in b) && !('parameters' in b), JSON.stringify(b));

        // 6) 取数（预设没写 data_path → 靠兜底候选命中官方响应结构）在插件单测里验证：
        //    extractMediaData 所在的 media.ts 依赖 config.ts（模块顶层用 seal），
        //    无法进这个无 seal 的联测包。见 unit-test-entry.ts 的 testOfficialDashscopeImageShape。
    }
}
// ---------------------------------------------------------------- K. 分类白名单的漂移守卫

console.log('\n=== K. 分类白名单：插件判定的，生成器也必须判定（超集不变量） ===');

{
    // 生成器的 classify 是插件 classifyModel 的**超集**（它可以多认，用于预填 kind），
    // 但**绝不能与插件矛盾**。不变量：插件判为 X ⇒ 生成器也判为 X。
    // 这是 §12.4 列的第三处手抄（前两处是 vendor 表与用途组 body），此前没有守卫。
    const genClassify = await import(pathToFileURL(path.join(genRoot, 'js', 'classify.js')).href);

    // 插件侧 classifyModel(provider, name, extra) → ModelTag[]；取它的"终值"判定
    const pluginKind = (name) => {
        const tags = classifyModel('', name, {});
        for (const t of ['embed', 'gen', 'tts']) if (tags.includes(t)) return t;
        return 'text';
    };
    const genKind = (name) => genClassify.classifyModel(name);

    const names = [
        // 嵌入
        'text-embedding-v4', 'text-embedding-3-small', 'bge-m3', 'bge-large-zh', 'bce-embedding-base',
        'gemini-embedding-001', 'mistral-embed', 'nomic-embed-text-v1',
        // 生图（含本轮新增的 qwen-image）
        'dall-e-3', 'gpt-image-1', 'cogview-4', 'wanx2.1-t2i-turbo',
        'black-forest-labs/FLUX.1-schnell', 'stable-diffusion-xl', 'sd3-large', 'kolors',
        'hunyuan-image-3.0', 'seedream-3.0', 'midjourney-v6', 'imagen-3.0', 'veo-2',
        'qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro',
        // 语音
        'tts-1', 'gpt-4o-mini-tts', 'cosyvoice-v1', 'fish-speech-1.5', 'speech-01',
        // 对话 / 视觉（插件一律 text，生成器也应 text）
        'deepseek-v4-flash', 'deepseek-chat', 'gpt-4o', 'glm-4v', 'qwen-vl-max', 'claude-sonnet-4-5',
        // 易误伤
        'influx-db-model', 'video-generation-helper', 'flux-capacitor',
    ];

    const bad = [];
    for (const n of names) {
        const p = pluginKind(n);
        const g = genKind(n);
        if (p !== g) bad.push(`${n}: 插件=${p} 生成器=${g}`);
    }
    ok(`分类白名单一致（${names.length} 个样本）`, bad.length === 0, bad.join('； '));

    // 本轮新增的 qwen-image 必须两边都认成 gen
    for (const n of ['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-2.1-pro']) {
        ok(`  ${n} 两边都判为 gen`, pluginKind(n) === 'gen' && genKind(n) === 'gen',
            `插件=${pluginKind(n)} 生成器=${genKind(n)}`);
    }
    // 反例：不得因为加了 qwen-image 而误伤普通名字
    ok('  反例：qwen-plus 仍是 text', pluginKind('qwen-plus') === 'text' && genKind('qwen-plus') === 'text');
    ok('  反例：qwen-vl-max 仍是 text（视觉不靠命名猜）',
        pluginKind('qwen-vl-max') === 'text' && genKind('qwen-vl-max') === 'text');
}
// ---------------------------------------------------------------- L. 专属 MaaS + 百炼原生：复现用户 400

console.log('\n=== L. 专属 MaaS 域名 + 百炼原生（复现并钉住 400 url error 的成因）===');

{
    // 用户真实场景：专属部署域名 + qwen-image-3.0-pro。
    // 报错 400 `url error, please check url！` —— 官方文档写明是"模型与端点不匹配"。
    // 成因链：专属域名反查不出 vendor → 配置里若不显式写 provider，
    //   插件用**通用/alibaba** 预设 → URL 变成 <原生路径>/images/generations → 端点错。
    // 这里把"必须显式写 provider=dashscope"以及"写了之后请求完全正确"都钉死。
    const HOST = 'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com';
    const NATIVE = HOST + '/api/v1/services/aigc/multimodal-generation/generation';

    ok('专属域名反查不出 vendor（所以必须手填/由模板写）', resolveVendor(HOST) === '', resolveVendor(HOST));

    const buildCfg = (provider) => gen.build([{
        id: 'c1', templateId: 'alibaba', mode: 'vendor', provider,
        api: 'openai-completions', baseURL: HOST, apiKey: 'sk-maas',
        models: [{ id: 'qwen-image', name: 'qwen-image-3.0-pro', kind: 'gen' }],
        enabled: true, displayName: '', timeout: 0, request: {},
    }], { 'image-generation': 'qwen-image' });

    // ---- A) 直接粘**完整原生端点**、不写 provider：靠路径反查救回来 ----
    // 这正是用户实际配置的形态（`baseURL` = 完整原生 URL，无 provider 字段）。
    // 原先 host 反查为空 → 退回通用预设 → 把 /images/generations 拼到原生路径后面
    // → 百炼 400 `url error`。现在 host 认不出时会按**vendor 独有的端点路径**再试一次。
    {
        const cfg = {
            version: 5,
            providers: [{
                api: 'openai-completions', baseURL: NATIVE, apiKey: 'sk-maas',
                models: [{ id: 'qwen-image-3-0-pro', name: 'qwen-image-3.0-pro', kind: 'gen' }],
            }],
            purposes: { 'image-generation': 'qwen-image-3-0-pro' },
        };
        ok('完整原生端点 + 无 provider：配置合法', validateV5Config(cfg).length === 0,
            JSON.stringify(validateV5Config(cfg)));
        const { conns } = adaptV5(cfg);
        ok('  靠**路径**反查出 vendor=dashscope', conns[0].provider === 'dashscope',
            JSON.stringify(conns[0].provider));

        const composed = composeMediaTemplate('image-generation', conns[0].provider, 'qwen-image-3.0-pro', 'qwen-image-3-0-pro');
        const url = resolveMediaUrl('image-generation', composed, NATIVE, s => String(s ?? ''));
        ok('  → URL 不再重复拼路径', url === NATIVE, url);
        ok('  → 没有 /generation/images 这种畸形尾段', !/generation\/images/.test(url), url);

        const meta = composed.params;
        const norm = normalizeMediaParams({}, templateParamKeys(composed), meta, {});
        const body = renderMediaBody(composed.body, {
            builtin: { model: 'qwen-image-3.0-pro', prompt: '蓝色大肥鱼', api_key: 'k' },
            params: norm.params, meta,
        }).body;
        ok('  → 请求体是原生形状', !!body.input && !!body.parameters, JSON.stringify(body));
        ok('  → data_path 是原生形状',
            composed.response?.data_path === 'output.choices.0.message.content.0.image',
            String(composed.response?.data_path));
    }

    // ---- B) 只给 host 根、不写 provider：路径信息不足，**仍然需要** provider ----
    // 这条说明「百炼原生」模板为什么必须把 provider 写进配置。
    {
        const bad = buildCfg('');
        ok('host 根 + 无 provider：配置里没有该字段', !('provider' in bad.providers[0]));
        const parsed = parseV5Config(gen.serialize(bad));
        const { conns } = adaptV5(parsed.config);
        ok('  路径信息不足 → vendor 仍为空', conns[0].provider === '',
            JSON.stringify(conns[0].provider));
        const composed = composeMediaTemplate('image-generation', conns[0].provider, 'qwen-image-3.0-pro', 'qwen-image');
        const url = resolveMediaUrl('image-generation', composed, HOST, s => String(s ?? ''));
        ok('  → URL 走错（拼成通用 /images/generations）', url !== NATIVE, url);
        ok('  → 这就是「百炼原生」模板必须写 provider 的原因', url === HOST + '/images/generations', url);
    }

    // ---- C) 反例：**共用的**通用路径不得被用来反查 vendor ----
    // `/images/generations` 被 7 个 vendor + 通用预设共用，据此反查会把自建网关误判成某一家。
    {
        ok('自建网关（无独有路径）不反查出 vendor',
            resolveVendor('https://my.host/v1') === '', resolveVendor('https://my.host/v1'));
        ok('自建网关 + 通用 /images/generations 也不反查',
            resolveVendor('https://my.host/images/generations') === '',
            resolveVendor('https://my.host/images/generations'));
        ok('自建网关 + 通用 /audio/speech 也不反查',
            resolveVendor('https://my.host/audio/speech') === '',
            resolveVendor('https://my.host/audio/speech'));
    }

    // ---- D) 正确配置：显式 provider=dashscope（由「百炼原生」模板写入）----
    {
        const good = buildCfg('dashscope');
        ok('写 provider=dashscope：字段进了配置', good.providers[0].provider === 'dashscope',
            String(good.providers[0].provider));
        ok('生成器自检通过', gen.validateConfig(good).length === 0, JSON.stringify(gen.validateConfig(good)));
        const parsed = parseV5Config(gen.serialize(good));
        ok('插件接受', parsed.config !== null, JSON.stringify(parsed.issues));

        const { conns } = adaptV5(parsed.config);
        ok('适配后 vendor = dashscope', conns[0].provider === 'dashscope', conns[0].provider);

        const composed = composeMediaTemplate('image-generation', 'dashscope', 'qwen-image-3.0-pro', 'qwen-image');
        const url = resolveMediaUrl('image-generation', composed, HOST, s => String(s ?? ''));
        ok('URL = 原生端点（与用户 v4 可用配置一致）', url === NATIVE, url);

        // 完整原生 URL 直接粘也不能拼两遍
        const url2 = resolveMediaUrl('image-generation', composed, NATIVE, s => String(s ?? ''));
        ok('直接粘完整原生 URL 也不重复拼路径', url2 === NATIVE, url2);

        // 请求体必须与用户原 v4 TOML 等价
        const meta = composed.params;
        const norm = normalizeMediaParams({}, templateParamKeys(composed), meta, {});
        const body = renderMediaBody(composed.body, {
            builtin: { model: 'qwen-image-3.0-pro', prompt: '蓝色大肥鱼', api_key: 'k' },
            params: norm.params, meta,
        }).body;
        ok('body.model 正确', body.model === 'qwen-image-3.0-pro');
        ok('body.input.messages 结构正确（原生形状）',
            body.input?.messages?.[0]?.content?.[0]?.text === '蓝色大肥鱼', JSON.stringify(body.input));
        ok('body.parameters.prompt_extend = true', body.parameters?.prompt_extend === true);
        ok('body.parameters.size 用原生 * 分隔（不是兼容模式的 x）',
            body.parameters?.size === '1024*1024', String(body.parameters?.size));
        ok('没有兼容模式才有的 prompt/顶层 size 字段',
            !('prompt' in body) && !('size' in body), JSON.stringify(body));
        ok('response.data_path 是原生形状',
            composed.response?.data_path === 'output.choices.0.message.content.0.image',
            String(composed.response?.data_path));
    }
}
// ---------------------------------------------------------------- M. vendor 判定必须两侧一致

console.log('\n=== M. vendor 判定：生成器与插件必须给出同一个答案 ===');

{
    // 两侧各有一套 vendor 识别（插件 host→vendor + 路径兜底；生成器同规则但表是手抄的）。
    // **它们必须一致** —— 不一致时生成器界面显示「未识别」而插件实际用了某 vendor，
    // 用户据此判断就会做错决定（本轮就踩过：显示"未识别"、插件却用 dashscope）。
    const genTpl = await import(pathToFileURL(path.join(genRoot, 'js', 'templates.js')).href);

    // M1) 手抄的路径表必须与插件**算出来的**那张逐条相同（双向）
    const pluginSuffixes = new Set(knownVendorSuffixes().map(([s, v]) => `${s}\t${v}`));
    const genSuffixes = new Set(genTpl.MEDIA_ENDPOINT_SUFFIXES.map(([s, v]) => `${s}\t${v}`));
    const missInGen = [...pluginSuffixes].filter(x => !genSuffixes.has(x));
    const extraInGen = [...genSuffixes].filter(x => !pluginSuffixes.has(x));
    ok(`生成器路径表覆盖插件的全部 ${pluginSuffixes.size} 条`, missInGen.length === 0,
        `缺：${missInGen.join(' / ')}`);
    ok('生成器路径表没有插件不认的条目', extraInGen.length === 0, `多：${extraInGen.join(' / ')}`);

    // M2) 逐 URL 比对两侧结论（这是真正的"一致性"断言）
    const urls = [
        // 官方地址
        'https://api.deepseek.com/v1',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'https://dashscope.aliyuncs.com',
        'https://open.bigmodel.cn/api/paas/v4',
        'https://api.siliconflow.cn/v1',
        // 专属部署（host 认不出、路径能认出）
        'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com',
        // 其它 vendor 独有路径
        'https://x.example/v2beta/stable-image/generate/ultra',
        'https://x.example/v1beta1/text:synthesize',
        'https://x.example/api/open/v3/speech/tts',
        'https://x.example/t2a_v2',
        // 自建网关 / 共用路径（都不该被反查出来）
        'https://my.host/v1',
        'https://my.host/images/generations',
        'https://my.host/audio/speech',
        'https://my.host/api/v1/services/aigc/multimodal-generation/generation?x=1',
        // 边界
        '',
        'not-a-url',
    ];
    const disagree = [];
    for (const u of urls) {
        const g = genTpl.resolveVendorFromUrl(u);
        const p = resolveVendor(u);
        if (g !== p) disagree.push(`${JSON.stringify(u)}: 生成器=${JSON.stringify(g)} 插件=${JSON.stringify(p)}`);
    }
    ok(`两侧对 ${urls.length} 个 URL 的 vendor 判定一致`, disagree.length === 0, disagree.join('； '));

    // M3) 关键个案（防上面整体通过但关键项悄悄错）
    const MAAS = 'https://llm-w67ttc0b3gqiltm8.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
    ok('  专属完整端点 → 两侧都判 dashscope',
        genTpl.resolveVendorFromUrl(MAAS) === 'dashscope' && resolveVendor(MAAS) === 'dashscope');
    ok('  共用路径 /images/generations → 两侧都不反查',
        genTpl.resolveVendorFromUrl('https://my.host/images/generations') === ''
        && resolveVendor('https://my.host/images/generations') === '');
    ok('  查询串不影响路径判定',
        genTpl.resolveVendorFromUrl(MAAS + '?a=1') === 'dashscope'
        && resolveVendor(MAAS + '?a=1') === 'dashscope');

    // M4) 生成器选模板时该不该写 provider，与插件"能否反查出该 vendor"必须吻合
    //     （写了 = 因为反查不回自己；不写 = 因为反查得到）
    for (const t of tpl.PROVIDER_TEMPLATES.filter(x => x.id !== 'custom')) {
        const needWrite = resolveVendor(t.baseUrl) !== t.provider;
        const writes = genTpl.providerForTemplate(t) !== '';
        ok(`  模板 ${t.id}：${needWrite ? '必须写' : '不写'} provider，实际${writes ? '写了' : '不写'}`,
            needWrite === writes,
            `插件反查=${resolveVendor(t.baseUrl)} 模板 provider=${t.provider} 生成器写=${writes}`);
    }
}
// ---------------------------------------------------------------- N. 响应格式：生成器产出 → 插件接住

console.log('\n=== N. 「响应格式」编辑区的产出必须被插件完整接住 ===');

{
    // 生成器的「响应格式」结构化表单写出的就是这一组键。这里用**生成器实际会产出的形状**
    // 过一遍插件：校验 → 适配 → 合成模板，确认没有一个键在途中掉掉。
    const respBlock = {
        data_path: 'output.choices.0.message.content.0.image',
        data_type: 'url',
        error_message_path: 'error.message',
        task_id_path: 'output.task_id',
        task_status_path: 'output.task_status',
        success_values: ['OK', 'DONE'],
        failure_values: ['BAD'],
        poll_url: 'https://x.example/api/tasks/{task_id}',
        poll_interval: 5,
        poll_max: 30,
    };
    const cfg = {
        version: 5,
        providers: [{
            api: 'openai-completions', baseURL: 'https://x.example/v1', apiKey: 'sk-x',
            models: [{
                id: 'm', name: 'qwen-image-3.0-pro', kind: 'gen',
                request: { body: { model: '{model}', prompt: '{prompt}' }, response: respBlock },
            }],
        }],
        purposes: { 'image-generation': 'm' },
    };

    ok('配置合法', validateV5Config(cfg).length === 0, JSON.stringify(validateV5Config(cfg)));
    const { rules } = adaptV5(cfg);
    const rule = rules.find(r => Array.isArray(r.models) && r.models.includes('m'));
    ok('per-model request 变成 models 定向规则', !!rule, JSON.stringify(rules));
    ok('response 整块进了规则', !!rule && !!rule.response, JSON.stringify(rule && rule.response));

    if (rule && rule.response) {
        const got = rule.response;
        for (const k of Object.keys(respBlock)) {
            const same = JSON.stringify(got[k]) === JSON.stringify(respBlock[k]);
            ok(`  ${k} 原样保留`, same, `期望 ${JSON.stringify(respBlock[k])} 实得 ${JSON.stringify(got[k])}`);
        }
        ok('  success_values 仍是数组（不是被拆成字符串）', Array.isArray(got.success_values),
            JSON.stringify(got.success_values));
        ok('  poll_interval 仍是数字', typeof got.poll_interval === 'number', typeof got.poll_interval);
    }

    // 合成模板后 response 要能被取到（插件读的是 composed.response）
    setRuleRows(rules);
    const composed = composeMediaTemplate('image-generation', '', 'qwen-image-3.0-pro', 'm');
    ok('composeMediaTemplate 拿到 response', !!composed.response, JSON.stringify(composed.response));
    ok('  data_path 正确', composed.response?.data_path === respBlock.data_path,
        String(composed.response?.data_path));
    ok('  poll_url 正确', composed.response?.poll_url === respBlock.poll_url,
        String(composed.response?.poll_url));
    resetRuleRowsForTest();

    // 反例：**含 null 的数值**不得被当成 0 —— 插件侧 numOrDefault 兜住（见插件单测），
    // 这里只确认这种配置本身是**合法**的（不会被校验拒），从而必须靠运行时兜底。
    const withNull = JSON.parse(JSON.stringify(cfg));
    withNull.providers[0].models[0].request.response.poll_interval = null;
    ok('含 null 数值的配置仍合法（故运行时必须兜底）', validateV5Config(withNull).length === 0,
        JSON.stringify(validateV5Config(withNull)));
}
// ---------------------------------------------------------------- O. 用途绑定的**有序数组**

console.log('\n=== O. purposes 有序数组：生成器产出 → 插件按顺序取用 ===');

{
    // 生成器把 purposes 写成数组（顺序 = 用户点卡片的顺序）。
    // 插件必须：① 接受数组 ② 按这个顺序排候选 ③ 首选取 [0] ④ 回退顺着往后走。
    const cfg = {
        version: 5,
        providers: [
            {
                api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-a',
                models: [
                    { id: 'chat-a', name: 'deepseek-chat', kind: 'text' },
                    { id: 'chat-b', name: 'deepseek-reasoner', kind: 'text' },
                ],
            },
            {
                api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', apiKey: 'sk-b',
                models: [{ id: 'chat-c', name: 'kimi-k2', kind: 'text' }],
            },
        ],
        // 故意与连接/列表顺序**相反**，这样"顺序是否真被采纳"才可证伪
        purposes: { chat: ['chat-c', 'chat-a'] },
    };

    ok('含数组 purposes 的配置合法', validateV5Config(cfg).length === 0,
        JSON.stringify(validateV5Config(cfg)));

    // 单字符串（手写配置）也要接受，并归一为单元素数组
    const legacy = JSON.parse(JSON.stringify(cfg));
    legacy.purposes = { chat: 'chat-b' };
    ok('单字符串 purposes 仍合法（归一为单元素数组）', validateV5Config(legacy).length === 0,
        JSON.stringify(validateV5Config(legacy)));

    // 引用不存在的模型 → 整份拒绝，且报错路径带数组下标
    const bad = JSON.parse(JSON.stringify(cfg));
    bad.purposes = { chat: ['nope', 'chat-a'] };
    const badIssues = validateV5Config(bad);
    ok('引用不存在的模型 → 整份拒绝', badIssues.length > 0, JSON.stringify(badIssues));
    ok('  报错路径带数组下标 $.purposes.chat[0]',
        badIssues.some(x => x.path === '$.purposes.chat[0]'),
        JSON.stringify(badIssues.map(x => x.path)));

    // 数组里混入非字符串 → 拒绝
    const badType = JSON.parse(JSON.stringify(cfg));
    badType.purposes = { chat: [123] };
    ok('数组里混入非字符串 → 拒绝', validateV5Config(badType).length > 0,
        JSON.stringify(validateV5Config(badType)));

    // ---- 归一化：数组保序、单字符串变单元素数组。
    // 注意 adaptV5 **不返回 purposes**（它只管 conns/rules）；用途归一在 configs/model.ts
    // 的 fromV5 里做。这里测的是同一套规则的导出函数 purposeBindings。
    ok('purposeBindings 返回数组且保序',
        JSON.stringify(purposeBindings(cfg, 'chat')) === '["chat-c","chat-a"]',
        JSON.stringify(purposeBindings(cfg, 'chat')));
    ok('  单字符串 → 单元素数组',
        JSON.stringify(purposeBindings(legacy, 'chat')) === '["chat-b"]',
        JSON.stringify(purposeBindings(legacy, 'chat')));
    ok('  未绑定用途 → 空数组',
        JSON.stringify(purposeBindings(cfg, 'tts')) === '[]',
        JSON.stringify(purposeBindings(cfg, 'tts')));
    ok('  normalizePurposeList 去重',
        JSON.stringify(normalizePurposeList(['a', 'a', 'b'])) === '["a","b"]',
        JSON.stringify(normalizePurposeList(['a', 'a', 'b'])));
    ok('  normalizePurposeList 与生成器同规则',
        JSON.stringify(normalizePurposeList([' a ', '', 'b'])) === JSON.stringify(gen.normalizePurposeList([' a ', '', 'b'])),
        JSON.stringify(normalizePurposeList([' a ', '', 'b'])) + ' vs ' + JSON.stringify(gen.normalizePurposeList([' a ', '', 'b'])));
}

// ---------------------------------------------------------------- C. 四个内容分区

console.log('\n=== C. 角色 / 技能 / MCP / 知识库：生成器产出 → 插件解析 ===');
{
    const specs = Object.fromEntries(genDomain.DOMAIN_SPECS.map(s => [s.id, s]));
    const pluginParsers = {
        roles: parseRolesConfig,
        skills: parseSkillsConfig,
        mcp: parseMcpConfig,
        kb: parseKbConfig,
    };
    const pluginDefaults = {
        roles: DEFAULT_ROLES,
        skills: DEFAULT_SKILLS,
        mcp: DEFAULT_MCP,
        kb: DEFAULT_KB,
    };
    const collections = { roles: 'roles', skills: 'skills', mcp: 'servers', kb: 'libraries' };
    const listsOf = (id, cfg) => (id === 'mcp' ? cfg.servers : cfg[collections[id]]);
    const stripEnabled = (item) => {
        const copy = JSON.parse(JSON.stringify(item));
        delete copy.enabled;
        return copy;
    };
    /** 生成器内部字段是 platform，插件运行时字段是 platforms */
    const toPluginShape = (item) => {
        const copy = stripEnabled(item);
        if (copy.platform !== undefined) {
            copy.platforms = copy.platform;
            delete copy.platform;
        }
        return copy;
    };

    for (const id of ['roles', 'skills', 'mcp', 'kb']) {
        const spec = specs[id];
        ok(`${id}：生成器存在该分区`, !!spec);
        if (!spec) continue;

        const genItems = spec.defaults.map(x => spec.normalizeItem(x));
        const built = spec.build(genItems);
        const json = JSON.stringify(built);
        const parsed = pluginParsers[id](json);
        ok(`${id}：生成器默认产出被插件接受`, !!parsed.config, JSON.stringify(parsed.issues));
        const list = parsed.config ? listsOf(id, parsed.config) : [];
        ok(`${id}：默认条数一致`, list.length === spec.defaults.length,
            `生成器 ${spec.defaults.length} / 插件 ${list.length}`);
        ok(`${id}：两边默认数据一致`,
            isDeepStrictEqual(genItems.map(toPluginShape), pluginDefaults[id].map(stripEnabled)),
            JSON.stringify(genItems.map(toPluginShape)).slice(0, 200));

        const disabled = spec.build(genItems.map(item => ({ ...item, enabled: false })));
        const disabledList = id === 'mcp' ? Object.keys(disabled.mcpServers) : disabled[collections[id]];
        ok(`${id}：停用后不写进生成配置`, disabledList.length === 0, JSON.stringify(disabledList));

        const invalid = {
            roles: '{"version":1,"roles":[{"name":"","prompt":"x"}]}',
            skills: '{"version":1,"skills":[{"name":"","content":"x"}]}',
            mcp: '{"mcpServers":{"x":{"url":"ftp://x"}}}',
            kb: '{"version":1,"libraries":[{"name":"","content":"x"}]}',
        }[id];
        const genInvalid = spec.parseImport(invalid);
        const pluginInvalid = pluginParsers[id](invalid);
        ok(`${id}：非法样例两边都拒绝`, !genInvalid.ok && !pluginInvalid.config,
            `generator=${JSON.stringify(genInvalid)} plugin=${JSON.stringify(pluginInvalid.issues)}`);
    }
}

console.log(`\n===== 联测：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
