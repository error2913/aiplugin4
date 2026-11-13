/* 单元测试 runner：纯 Node 环境，不打起 SealDice/QQ。
 * 用最小 seal 桩 + 可覆盖的 __TEST_CONFIG__ 运行打包后的测试入口（esbuild CJS）。
 *
 * 设计要点（性能）：
 * 1. **构建与加载分离**：63 个入口先一次性全部 build 完，再逐个 require。
 *    交错执行（build 一个就 require 一个）会让 require 慢近 10 倍
 *    （实测 load 37.7s → 2.8s，全量单测 75s → 16s）。
 * 2. **单次多入口构建**：一个 esbuild.build() 处理全部入口，避免 63 次服务往返。
 * 3. `packages: 'external'` 只让 node_modules 依赖走运行时 require，src 仍逐入口内联，
 *    因此每个入口依旧持有独立的模块实例（Config/Model/toolMap 等单例互不共享），
 *    用例语义与拆分前完全一致。产物必须落在仓库内（放 os.tmpdir() 会 MODULE_NOT_FOUND）。
 * 4. 结束时显式 `process.exit(0)`：src 里的长连接回收/待机唤醒会留下几十个 Timeout，
 *    不主动退出会白等 20+ 秒（实测 41.8s → 16s）。
 *
 * 可选环境变量：
 * - UNIT_FILTER=<子串> 只跑名字含该子串的用例，便于迭代。
 * - UNIT_SKIP=<正则>   跳过名字匹配的用例。
 * - UNIT_ORDER=reverse | shuffle:<seed>  逆序/乱序执行，用于巡检用例间状态污染。
 * - UNIT_ORDER=files-reverse | files-shuffle:<seed> | inner-reverse
 *                       文件级乱序 / 文件内逆序（隔离性巡检）。
 * - UNIT_ORDER_FILE=<path> 按给定用例名顺序执行（每行一个）。
 * - UNIT_ORDER_LOG=<path>  把最终执行顺序（入口名 + 用例名）落盘，便于复现现场。
 * - UNIT_FILES=<逗号入口名>  只跑这些入口的用例，且**按给定顺序**执行（二分定位污染源）。
 * - UNIT_TESTS=<逗号用例名>  只跑这些用例（按给定顺序），最小复现组合。
 * - UNIT_REPORT_ALL=1 单个失败不中断，跑完汇总（乱序巡检时一次拿全）。
 * - UNIT_STACK=1      失败时打印完整堆栈。
 */
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
// 产物落在 node_modules/.cache（已被 git 忽略），保证运行时能解析到仓库的 node_modules
const outDir = path.join(repo, 'node_modules', '.cache', 'aiplugin4-unit');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 入口清单：顺序即用例执行顺序（部分用例有先后依赖，改动前请确认）
const entries = [
    // 原 14k 行 unit-test-entry.ts 按域拆分而来（顺序与拆分前一致，共享前置见 unit-test-helpers.ts）
    ['quotaToken', 'unit-test-quota-token.ts'],
    ['promptText', 'unit-test-prompt-text.ts'],
    ['memoryUnit', 'unit-test-memory.ts'],
    ['eventQueue', 'unit-test-event-queue.ts'],
    ['imageUnit', 'unit-test-image.ts'],
    ['judgeTimer', 'unit-test-judge-timer.ts'],
    ['modelSession', 'unit-test-model-session.ts'],
    ['configTools', 'unit-test-config-tools.ts'],
    ['mediaUnit', 'unit-test-media.ts'],
    ['memoryV3', 'unit-test-memory-v3.ts'],
    ['subagent', 'unit-test-subagent.ts'],
    ['v5', 'unit-test-v5.ts'],
    ['web', 'unit-test-web.ts'],
    ['imageHost', 'unit-test-image-host.ts'],
    ['imageFetch', 'unit-test-image-fetch.ts'],
    ['backendConfig', 'unit-test-backend-config.ts'],
    // 独立启动装配回归入口（首次 Config.registerConfig()，验证配置应用时机）
    ['boot', 'unit-test-boot.ts'],
    ['contextV2', 'unit-test-context-v2.ts'],
    ['contextMigrate', 'unit-test-context-migrate.ts'],
    ['contextView', 'unit-test-context-view.ts'],
    ['contextLog', 'unit-test-context-log.ts'],
    ['contextStore', 'unit-test-context-store.ts'],
    ['contextContent', 'unit-test-context-content.ts'],
    ['contextCompile', 'unit-test-context-compile.ts'],
    ['contextMigratePersist', 'unit-test-context-migrate-persist.ts'],
    ['contextProjection', 'unit-test-context-projection.ts'],
    ['contextRecall', 'unit-test-context-recall.ts'],
    ['contextService', 'unit-test-context-service.ts'],
    ['contextAdmin', 'unit-test-context-admin.ts'],
    ['contextCommands', 'unit-test-context-commands.ts'],
    ['contextToolApi', 'unit-test-context-tool-api.ts'],
    ['contextResolve', 'unit-test-context-resolve.ts'],
    ['contextMutations', 'unit-test-context-mutations.ts'],
    ['contextV2Tools', 'unit-test-context-v2-tools.ts'],
    ['contextSession', 'unit-test-context-session.ts'],
    ['contextBridge', 'unit-test-context-bridge.ts'],
    ['contextArchiveController', 'unit-test-context-archive-controller.ts'],
    ['subagentContext', 'unit-test-subagent-context.ts'],
    ['prompt', 'unit-test-prompt.ts'],
    ['protocol', 'unit-test-protocol.ts'],
    ['mcp', 'unit-test-mcp.ts'],
    ['imageSource', 'unit-test-image-source.ts'],
    ['eventTrigger', 'unit-test-event-trigger.ts'],
    ['triggerM0', 'unit-test-trigger-m0.ts'],
    ['triggerRule', 'unit-test-trigger-rule.ts'],
    ['judgeDecision', 'unit-test-judge-decision.ts'],
    ['aux', 'unit-test-aux.ts'],
    ['triggerStore', 'unit-test-trigger-store.ts'],
    ['claimTable', 'unit-test-claim-table.ts'],
    ['chatOutcome', 'unit-test-chat-outcome.ts'],
    ['triggerChain', 'unit-test-trigger-chain.ts'],
    ['judgeConfig', 'unit-test-judge-config.ts'],
    ['triggerTools', 'unit-test-trigger-tools.ts'],
    ['tokenSelect', 'unit-test-token-select.ts'],
    ['quota', 'unit-test-quota.ts'],
    ['quotaRequest', 'unit-test-quota-request.ts'],
    ['timeInject', 'unit-test-time-inject.ts'],
    ['prefixObs', 'unit-test-prefix-obs.ts'],
    ['quote', 'unit-test-quote.ts'],
    ['injectionProviders', 'unit-test-injection-providers.ts'],
    ['injectionContract', 'unit-test-injection-contract.ts'],
    ['injectionPlan', 'unit-test-injection-plan.ts'],
    ['archiveTools', 'unit-test-archive-tools.ts'],
];

