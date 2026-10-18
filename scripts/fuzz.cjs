/* 随机化 fuzz runner：与 sim/sim-matrix 同套 seal 桩与生产默认配置。
 * 用法：npm run fuzz
 *      FUZZ_SEEDS=200 FUZZ_ROUNDS=100 npm run fuzz   # 加量
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const entry = path.join(__dirname, 'fuzz-entry.ts');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-fuzz-'));
const bundle = path.join(outDir, 'fuzz.cjs');

const TC = {
    intConfigs: {
        '上下文最大token': 1000000, '对话保存轮数': 5, '插入system message间隔轮数': 0,
        '消息压缩阈值': 2000, '冷态窗口字数': 5000, '冷态单条截断字数': 500,
        '窗口上限字数': 20000, '结算水位': 3000, '结算最小门槛': 20000,
        '结算空闲门槛': 600, '单次结算调用上限': 2,
        '原文分片保留天数': 30, '原文分片上限': 200, '待机入库配额': 0,
    },
    boolConfigs: {
        '归档保留原文': true, '是否开启全局待机': false,
        '切换为提示词工程': false, '启用长期记忆': false,
    },
    stringConfigs: {}, optionConfigs: {}, floatConfigs: {}, templateConfigs: {},
    factoryTemplateConfigs: {}, factoryStringConfigs: {},
};

const TEMPLATE_DEFAULTS = {
    '角色扮演设定': ['测试机器人\n你是测试角色'],
    '预设上下文': [''], '技能配置': [''], '知识库': [],
    '可调用指令白名单': [''], 'MCP服务器配置': [], '音乐服务配置': [],
};

globalThis.seal = {
    ext: {
        find: () => undefined,
        new: () => ({ storageGet: () => '', storageSet: () => undefined }),
        register: () => undefined,
        registerBoolConfig: () => undefined,
        registerIntConfig: () => undefined,
        registerFloatConfig: () => undefined,
        registerStringConfig: (_e, k, v) => { TC.factoryStringConfigs[k] = v; },
        registerOptionConfig: () => undefined,
        registerTemplateConfig: (_e, k, v) => { TC.factoryTemplateConfigs[k] = v; },
        getTemplateConfig: (_e, k) => {
            if (TC.templateConfigs[k] !== undefined) return TC.templateConfigs[k];
            if (TEMPLATE_DEFAULTS[k] !== undefined) return TEMPLATE_DEFAULTS[k];
            return [''];
        },
        getBoolConfig: (_e, k) => TC.boolConfigs[k] ?? true,
        getIntConfig: (_e, k) => TC.intConfigs[k] ?? 0,
        getFloatConfig: (_e, k) => TC.floatConfigs[k] ?? 0,
        getStringConfig: (_e, k) => TC.stringConfigs[k] ?? '',
        getOptionConfig: (_e, k) => TC.optionConfigs[k] ?? '信息',
        storageGet: () => '', storageSet: () => undefined,
    },
    vars: { strGet: () => ['', false], intGet: () => [0, false], strSet: () => undefined, intSet: () => undefined },
    formatTmpl: (_c, k) => k === '核心:骰子名字' ? '骰娘' : '',
    newMessage: () => ({ sender: {}, messageType: 'group', segment: [] }),
    getEndPoints: () => [], createTempCtx: () => ({}), replyToSender: () => undefined,
    base64ToImage: (b64) => `/tmp/aiplugin4-fuzz-media-${String(b64 ?? '').length}.bin`,
};
globalThis.__TEST_CONFIG__ = TC;

(async () => {
    await esbuild.build({
        entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
        outfile: bundle, logLevel: 'warning',
    });
    require(bundle);
})().catch(e => { console.error('fuzz 构建失败：', e.message); process.exit(1); });
