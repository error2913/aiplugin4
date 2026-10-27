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
    imageHost: path.join(outDir, 'unit-image-host.cjs'),
    backendConfig: path.join(outDir, 'unit-backend-config.cjs'),
    boot: path.join(outDir, 'unit-boot.cjs'),
    contextV2: path.join(outDir, 'unit-context-v2.cjs'),
    contextMigrate: path.join(outDir, 'unit-context-migrate.cjs'),
    contextView: path.join(outDir, 'unit-context-view.cjs'),
    contextLog: path.join(outDir, 'unit-context-log.cjs'),
    contextStore: path.join(outDir, 'unit-context-store.cjs'),
    contextContent: path.join(outDir, 'unit-context-content.cjs'),
    contextCompile: path.join(outDir, 'unit-context-compile.cjs'),
    contextMigratePersist: path.join(outDir, 'unit-context-migrate-persist.cjs'),
    contextProjection: path.join(outDir, 'unit-context-projection.cjs'),
    contextCompactor: path.join(outDir, 'unit-context-compactor.cjs'),
    contextRecall: path.join(outDir, 'unit-context-recall.cjs'),
    contextService: path.join(outDir, 'unit-context-service.cjs'),
    contextAdmin: path.join(outDir, 'unit-context-admin.cjs'),
    contextRuntime: path.join(outDir, 'unit-context-runtime.cjs'),
    contextCommands: path.join(outDir, 'unit-context-commands.cjs'),
    contextToolApi: path.join(outDir, 'unit-context-tool-api.cjs'),
    contextMutations: path.join(outDir, 'unit-context-mutations.cjs'),
    contextV2Tools: path.join(outDir, 'unit-context-v2-tools.cjs'),
    contextSession: path.join(outDir, 'unit-context-session.cjs'),
    contextBridge: path.join(outDir, 'unit-context-bridge.cjs'),
    subagentContext: path.join(outDir, 'unit-subagent-context.cjs'),
    prompt: path.join(outDir, 'unit-prompt.cjs'),
    protocol: path.join(outDir, 'unit-protocol.cjs'),
    mcp: path.join(outDir, 'unit-mcp.cjs'),
    imageSource: path.join(outDir, 'unit-image-source.cjs'),
};

const { installSealEnv } = require('./harness/seal-env.cjs');
// 单测环境：空配置 + 出厂模板框采集（seal 桩与 __TEST_CONFIG__ 见 scripts/harness/seal-env.cjs）
const TC = installSealEnv({ preset: 'unit', base64Prefix: '/tmp/aiplugin4-test-media-' });

(async () => {
    const entries = [
        ['main', path.join(repo, 'scripts/unit-test-entry.ts')],
        ['subagent', path.join(repo, 'scripts/unit-test-subagent.ts')],
        ['v5', path.join(repo, 'scripts/unit-test-v5.ts')],
        ['web', path.join(repo, 'scripts/unit-test-web.ts')],
        ['imageHost', path.join(repo, 'scripts/unit-test-image-host.ts')],
        ['backendConfig', path.join(repo, 'scripts/unit-test-backend-config.ts')],
        // 独立启动装配回归入口（首次 Config.registerConfig()，验证配置应用时机）
        ['boot', path.join(repo, 'scripts/unit-test-boot.ts')],
        ['contextV2', path.join(repo, 'scripts/unit-test-context-v2.ts')],
        ['contextMigrate', path.join(repo, 'scripts/unit-test-context-migrate.ts')],
        ['contextView', path.join(repo, 'scripts/unit-test-context-view.ts')],
        ['contextLog', path.join(repo, 'scripts/unit-test-context-log.ts')],
        ['contextStore', path.join(repo, 'scripts/unit-test-context-store.ts')],
        ['contextContent', path.join(repo, 'scripts/unit-test-context-content.ts')],
        ['contextCompile', path.join(repo, 'scripts/unit-test-context-compile.ts')],
        ['contextMigratePersist', path.join(repo, 'scripts/unit-test-context-migrate-persist.ts')],
        ['contextProjection', path.join(repo, 'scripts/unit-test-context-projection.ts')],
        ['contextCompactor', path.join(repo, 'scripts/unit-test-context-compactor.ts')],
        ['contextRecall', path.join(repo, 'scripts/unit-test-context-recall.ts')],
        ['contextService', path.join(repo, 'scripts/unit-test-context-service.ts')],
        ['contextAdmin', path.join(repo, 'scripts/unit-test-context-admin.ts')],
        ['contextRuntime', path.join(repo, 'scripts/unit-test-context-runtime.ts')],
        ['contextCommands', path.join(repo, 'scripts/unit-test-context-commands.ts')],
        ['contextToolApi', path.join(repo, 'scripts/unit-test-context-tool-api.ts')],
        ['contextMutations', path.join(repo, 'scripts/unit-test-context-mutations.ts')],
        ['contextV2Tools', path.join(repo, 'scripts/unit-test-context-v2-tools.ts')],
        ['contextSession', path.join(repo, 'scripts/unit-test-context-session.ts')],
        ['contextBridge', path.join(repo, 'scripts/unit-test-context-bridge.ts')],
        ['subagentContext', path.join(repo, 'scripts/unit-test-subagent-context.ts')],
        ['prompt', path.join(repo, 'scripts/unit-test-prompt.ts')],
        ['protocol', path.join(repo, 'scripts/unit-test-protocol.ts')],
        ['mcp', path.join(repo, 'scripts/unit-test-mcp.ts')],
        ['imageSource', path.join(repo, 'scripts/unit-test-image-source.ts')]
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
    const skip = process.env.UNIT_SKIP ? new RegExp(process.env.UNIT_SKIP) : null;
    // v3 重写：旧 v2 记忆行为/MemoryManager 语义的测试已被 v3 用例取代（见 unit-test-entry testV3*），
    // 不再作为默认门禁；保留源码便于对照，但默认跳过。
    const LEGACY_MEMORY_SKIP = /^(testSettle|testV2|testMM|testCmdMemo|testBuildLongTermPrompt|testBuildObservationPrompt|testMigrateLegacyPersona|testR2Consolidate|testCreateMemoryEngineDegrade|testSealMemoryStorageShardedAndMigrates)/;
    // Context v3 清理：旧 v1 窗口/结算/压缩阈值/归档开关的配置键已移除，对应旧行为测试退役；
    // 新 Context v2 行为由 scripts/unit-test-context-*.ts 覆盖。
    const LEGACY_CONTEXT_SKIP = /^(testArchiveByTokenKeepsRecentRounds|testArchiveByTokenCustomTarget|testArchiveDiscardWhenKeepRawOff|testArchiveWritesShardAndKeepsOriginal|testArchiveShardIdempotent|testArchiveSeqAdvancesOnExistingShard|testArchiveConvergesWithoutMemory|testWindowTrim|testColdIngest|testSessionBlobBounded|testReadRawFromRawShard|testShardWriteFailsOnReadError|testPickTierAndFold|testJudgeHistoryHardTruncated|testCompress|testUserMessage.*Compress)/;
    const names = Object.keys(all).filter(n => (!filter || n.includes(filter)) && (!skip || !skip.test(n)) && !LEGACY_MEMORY_SKIP.test(n) && !LEGACY_CONTEXT_SKIP.test(n));
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
