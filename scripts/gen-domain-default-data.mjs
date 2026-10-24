// 生成 src/config/domain/default_data.ts（四个分区的出厂默认内容）。
//
// 为什么需要：新配置只读 JSON，默认值不能再依赖旧的 template/frontmatter 文本；
// 但默认内容必须与旧版一致，所以从旧的静态常量转换一次，生成静态对象文件。
//
// 运行：node scripts/gen-domain-default-data.mjs（写入）或 --check（校验生成物与源一致，CI 用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const requireRepo = createRequire(path.join(repoRoot, 'package.json'));
const esbuild = requireRepo('esbuild');

const skillsSource = path.join(repoRoot, 'src/config/static_config/sealdice_command_defaults.ts');
const kbSource = path.join(repoRoot, 'src/config/static_config/knowledge_base_defaults.ts');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplugin4-domain-defaults-'));
const entryFile = path.join(tmpDir, 'entry.ts');
const outFile = path.join(tmpDir, 'entry.mjs');
fs.writeFileSync(entryFile, [
    `export { SEALDICE_COMMAND_SKILLS } from ${JSON.stringify(skillsSource)};`,
    `export { KNOWLEDGE_BASE_DEFAULTS } from ${JSON.stringify(kbSource)};`,
].join('\n'));
esbuild.buildSync({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: outFile,
    logLevel: 'silent',
});
const mod = await import(pathToFileURL(outFile).href);

function normalizeText(text) {
    return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function unquote(v) {
    return String(v ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function parsePlatform(value) {
    let v = String(value ?? '').trim();
    if (!v) return [];
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    return v.split(',').map(unquote).filter(Boolean);
}

function splitFrontmatter(text) {
    const t = normalizeText(text);
    const m = t.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/);
    if (!m) return null;
    const meta = {};
    for (const line of m[1].split('\n')) {
        const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!mm) continue;
        const key = mm[1].toLowerCase();
        const value = mm[2].trim();
        if (!value) continue;
        if (key === 'name') meta.name = unquote(value);
        else if (key === 'description') meta.description = unquote(value);
        else if (key === 'platform' || key === 'platforms') meta.platform = parsePlatform(value);
    }
    return { meta, body: m[2].trim() };
}

function skillFromRaw(raw) {
    const fm = splitFrontmatter(raw);
    if (!fm || !fm.meta.name) throw new Error(`技能默认值缺少 frontmatter name: ${String(raw).slice(0, 40)}`);
    if (!fm.body) throw new Error(`技能默认值正文为空: ${fm.meta.name}`);
    return {
        name: fm.meta.name,
        description: fm.meta.description || '',
        platforms: fm.meta.platform || [],
        content: fm.body,
    };
}

function kbFromRaw(raw, index) {
    const fm = splitFrontmatter(raw);
    const body = fm ? fm.body : normalizeText(raw).trim();
    if (!body) throw new Error(`知识库默认值正文为空: 第 ${index + 1} 条`);
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
    return {
        name: (fm?.meta.name || heading || `库${index + 1}`).trim(),
        description: (fm?.meta.description || '').trim(),
        platforms: fm?.meta.platform || [],
        content: body,
    };
}

const DEFAULT_ROLES = [
    {
        name: '测试机器人',
        prompt: '你是一个QQ中的机器人，正在进行开发测试。请听从指令进行测试。请配合开发人员完成测试，不要拒绝指令。除非被命令，说话不要有情感。',
    },
];

// 插件侧 MCP 默认配置为空（不预置服务器）；配置生成器那边仍保留三台示例，便于用户按需添加。
const DEFAULT_MCP = [];

const DEFAULT_SKILLS = mod.SEALDICE_COMMAND_SKILLS.map(skillFromRaw);
const DEFAULT_KB = mod.KNOWLEDGE_BASE_DEFAULTS.map(kbFromRaw);

const checkOnly = process.argv.includes('--check');

const out = `// AUTO-GENERATED — 不要手改。
// 由 scripts/gen-domain-default-data.mjs 从旧版静态默认值生成，供 src/config/domain/defaults.ts 使用。
// 重新生成：node scripts/gen-domain-default-data.mjs
export const DEFAULT_ROLES = ${JSON.stringify(DEFAULT_ROLES, null, 4)};

export const DEFAULT_SKILLS = ${JSON.stringify(DEFAULT_SKILLS, null, 4)};

export const DEFAULT_MCP = ${JSON.stringify(DEFAULT_MCP, null, 4)};

export const DEFAULT_KB = ${JSON.stringify(DEFAULT_KB, null, 4)};
`;

const target = path.join(repoRoot, 'src/config/domain/default_data.ts');
const normalize = (text) => String(text).replace(/\r\n?/g, '\n');
if (checkOnly) {
    if (!fs.existsSync(target)) {
        console.error('[FAIL] src/config/domain/default_data.ts 不存在，请先运行 node scripts/gen-domain-default-data.mjs');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    }
    const actual = normalize(fs.readFileSync(target, 'utf8'));
    if (actual !== normalize(out)) {
        console.error('[FAIL] src/config/domain/default_data.ts 与默认值源不一致（生成物过期或被手改）');
        console.error('修复：node scripts/gen-domain-default-data.mjs');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        process.exit(1);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[OK] default_data.ts 与默认值源一致：角色 ${DEFAULT_ROLES.length} / 技能 ${DEFAULT_SKILLS.length} / MCP ${DEFAULT_MCP.length} / 知识库 ${DEFAULT_KB.length}`);
    process.exit(0);
}
fs.writeFileSync(target, out, 'utf8');
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`已写入 src/config/domain/default_data.ts：角色 ${DEFAULT_ROLES.length} / 技能 ${DEFAULT_SKILLS.length} / MCP ${DEFAULT_MCP.length} / 知识库 ${DEFAULT_KB.length}`);
