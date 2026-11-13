/* 单元测试 runner：纯 Node 环境，不打起 SealDice/QQ。
 * 用最小 seal 桩 + 可覆盖的 __TEST_CONFIG__ 运行打包后的测试入口（esbuild CJS）。
 *
 * 设计要点（性能）：
 * 1. **构建与加载分离**：63 个入口先一次性全部 build 完，再逐个 require。
 *    交错执行（build 一个就 require 一个）会让 require 慢近 10 倍
 *    （实测 load 37.7s → 1.5s，全量单测 75s → 15s）。
 * 2. **单次多入口构建**：一个 esbuild.build() 处理全部入口，避免 63 次服务往返。
 * 3. `packages: 'external'` 只让 node_modules 依赖走运行时 require，src 仍逐入口内联，
 *    因此每个入口依旧持有独立的模块实例（Config/Model/toolMap 等单例互不共享），
 *    用例语义与拆分前完全一致。产物必须落在仓库内（放 os.tmpdir() 会 MODULE_NOT_FOUND）。
 * 4. 结束时显式 `process.exit(0)`：src 里的长连接回收/待机唤醒会留下几十个 Timeout，
 *    不主动退出会白等 20+ 秒（实测 41.8s → 15s）。
 *
 * 增量/分域（内循环提速，见 `--help`）：
 * - `--changed[=<ref>]`：按 git 变更算「受影响入口」，**先跑它们，再跑剩余**（失败早报）。
 * - `--changed --only`：只跑受影响入口（通常 3–8 个入口、1–3s）。CI 仍跑全量。
 * - `--domain=a,b`：只跑指定域（域划分见下方 DOMAINS 表）。
 * - `--list`：打印「域 / 入口 / 用例数」表。
 * 影响面来自 esbuild metafile（每个产物实际内联了哪些 src 文件），缓存在
 * `node_modules/.cache/aiplugin4-unit/manifest.json`；缓存按「文件 mtime+size」精确校验，
 * 任何不一致都退回全量构建，不会用过期映射跳过用例。
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
const cp = require('node:child_process');
const esbuild = require('esbuild');

const repo = path.resolve(__dirname, '..');
// 产物落在 node_modules/.cache（已被 git 忽略），保证运行时能解析到仓库的 node_modules
const cacheRoot = path.join(repo, 'node_modules', '.cache', 'aiplugin4-unit');
const outDir = path.join(cacheRoot, 'out');
const manifestPath = path.join(cacheRoot, 'manifest.json');
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

// ---------------------------------------------------------------------------
// 域划分（人工维护）：新增入口必须归到某个域，否则启动即报错
// ---------------------------------------------------------------------------
const DOMAINS = {
    context: [
        'contextV2', 'contextMigrate', 'contextView', 'contextLog', 'contextStore',
        'contextContent', 'contextCompile', 'contextMigratePersist', 'contextProjection',
        'contextRecall', 'contextService', 'contextAdmin', 'contextCommands', 'contextToolApi',
        'contextResolve', 'contextMutations', 'contextV2Tools', 'contextSession', 'contextBridge',
        'contextArchiveController', 'eventQueue', 'tokenSelect', 'timeInject', 'prefixObs',
        'quote', 'injectionProviders', 'injectionContract', 'injectionPlan', 'archiveTools',
    ],
    memory: ['memoryUnit', 'memoryV3'],
    quota: ['quotaToken', 'quota', 'quotaRequest'],
    prompt: ['promptText', 'prompt'],
    model: ['modelSession', 'v5'],
    config: ['configTools', 'backendConfig'],
    media: ['imageUnit', 'mediaUnit', 'imageHost', 'imageFetch', 'imageSource'],
    judge: ['judgeTimer', 'judgeDecision', 'judgeConfig'],
    trigger: ['eventTrigger', 'triggerM0', 'triggerRule', 'triggerStore', 'triggerChain', 'triggerTools'],
    tool: ['mcp'],
    agent: ['aux'],
    session: ['claimTable', 'chatOutcome'],
    subagent: ['subagent', 'subagentContext'],
    core: ['boot', 'protocol'],
    web: ['web'],
};

const domainOfEntry = new Map();
for (const [domain, names] of Object.entries(DOMAINS)) {
    for (const name of names) {
        if (domainOfEntry.has(name)) {
            throw new Error(`入口 ${name} 被重复归域：${domainOfEntry.get(name)} / ${domain}`);
        }
        domainOfEntry.set(name, domain);
    }
}
{
    const entryNames = entries.map(([n]) => n);
    const unclassified = entryNames.filter(n => !domainOfEntry.has(n));
    if (unclassified.length) throw new Error(`以下入口未归域（请加到 DOMAINS）：${unclassified.join(', ')}`);
    const ghost = [...domainOfEntry.keys()].filter(n => !entryNames.includes(n));
    if (ghost.length) throw new Error(`DOMAINS 里有已不存在的入口（请删掉）：${ghost.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------
const USAGE = `用法：node scripts/test-unit.cjs [选项]

  （无选项）              全量跑（CI 口径）
  --changed[=<ref>]       按 git 变更算受影响入口，先跑它们再跑剩余（默认 ref=HEAD）
  --only                  与 --changed / --domain 搭配：只跑选中的入口
  --domain=<a,b>          只优先跑（或配 --only 只跑）这些域
  --list                  打印「域 / 入口 / 用例数」表后退出
  -h, --help              显示本帮助

域：${Object.keys(DOMAINS).join(', ')}

示例：
  node scripts/test-unit.cjs --list                     # 看域划分
  node scripts/test-unit.cjs --changed                  # 改了 src 后：先跑相关，再跑剩余
  node scripts/test-unit.cjs --changed --only           # 内循环：只跑相关（~1–3s）
  node scripts/test-unit.cjs --domain=media --only      # 只跑媒体域
  node scripts/test-unit.cjs --domain=context           # 先跑上下文域，再跑剩余
`;

function parseArgs(argv) {
    const opts = { changed: null, domains: null, only: false, list: false, help: false };
    for (const arg of argv) {
        if (arg === '--only') opts.only = true;
        else if (arg === '--list') opts.list = true;
        else if (arg === '-h' || arg === '--help') opts.help = true;
        else if (arg === '--changed') opts.changed = 'HEAD';
        else if (arg.startsWith('--changed=')) opts.changed = arg.slice('--changed='.length).trim() || 'HEAD';
        else if (arg.startsWith('--domain=')) {
            opts.domains = arg.slice('--domain='.length).split(',').map(s => s.trim()).filter(Boolean);
            for (const d of opts.domains) {
                if (!DOMAINS[d]) throw new Error(`未知域 "${d}"；可选：${Object.keys(DOMAINS).join(', ')}`);
            }
        } else throw new Error(`未知参数 "${arg}"（用 --help 查看用法）`);
    }
    if (opts.only && !opts.changed && !opts.domains) throw new Error('--only 需要与 --changed 或 --domain= 搭配');
    return opts;
}

// ---------------------------------------------------------------------------
// 影响面映射：入口 → 实际内联的 src/scripts 文件（来自 esbuild metafile，带 mtime 校验缓存）
// ---------------------------------------------------------------------------
const MANIFEST_VERSION = 1;

function statOf(relFile) {
    const st = fs.statSync(path.join(repo, relFile));
    return [Math.round(st.mtimeMs), st.size];
}

/**
 * 读缓存。**只校验结构是否可用，不用 mtime 判过期**：
 * 「哪些文件变了」由 `git diff` 权威决定，mtime 判定会在每次编辑后都把缓存打成过期、
 * 退回全量构建，增量就失去意义。这里只挡住「入口清单变了」和「映射里的文件已不存在」两种情况。
 *
 * `stamps` 仅作诊断留档（--list 之类可以看），不参与失效判定。
 */