const { installSealEnv } = require('./harness/seal-env.cjs');
// 单测环境：空配置 + 出厂模板框采集（seal 桩与 __TEST_CONFIG__ 见 scripts/harness/seal-env.cjs）
const TC = installSealEnv({ preset: 'unit', base64Prefix: '/tmp/aiplugin4-test-media-' });
void TC;

(async () => {
    // 阶段 1：一次构建全部入口（必须在任何 require 之前完成，见文件头说明 1）
    const outfiles = new Map();
    for (const [name] of entries) outfiles.set(name, path.join(outDir, `${name}.cjs`));
    await esbuild.build({
        // 用对象形式显式指定产物名，避免依赖入口文件名
        entryPoints: Object.fromEntries(entries.map(([name, file]) => [name, path.join(__dirname, file)])),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outdir: outDir,
        outExtension: { '.js': '.cjs' },
        packages: 'external',
        logLevel: 'silent',
    });
    await esbuild.stop();

    // 阶段 2：逐个加载
    const all = {};
    const fileOf = {}; // 用例名 → 所属入口文件（用于按文件隔离巡检）
    for (const [name] of entries) {
        const mod = require(outfiles.get(name));
        for (const key of Object.keys(mod.tests)) {
            if (all[key] !== undefined) throw new Error(`重复的单元测试名: ${key}`);
            all[key] = mod.tests[key];
            fileOf[key] = name;
        }
    }
    // UNIT_FILES=<逗号分隔的入口名>：只跑这些入口文件里的用例，且按给定顺序执行（隔离巡检/二分定位用）
    const onlyFilesList = process.env.UNIT_FILES ? process.env.UNIT_FILES.split(',').map(s => s.trim()).filter(Boolean) : null;
    const onlyFiles = onlyFilesList ? new Set(onlyFilesList) : null;

    const filter = process.env.UNIT_FILTER;
    const skip = process.env.UNIT_SKIP ? new RegExp(process.env.UNIT_SKIP) : null;
    const order = process.env.UNIT_ORDER; // 逆向/乱序巡检：reverse | shuffle:<seed>，用于暴露用例间状态污染
    let names = Object.keys(all).filter(n => (!filter || n.includes(filter)) && (!skip || !skip.test(n)) && (!onlyFiles || onlyFiles.has(fileOf[n])));
    if (process.env.UNIT_TESTS) {
        // UNIT_TESTS=<逗号分隔的精确用例名>：按给定顺序只跑这些用例（用于最小复现组合）
        const wanted = process.env.UNIT_TESTS.split(',').map(s => s.trim()).filter(Boolean);
        const missing = wanted.filter(n => !all[n]);
        if (missing.length) throw new Error(`UNIT_TESTS 里有未知用例: ${missing.join(',')}`);
        names = wanted;
    } else if (onlyFilesList) {
        // 按 UNIT_FILES 给定的顺序执行（文件内保持原顺序），用于复现任意跨文件顺序
        names = onlyFilesList.flatMap(f => names.filter(n => fileOf[n] === f));
    } else if (process.env.UNIT_ORDER_FILE) {
        // 按文件给定的顺序执行（每行一个用例名），用于预演拆分后的跨文件执行顺序
        const wanted = fs.readFileSync(process.env.UNIT_ORDER_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const set = new Set(wanted);
        names = [...wanted.filter(n => set.has(n) && all[n]), ...names.filter(n => !set.has(n))];
    } else if (order === 'reverse') names = names.reverse();
    else if (order && order.startsWith('shuffle')) {
        const seed = Number(order.split(':')[1] || 1);
        let s = seed >>> 0 || 1;
        const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
        for (let i = names.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [names[i], names[j]] = [names[j], names[i]];
        }
    }
    if (names.length === 0) throw new Error('未发现任何单元测试（或 UNIT_FILTER 无匹配）');
    // UNIT_ORDER_LOG=<path>：把最终执行顺序（以及每个用例所属入口）落盘，便于复现乱序巡检的现场
    if (process.env.UNIT_ORDER_LOG) {
        const lines = names.map(n => `${fileOf[n]}\t${n}`).join('\n');
        fs.writeFileSync(process.env.UNIT_ORDER_LOG, lines + '\n');
    }
    // 文件级乱序巡检：保持每个入口文件内部的用例顺序，只打乱文件之间的先后
    // （文件内顺序依赖是历史约定，本次改造的目标是「文件之间可任意排序/单独运行」）
    if (order === 'files-reverse' || order === 'inner-reverse' || (order && order.startsWith('files-shuffle'))) {
        const groups = new Map();
        for (const n of names) {
            if (!groups.has(fileOf[n])) groups.set(fileOf[n], []);
            groups.get(fileOf[n]).push(n);
        }
        let fileOrder = [...groups.keys()];
        if (order === 'files-reverse') fileOrder = fileOrder.reverse();
        else if (order && order.startsWith('files-shuffle')) {
            const seed = Number(order.split(':')[1] || 1);
            let s = seed >>> 0 || 1;
            const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
            for (let i = fileOrder.length - 1; i > 0; i--) {
                const j = Math.floor(rnd() * (i + 1));
                [fileOrder[i], fileOrder[j]] = [fileOrder[j], fileOrder[i]];
            }
        }
        // inner-reverse：保持文件顺序，把每个文件内部的用例顺序反过来（只用于体检文件内的顺序依赖）
        if (order === 'inner-reverse') for (const f of fileOrder) groups.get(f).reverse();
        names = fileOrder.flatMap(f => groups.get(f));
    }
    // UNIT_REPORT_ALL=1：单个用例失败不中断，跑完全部后汇总（乱序巡检时用来一次拿到所有顺序依赖）
    const reportAll = process.env.UNIT_REPORT_ALL === '1';
    const failed = [];
    for (const name of names) {
        try {
            await all[name]();
            if (!reportAll) console.log('PASS', name);
        } catch (error) {
            if (!reportAll) throw error;
            failed.push({ name, error });
            console.log('FAIL', name, '-', String(error && error.message).split('\n')[0]);
            if (process.env.UNIT_STACK === '1' && error && error.stack) console.log(String(error.stack));
        }
    }
    if (reportAll && failed.length) {
        console.log(`失败 ${failed.length} / ${names.length}`);
        for (const f of failed) console.log(`  × ${f.name}: ${String(f.error && f.error.message).split('\n')[0]}`);
        fs.rmSync(outDir, { recursive: true, force: true });
        process.exit(1);
    }
    console.log(`全部 ${names.length} 个单元测试通过`);
    fs.rmSync(outDir, { recursive: true, force: true });
    // 用例会在 src 里留下定时器/轮询（长连接回收、待机唤醒等），不主动退出会白等几十秒
    process.exit(0);
})().catch(error => {
    console.error(error);
    fs.rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
});
