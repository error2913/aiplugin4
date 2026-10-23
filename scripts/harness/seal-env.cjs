'use strict';
// 测试环境单一事实源：SealDice 最小桩（globalThis.seal）+ 可覆盖配置（globalThis.__TEST_CONFIG__）。
// 供 test-unit / sim / sim-matrix / fuzz / test-ob11-runtime 共用；新增 seal API 或配置读取语义
// 只需改本文件，避免 5 份桩逐渐漂移。
//
// 用法：
//   const { installSealEnv } = require('./harness/seal-env');
//   const TC = installSealEnv({ preset: 'sim', base64Prefix: '/tmp/aiplugin4-sim-media-' });
// 测试入口（TS）通过 globalThis.__TEST_CONFIG__ 读写；preset 提供默认配置与模板默认值。

/** sim / sim-matrix / fuzz 共用的初始配置（贴近真实运行的上下文/待机参数） */
const SIM_INT_CONFIGS = {
    '上下文最大token': 1000000,
    '对话保存轮数': 5,
    '插入system message间隔轮数': 0,
    '消息压缩阈值': 2000,
    '冷态窗口字数': 5000,
    '冷态单条截断字数': 500,
    '窗口上限字数': 20000,
    '结算水位': 3000,
    '结算最小门槛': 20000,
    '结算空闲门槛': 600,
    '单次结算调用上限': 2,
    '原文分片保留天数': 30,
    '原文分片上限': 200,
    '待机入库配额': 0,
};

const SIM_BOOL_CONFIGS = {
    '归档保留原文': true,
    '是否开启全局待机': false,
    '切换为提示词工程': false,
    '启用长期记忆': false,
};

/** sim 系列模板默认值（角色/上下文/技能等已改 JSON 的项给空数组） */
const SIM_TEMPLATE_DEFAULTS = {
    '角色扮演设定': ['测试机器人\n你是测试角色'],
    '预设上下文': [''],
    '技能配置': [''],
    '知识库': [],
    '可调用指令白名单': [''],
    'MCP服务器配置': [],
    '音乐服务配置': [],
};

/** 单测模板默认值：模型类返回空数组避免 TOML 解析；'api连接'/'模型规则' 是废弃迁移读取项 */
const UNIT_TEMPLATE_DEFAULTS = {
    'api连接': [],
    '模型规则': [],
    '预设上下文': [''],
    '可调用指令白名单': [''],
    '音乐服务配置': [],
};

function createTestConfig(seed = {}) {
    return {
        intConfigs: {},
        boolConfigs: {},
        stringConfigs: {},
        optionConfigs: {},
        floatConfigs: {},
        templateConfigs: {},
        factoryTemplateConfigs: {},
        factoryStringConfigs: {},
        ...seed,
    };
}

/** 标准 ext 桩：配置读写走 __TEST_CONFIG__，命令注册提供最小表面 */
function standardExt(TC, templateDefaults) {
    return {
        find: () => undefined,
        new: () => ({ storageGet: () => '', storageSet: () => undefined, cmdMap: {} }),
        register: () => undefined,
        // 根命令注册链路（registerAllCmds → registerCmd）需要的最小表面
        newCmdItemInfo: () => ({ name: '', help: '', allowDelegate: false, solve: () => undefined }),
        newCmdExecuteResult: (success) => ({ success: !!success, showHelp: false }),
        registerBoolConfig: () => undefined,
        registerIntConfig: () => undefined,
        registerFloatConfig: () => undefined,
        registerStringConfig: (_ext, key, value) => { TC.factoryStringConfigs[key] = value; },
        registerOptionConfig: () => undefined,
        registerTemplateConfig: (_ext, key, values) => { TC.factoryTemplateConfigs[key] = values; },
        getTemplateConfig: (_ext, key) => {
            if (TC.templateConfigs[key] !== undefined) return TC.templateConfigs[key];
            if (templateDefaults[key] !== undefined) return templateDefaults[key];
            return [''];
        },
        getBoolConfig: (_ext, key) => TC.boolConfigs[key] ?? true,
        getIntConfig: (_ext, key) => TC.intConfigs[key] ?? 0,
        getFloatConfig: (_ext, key) => TC.floatConfigs[key] ?? 0,
        getStringConfig: (_ext, key) => TC.stringConfigs[key] ?? '',
        getOptionConfig: (_ext, key) => TC.optionConfigs[key] ?? '信息',
        storageGet: () => '',
        storageSet: () => undefined,
    };
}

/**
 * 安装测试环境（写入 globalThis.seal 与 globalThis.__TEST_CONFIG__），返回 TC 便于断言。
 * @param {object} [options]
 * @param {'unit'|'sim'|'ob11-runtime'} [options.preset] 默认配置/模板默认值来源
 * @param {object} [options.config] 自定义 TC（覆盖 preset）
 * @param {object} [options.templateDefaults]
 * @param {string} [options.base64Prefix] base64ToImage 落盘路径前缀（各 harness 保持原路径）
 * @param {object} [options.ext] ext 桩方法覆盖（如 ob11-runtime 的固定返回值）
 * @param {Function} [options.replyToSender] 发送桩（ob11-runtime 用于收集 sent）
 * @param {Function} [options.base64ToImage] 自定义 base64 落盘
 */
function installSealEnv(options = {}) {
    const preset = options.preset || 'unit';
    const config = options.config || (preset === 'sim'
        ? createTestConfig({ intConfigs: { ...SIM_INT_CONFIGS }, boolConfigs: { ...SIM_BOOL_CONFIGS } })
        : createTestConfig());
    const templateDefaults = options.templateDefaults
        || (preset === 'sim' ? SIM_TEMPLATE_DEFAULTS : UNIT_TEMPLATE_DEFAULTS);
    const base64Prefix = options.base64Prefix || '/tmp/aiplugin4-test-media-';

    globalThis.seal = {
        ext: { ...standardExt(config, templateDefaults), ...(options.ext || {}) },
        vars: {
            strGet: () => ['', false],
            intGet: () => [0, false],
            strSet: () => undefined,
            intSet: () => undefined,
        },
        formatTmpl: (_ctx, key) => (key === '核心:骰子名字' ? '骰娘' : ''),
        newMessage: () => ({ sender: {}, messageType: 'group', segment: [] }),
        getEndPoints: () => [],
        createTempCtx: () => ({}),
        replyToSender: options.replyToSender || (() => undefined),
        base64ToImage: options.base64ToImage
            || ((b64) => `${base64Prefix}${String(b64 ?? '').length}.bin`),
        ...(options.seal || {}),
    };
    globalThis.__TEST_CONFIG__ = config;
    return config;
}

module.exports = { installSealEnv, createTestConfig };
