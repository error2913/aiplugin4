/* 单元测试 runner：纯 Node 环境，不打起 SealDice/QQ。
 * 用最小 seal 桩 + 可覆盖的 __TEST_CONFIG__ 运行打包后的测试入口（esbuild CJS）。
 * - scripts/unit-test-entry.ts：提示词/上下文/工具等既有单测
 * - scripts/unit-test-subagent.ts：子代理机制层单测（不依赖 seal）
 * 可选：UNIT_FILTER=<子串> 只跑名字含该子串的用例，便于迭代。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-unit-'));
const bundles = {
    main: path.join(outDir, 'unit-main.cjs'),
    subagent: path.join(outDir, 'unit-subagent.cjs'),
    v5: path.join(outDir, 'unit-v5.cjs'),
    web: path.join(outDir, 'unit-web.cjs'),
};

// 测试可覆盖的配置值（unit-test-entry.ts 通过 globalThis.__TEST_CONFIG__ 读写）
const TC = {
    intConfigs: {},
    boolConfigs: {},
    stringConfigs: {},
    optionConfigs: {},
    floatConfigs: {},
    templateConfigs: {},
    // 出厂默认模板框（registerTemplateConfig 登记的内容）：供"默认配置能解析"类用例校验
    factoryTemplateConfigs: {},
    // 出厂默认字符串配置（registerStringConfig 登记的内容）：v5 的「模型配置」在这里
    factoryStringConfigs: {}
};

// 模板配置默认值：模型类返回空数组避免 TOML 解析；其余返回空条目
// 注：'api连接'/'模型规则' 已是**废弃**项，仅用于迁移读取，故默认为空（不触发迁移）。
const TEMPLATE_DEFAULTS = {
    'api连接': [],
    '模型规则': [],
    '角色扮演设定': ['测试机器人\n你是测试角色'],
    '预设上下文': [''],
    '技能配置': [''],
    '知识库': [],
    '可调用指令白名单': [''],
    'MCP服务器配置': [],
    '音乐服务配置': []
};

// 最小 SealDice 表面：覆盖模块初始化与测试运行期间可能触达的 seal API
globalThis.seal = {
    ext: {
        find: () => undefined,
        new: () => ({ storageGet: () => '', storageSet: () => undefined }),
        register: () => undefined,
        registerBoolConfig: () => undefined,
        registerIntConfig: () => undefined,
        registerFloatConfig: () => undefined,
        registerStringConfig: (_ext, key, value) => { TC.factoryStringConfigs[key] = value; },
        registerOptionConfig: () => undefined,
        registerTemplateConfig: (_ext, key, values) => { TC.factoryTemplateConfigs[key] = values; },
        getTemplateConfig: (_ext, key) => {
            if (TC.templateConfigs[key] !== undefined) return TC.templateConfigs[key];
            if (TEMPLATE_DEFAULTS[key] !== undefined) return TEMPLATE_DEFAULTS[key];
            return [''];
        },
        getBoolConfig: (_ext, key) => TC.boolConfigs[key] ?? true,
        getIntConfig: (_ext, key) => TC.intConfigs[key] ?? 0,
        getFloatConfig: (_ext, key) => TC.floatConfigs[key] ?? 0,
        getStringConfig: (_ext, key) => TC.stringConfigs[key] ?? '',
        getOptionConfig: (_ext, key) => TC.optionConfigs[key] ?? '信息',
        storageGet: () => '',
        storageSet: () => undefined
    },
    vars: {
        strGet: () => ['', false],
        intGet: () => [0, false],
        strSet: () => undefined,
        intSet: () => undefined
    },
    formatTmpl: (_ctx, key) => key === '核心:骰子名字' ? '骰娘' : '',
    newMessage: () => ({ sender: {}, messageType: 'group', segment: [] }),
    getEndPoints: () => [],
    createTempCtx: () => ({}),
    replyToSender: () => undefined,
    // base64 媒体落盘：测试里返回确定性本地路径（Image.CQCode 与语音落地都依赖它）
    base64ToImage: (b64) => `/tmp/aiplugin4-test-media-${String(b64 ?? '').length}.bin`
};
globalThis.__TEST_CONFIG__ = TC;

(async () => {
    const entries = [
        ['main', path.join(repo, 'scripts/unit-test-entry.ts')],
        ['subagent', path.join(repo, 'scripts/unit-test-subagent.ts')],
        ['v5', path.join(repo, 'scripts/unit-test-v5.ts')],
        ['web', path.join(repo, 'scripts/unit-test-web.ts')]
    ];
    const all = {};
    for (const [name, entryPoint] of entries) {
        await esbuild.build({
            entryPoints: [entryPoint],
            bundle: true,
            platform: 'node',
            format: 'cjs',
            outfile: bundles[name],
            logLevel: 'silent'
        });
        const mod = require(bundles[name]);
        for (const key of Object.keys(mod.tests)) {
            if (all[key] !== undefined) throw new Error(`重复的单元测试名: ${key}`);
            all[key] = mod.tests[key];
        }
    }

    const filter = process.env.UNIT_FILTER;
    const names = Object.keys(all).filter(n => !filter || n.includes(filter));
    if (names.length === 0) throw new Error('未发现任何单元测试（或 UNIT_FILTER 无匹配）');
    for (const name of names) {
        await all[name]();
        console.log('PASS', name);
    }
    console.log(`全部 ${names.length} 个单元测试通过`);
})().finally(() => fs.rmSync(outDir, { recursive: true, force: true })).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
