/**
 * 加载冒烟测试：用 seal 桩（Proxy 兜底）在 Node 中直接加载打包产物，
 * 用于在无 SealDice 环境下提前发现加载期的 ReferenceError/TypeError。
 * 用法：npm run build && npm run smoke
 */
const noop = () => undefined;

function makeExt(name) {
    return {
        name: name || '',
        cmdMap: {},
        storageGet: () => undefined,
        storageSet: noop,
        getTemplateConfig: () => [],
        getIntConfig: () => 0,
        getBoolConfig: () => true,
        getStringConfig: () => '',
        getOptionConfig: () => '',
        getFloatConfig: () => 0,
    };
}

const sealStub = {
    ext: {
        find: () => undefined,
        new: (name, author, version) => {
            const e = makeExt(name);
            e.author = author;
            e.version = version;
            return e;
        },
        register: noop,
        registerTemplateConfig: noop,
        registerIntConfig: noop,
        registerBoolConfig: noop,
        registerStringConfig: noop,
        registerOptionConfig: noop,
        registerFloatConfig: noop,
        getTemplateConfig: () => [],
        getIntConfig: () => 0,
        getBoolConfig: () => true,
        getStringConfig: () => '',
        getOptionConfig: () => '',
        getFloatConfig: () => 0,
        newCmdItemInfo: () => ({ cmdMap: {}, allowDelegate: true, solve: noop }),
        newCmdExecuteResult: () => ({}),
        getCtxProxyFirst: (ctx) => ctx,
    },
    vars: {},
    format: (ctx, text) => String(text || ''),
    formatTmpl: (ctx, text) => String(text || ''),
    replyToSender: noop,
    base64ToImage: (s) => s,
    getCtxProxyFirst: (c) => c,
};

// 兜底：访问任何未定义属性时返回 noop 函数
globalThis.seal = new Proxy(sealStub, {
    get(t, p) { return p in t ? t[p] : noop; },
    set(t, p, v) { t[p] = v; return true; },
});

try {
    require('../dist/aiplugin4.js');
    console.log('SMOKE OK: 插件加载无异常');

    // 校验对外 API：globalThis.aiplugin4 已暴露且方法齐全
    const api = globalThis.aiplugin4;
    const apiChecks = {
        'globalThis.aiplugin4 存在': !!api,
        'Agent 类': !!api && typeof api.Agent === 'function',
        'getAgent 方法': !!api && typeof api.getAgent === 'function',
        'getSession 方法': !!api && typeof api.getSession === 'function',
        'chat 方法': !!api && typeof api.chat === 'function',
        'run 方法': !!api && typeof api.run === 'function',
        'getAgent(*) 返回智能体实例': !!api && typeof api.getAgent('*').chat === 'function',
    };
    const failedChecks = Object.entries(apiChecks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failedChecks.length > 0) {
        console.error('SMOKE FAIL(api):', failedChecks.join(', '));
        process.exit(1);
    }
    console.log('SMOKE OK: globalThis.aiplugin4 API 可用');
} catch (e) {
    console.error('SMOKE FAIL:', e.message);
    console.error(e.stack);
    process.exit(1);
}
