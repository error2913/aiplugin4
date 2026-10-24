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
        ['boot', path.join(repo, 'scripts/unit-test-boot.ts')]
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
