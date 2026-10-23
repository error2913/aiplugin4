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

const { installSealEnv } = require('./harness/seal-env.cjs');
const TC = installSealEnv({ preset: 'sim', base64Prefix: '/tmp/aiplugin4-fuzz-media-' });

(async () => {
    await esbuild.build({
        entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
        outfile: bundle, logLevel: 'warning',
    });
    require(bundle);
})().catch(e => { console.error('fuzz 构建失败：', e.message); process.exit(1); });
