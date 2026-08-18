const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/session/tool_listen.ts');
if (!fs.existsSync(sourcePath)) {
    throw new Error('缺少 src/session/tool_listen.ts：监听器尚未实现');
}

const source = fs.readFileSync(sourcePath, 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2017,
    },
}).outputText;
const transpiledModule = { exports: {} };
new Function('require', 'module', 'exports', output)(require, transpiledModule, transpiledModule.exports);

const { createToolListen } = transpiledModule.exports;
if (typeof createToolListen !== 'function') {
    throw new Error('createToolListen 未导出');
}

async function testResolveDispatchesToWaiter() {
    const listen = createToolListen();
    const resultPromise = listen.waitFor(200, 0, 1);
    listen.resolve('扩展回复');
    const result = await resultPromise;
    if (result.length !== 1 || result[0] !== '扩展回复') {
        throw new Error(`resolve 未投递消息: ${JSON.stringify(result)}`);
    }
}

async function testRehydratedRuntimeListener() {
    const persisted = JSON.parse(JSON.stringify({ timeoutId: null }));
    const restored = createToolListen();
    restored.timeoutId = persisted.timeoutId;
    const resultPromise = restored.waitFor(200, 0, 1);
    restored.resolve('恢复后的扩展回复');
    const result = await resultPromise;
    if (result.length !== 1 || result[0] !== '恢复后的扩展回复') {
        throw new Error(`恢复后的 listener 无法接收消息: ${JSON.stringify(result)}`);
    }
}

async function testPushSupportsMultipleWaiters() {
    const listen = createToolListen();
    const first = listen.waitFor(200, 0, 2);
    const second = listen.waitFor(200, 0, 2);
    listen.push('第一条');
    listen.push('第二条');
    const results = await Promise.all([first, second]);
    for (const result of results) {
        if (result.join('|') !== '第一条|第二条') {
            throw new Error(`并发等待器收到的消息不完整: ${JSON.stringify(results)}`);
        }
    }
}

Promise.all([testResolveDispatchesToWaiter(), testPushSupportsMultipleWaiters(), testRehydratedRuntimeListener()])
    .then(() => console.log('TOOL LISTEN TEST OK'))
    .catch(error => {
        console.error('TOOL LISTEN TEST FAIL:', error.message);
        process.exitCode = 1;
    });
