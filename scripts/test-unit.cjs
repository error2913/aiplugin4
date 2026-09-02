/* 提示词/上下文构建单元测试 runner。
 * 纯 Node 环境：不打起 SealDice/QQ，用最小 seal 桩 + 可覆盖的 __TEST_CONFIG__ 运行
 * scripts/unit-test-entry.ts 里的全部单测（esbuild 打包成 CJS 后 require）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-unit-'));
const bundle = path.join(outDir, 'unit.cjs');

// 测试可覆盖的配置值（unit-test-entry.ts 通过 globalThis.__TEST_CONFIG__ 读写）
const TC = {
    intConfigs: {},      // 整数配置覆盖，如 上下文最大token
    boolConfigs: {},     // 布尔配置覆盖，如 切换为提示词工程
    stringConfigs: {},
    optionConfigs: {},
    floatConfigs: {},
    templateConfigs: {}
};

// 模板配置默认值：模型类返回空数组避免 TOML 解析；其余返回空条目
const TEMPLATE_DEFAULTS = {
    '纯文本模型': [],
    '多模态模型': [],
    '嵌入模型': [],
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
        registerStringConfig: () => undefined,
        registerOptionConfig: () => undefined,
        registerTemplateConfig: () => undefined,
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
    replyToSender: () => undefined
};
globalThis.__TEST_CONFIG__ = TC;

(async () => {
    await esbuild.build({
        entryPoints: [path.join(repo, 'scripts/unit-test-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent'
    });

    const entry = require(bundle);
    const names = Object.keys(entry.tests);
    if (names.length === 0) throw new Error('未发现任何单元测试');
    for (const name of names) {
        await entry.tests[name]();
        console.log('PASS', name);
    }
    console.log(`全部 ${names.length} 个单元测试通过`);
})().finally(() => fs.rmSync(outDir, { recursive: true, force: true })).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
