/* 模拟验收 runner：纯 Node 环境跑"待机群生命周期"端到端模拟（不打起 SealDice/QQ）。
 * 与 test-unit.cjs 的区别：这里把配置初始化为**生产注册的默认值**，而不是测试桩的 0/true，
 * 并注入"叠加式假存储"，从而能量出落盘次数 / 体积增长 / LLM 调用次数这类验收数字。
 * 用法：npm run sim
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const entry = path.join(__dirname, 'sim-entry.ts');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-sim-'));
const bundle = path.join(outDir, 'sim.cjs');

// 生产配置默认值（与 src/config/configs/*.ts 的注册默认一致），保证模拟贴近真实行为
const { installSealEnv } = require('./harness/seal-env.cjs');
const TC = installSealEnv({ preset: 'sim', base64Prefix: '/tmp/aiplugin4-sim-media-' });

(async () => {
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'warning',
    });
    require(bundle);
})().catch(e => {
    console.error('模拟构建失败：', e.message);
    process.exit(1);
});
