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
        'registerTool 方法': !!api && typeof api.registerTool === 'function',
        'registerTool 注册成功': !!api && api.registerTool({
            type: 'function',
            function: {
                name: 'smoke_api_tool',
                description: 'smoke test tool',
                parameters: { type: 'object', properties: {} }
            }
        }, { solve: async () => 'ok' }) === true,
        'getAgent(*) 返回智能体实例': !!api && typeof api.getAgent('*').chat === 'function',
        'registerPromptSection 方法': !!api && typeof api.registerPromptSection === 'function',
        'onPromptAssemble 方法': !!api && typeof api.onPromptAssemble === 'function',
        'registerPromptSection 扩展段注册成功': !!api && api.registerPromptSection({
            name: 'ext:smoke:test',
            order: 10000,
            channel: 'system',
            build: () => 'smoke section'
        }) === true,
    };
    const failedChecks = Object.entries(apiChecks).filter(([, ok]) => !ok).map(([name]) => name);
    if (failedChecks.length > 0) {
        console.error('SMOKE FAIL(api):', failedChecks.join(', '));
        process.exit(1);
    }
    console.log('SMOKE OK: globalThis.aiplugin4 API 可用');
    // 冒烟只验证加载与 API：进程可能因底层 fetch keep-alive 套接字而无法自然退出，显式结束
    process.exit(0);
} catch (e) {
    console.error('SMOKE FAIL:', e.message);
    console.error(e.stack);
    process.exit(1);
}
