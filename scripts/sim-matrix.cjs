/* 顺序 / 时序场景矩阵 runner：与 sim.cjs 同套 seal 桩与生产默认配置。
 * 用法：npm run sim:matrix
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const entry = path.join(__dirname, 'sim-matrix-entry.ts');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-matrix-'));
const bundle = path.join(outDir, 'matrix.cjs');

const { installSealEnv } = require('./harness/seal-env.cjs');
const TC = installSealEnv({ preset: 'sim', base64Prefix: '/tmp/aiplugin4-matrix-media-' });

(async () => {
    await esbuild.build({
        entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
        outfile: bundle, logLevel: 'warning',
    });
    require(bundle);
})().catch(e => { console.error('矩阵构建失败：', e.message); process.exit(1); });