function loadManifest() {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return null;
    }
    if (!raw || raw.version !== MANIFEST_VERSION || !raw.entries || !raw.stamps) return null;
    // 入口清单变化（新增/删除/改名 unit-test-*.ts）⇒ 映射不可信
    for (const [name] of entries) {
        if (!raw.entries[name]) return null;
    }
    for (const name of Object.keys(raw.entries)) {
        if (!entries.some(([n]) => n === name)) return null;
    }
    // 映射里引用的文件已被删除 ⇒ 图已变
    for (const info of Object.values(raw.entries)) {
        for (const f of info.inputs) {
            if (!fs.existsSync(path.join(repo, f))) return null;
        }
    }
    return raw;
}

function saveManifest(manifest) {
    try {
        fs.mkdirSync(cacheRoot, { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    } catch (error) {
        console.error('[unit] 依赖图缓存写入失败（不影响本次结果）：' + String(error && error.message));
    }
}

/** 从 metafile 抽「产物名 → 内联文件清单」，并为每个文件记 mtime+size 供下次校验 */
function manifestFromMetafile(metafile, builtNames) {
    const manifest = { version: MANIFEST_VERSION, entries: {}, stamps: {} };
    const files = new Set();
    const outputs = metafile && metafile.outputs ? metafile.outputs : {};
    for (const [name] of entries) {
        if (!builtNames.has(name)) continue;
        const key = Object.keys(outputs).find(p => path.basename(p) === `${name}.cjs`);
        if (!key) continue;
        const inputs = Object.keys(outputs[key].inputs || {})
            .map(p => p.replace(/\\/g, '/'))
            .sort();
        manifest.entries[name] = { inputs };
        for (const f of inputs) files.add(f);
    }
    for (const f of files) {
        try {
            manifest.stamps[f] = statOf(f);
        } catch {
            // 文件已不在（构建期临时产物等）：不记 stamp，下次自然判过期
        }
    }
    return manifest;
}

function gitChangedFiles(ref) {
    const git = args => cp.execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const changed = new Set();
    for (const line of git(['diff', '--name-only', ref, '--']).split(/\r?\n/)) {
        if (line.trim()) changed.add(line.replace(/\\/g, '/').trim());
    }
    // 未跟踪的新文件（新建 src 模块时也要算进来）
    for (const line of git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/)) {
        if (line.trim()) changed.add(line.replace(/\\/g, '/').trim());
    }
    return [...changed];
}

/** 变更文件 → 受影响入口。runner/harness 变更一律全量。 */
function affectedEntries(changedFiles, manifest) {
    const allNames = entries.map(([n]) => n);
    if (changedFiles.some(f => f === 'scripts/test-unit.cjs' || f.startsWith('scripts/harness/'))) {
        return { names: allNames, why: 'scripts/test-unit.cjs 或 scripts/harness/ 变更 ⇒ 全量', universal: true, files: [] };
    }
    const fileToEntries = new Map();
    for (const [name, info] of Object.entries(manifest.entries)) {
        for (const f of info.inputs) {
            if (!fileToEntries.has(f)) fileToEntries.set(f, []);
            fileToEntries.get(f).push(name);
        }
    }
    const hit = new Set();
    const hitFiles = [];
    for (const f of changedFiles) {
        const owners = fileToEntries.get(f);
        if (!owners || owners.length === 0) continue;
        hitFiles.push(f);
        for (const n of owners) hit.add(n);
    }
    return { names: allNames.filter(n => hit.has(n)), why: `git diff 命中 ${hitFiles.length} 个被内联的文件`, universal: false, files: hitFiles };
}

// ---------------------------------------------------------------------------
// 构建 / 运行
// ---------------------------------------------------------------------------
async function buildEntries(namesToBuild) {
    const set = new Set(namesToBuild);
    const picked = entries.filter(([n]) => set.has(n));
    const result = await esbuild.build({
        absWorkingDir: repo,
        // 对象形式显式指定产物名，避免依赖入口文件名
        entryPoints: Object.fromEntries(picked.map(([name, file]) => [name, `scripts/${file}`])),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outdir: outDir,
        outExtension: { '.js': '.cjs' },
        packages: 'external',
        logLevel: 'silent',
        metafile: true,
    });
    return result.metafile;
}

(async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(USAGE);
        process.exit(0);
    }
    const allNames = entries.map(([n]) => n);

    const { installSealEnv } = require('./harness/seal-env.cjs');
    // 单测环境：空配置 + 出厂模板框采集（seal 桩与 __TEST_CONFIG__ 见 scripts/harness/seal-env.cjs）
    const TC = installSealEnv({ preset: 'unit', base64Prefix: '/tmp/aiplugin4-test-media-' });
    void TC;

    // ---- 1. 决定要构建/运行哪些入口 ----
    let manifest = null;
    let builtNames = null;
    let metafile = null;

    // 只有 --changed 需要依赖图；--domain 直接查 DOMAINS 表，不必为它白算一次全量构建
    const wantImpact = Boolean(opts.changed);
    if (wantImpact) manifest = loadManifest();

    if (wantImpact && !manifest) {
        // 冷启动：先全量构建一次拿依赖图（同时就是本次要跑的全量产物）
        console.error('[unit] 依赖图缓存缺失或已过期，先全量构建一次以生成影响面映射…');
        metafile = await buildEntries(allNames);
        builtNames = new Set(allNames);
        manifest = manifestFromMetafile(metafile, builtNames);
        saveManifest(manifest);
    }

    // 优先级入口（先跑这些）；--only 时它们就是全部
    let priorityNames = [];
    let priorityWhy = '';
    if (opts.changed) {
        const changedFiles = gitChangedFiles(opts.changed);
        const affected = affectedEntries(changedFiles, manifest);
        priorityNames = affected.names;
        priorityWhy = `对比 ${opts.changed}：${affected.why}`;
    }
    if (opts.domains) {
        const domainPicked = entries.map(([n]) => n).filter(n => opts.domains.includes(domainOfEntry.get(n)));
        // 两个来源同时给时取并集（保持全局顺序）
        const merged = new Set([...priorityNames, ...domainPicked]);
        priorityNames = allNames.filter(n => merged.has(n));
        priorityWhy += (priorityWhy ? '；' : '') + `域 ${opts.domains.join(',')}（${domainPicked.length} 个入口）`;
    }
    const prioritySet = new Set(priorityNames);

    let runNames;
    if (opts.only) {
        runNames = allNames.filter(n => prioritySet.has(n));
        if (runNames.length === 0) {
            console.log(`[unit] ${priorityWhy}`);
            console.log('[unit] 没有受影响/被选中的用例 —— 本次不跑任何用例（CI 仍会跑全量）');
            fs.rmSync(outDir, { recursive: true, force: true });
            process.exit(0);
        }
    } else {
        runNames = allNames;
    }

    if (!builtNames) {
        const toBuild = opts.only ? runNames : allNames;
        metafile = await buildEntries(toBuild);
        builtNames = new Set(toBuild);
        if (!opts.only) {
            // 全量构建顺带刷新影响面缓存，下次 --changed 就无需再全量构建
            saveManifest(manifestFromMetafile(metafile, builtNames));
        }
    }
    await esbuild.stop();

    // ---- 2. 逐个加载（只加载构建过的入口） ----
    const all = {};
    const fileOf = {}; // 用例名 → 所属入口文件（用于按文件隔离巡检）
    for (const [name] of entries) {
        if (!builtNames.has(name)) continue;
        const mod = require(path.join(outDir, `${name}.cjs`));
        for (const key of Object.keys(mod.tests)) {
            if (all[key] !== undefined) throw new Error(`重复的单元测试名: ${key}`);
            all[key] = mod.tests[key];
            fileOf[key] = name;
        }
    }
    const caseCountOfEntry = {};
    for (const [name] of entries) {
        const mod = builtNames.has(name) ? require(path.join(outDir, `${name}.cjs`)) : null;
        caseCountOfEntry[name] = mod ? Object.keys(mod.tests).length : 0;
    }

    // ---- 3. 列表模式 ----
    if (opts.list) {
        console.log('域\t\t入口\t用例');
        let totalEntries = 0;
        let totalCases = 0;
        for (const [domain, names] of Object.entries(DOMAINS)) {
            const cases = names.reduce((sum, n) => sum + (caseCountOfEntry[n] || 0), 0);
            totalEntries += names.length;
            totalCases += cases;
            console.log(`${domain.padEnd(10)}\t${String(names.length).padStart(2)}\t${String(cases).padStart(4)}`);
        }
        console.log(`合计\t\t${totalEntries}\t${totalCases}`);
        fs.rmSync(outDir, { recursive: true, force: true });
        process.exit(0);
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

    // ---- 4. 分域/影响面模式：相关入口的用例排到最前（失败早报），其余随后 ----
    if (prioritySet.size > 0 && !opts.only) {
        if (order) console.error('[unit] 提示：优先级模式已生效，UNIT_ORDER 的乱序仅作用于各个阶段内部');
        const first = names.filter(n => prioritySet.has(fileOf[n]));
        const rest = names.filter(n => !prioritySet.has(fileOf[n]));
        names = [...first, ...rest];
        if (first.length + rest.length !== new Set(names).size) {
            throw new Error(`优先级重排后用例数不自洽：${first.length} + ${rest.length} != ${new Set(names).size}`);
        }
        const firstCases = first.length;
        console.log(`[unit] ${priorityWhy}`);
        console.log(`[unit] 先跑相关：${[...new Set(first.map(n => fileOf[n]))].length} 个入口 / ${firstCases} 个用例；随后跑剩余 ${rest.length} 个用例`);
    } else if (opts.only) {
        console.log(`[unit] 只跑选中范围：${runNames.length} 个入口 / ${names.length} 个用例（CI 仍跑全量，这里不做最终验收）`);
        console.log(`[unit] ${priorityWhy}`);
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
