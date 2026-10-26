/* 提示词快照工具（P0）：输出当前 system/runtime 文本与段统计到 test-reports/prompt-baseline/。
 * 用途：重构/英文化前后对比、排查段缓存与段内容变化。
 *
 * 运行：node scripts/prompt-snapshot.cjs [--out <目录>]
 * 默认输出：test-reports/prompt-baseline/<时间戳>/
 * 说明：走与单测相同的 seal 桩（scripts/harness/seal-env.cjs），不会连接真实海豹。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
const outArgIndex = process.argv.indexOf('--out');
const baseOut = outArgIndex >= 0 && process.argv[outArgIndex + 1]
    ? path.resolve(process.argv[outArgIndex + 1])
    : path.join(repo, 'test-reports', 'prompt-baseline');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(baseOut, timestamp);

const { installSealEnv } = require('./harness/seal-env.cjs');
installSealEnv({ preset: 'unit', base64Prefix: '/tmp/aiplugin4-test-media-' });

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-prompt-snapshot-'));
    const bundle = path.join(tmp, 'snapshot.cjs');
    await esbuild.build({
        entryPoints: [path.join(repo, 'scripts/prompt-snapshot-entry.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        logLevel: 'silent',
    });
    const mod = require(bundle);
    assert.equal(typeof mod.snapshot, 'function', '快照入口缺少 snapshot()');

    const snapshots = await mod.snapshot();
    fs.mkdirSync(outDir, { recursive: true });
    for (const snapshot of snapshots) {
        fs.writeFileSync(path.join(outDir, `${snapshot.scenario}.system.md`), snapshot.system, 'utf8');
        fs.writeFileSync(path.join(outDir, `${snapshot.scenario}.runtime.md`), snapshot.runtime, 'utf8');
        fs.writeFileSync(path.join(outDir, `${snapshot.scenario}.sections.txt`), snapshot.table, 'utf8');
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(snapshots.map(snapshot => ({
        scenario: snapshot.scenario,
        systemChars: snapshot.system.length,
        runtimeChars: snapshot.runtime.length,
    })), null, 2), 'utf8');
    console.log(`prompt snapshot written: ${outDir}`);
    fs.rmSync(tmp, { recursive: true, force: true });
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
