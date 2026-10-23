#!/usr/bin/env node
// changelog 数据化：每个版本一个数据文件 src/changelog/<version>.ts，
// 由本脚本生成聚合索引 src/changelog.ts（import + 版本映射，按版本从新到旧）。
//
// 用法：
//   node scripts/gen-changelog.mjs            # 校验聚合索引是否与数据文件一致（CI 用）
//   node scripts/gen-changelog.mjs --write    # 重新生成 src/changelog.ts
//   node scripts/gen-changelog.mjs --migrate  # 一次性迁移：从旧的单文件 src/changelog.ts 拆出数据文件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = path.join(ROOT, 'src', 'changelog');
const INDEX = path.join(ROOT, 'src', 'changelog.ts');
const HEADER = `// 版本更新日志聚合索引（**由 scripts/gen-changelog.mjs 生成，勿手改**）。
// 每个版本的数据文件在 src/changelog/<version>.ts（正文为 Markdown；行内反引号写作 \\\`）。
// 新增版本：先在 src/changelog/ 建 <version>.ts，再运行 npm run changelog:gen。
`;

/** 模板字符串正文扫描：遇到未转义反引号结束（与 scripts/release-notes.js 同规则） */
function readTemplateBody(text, start) {
    let out = '';
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') {
            out += ch;
            if (i + 1 < text.length) out += text[++i];
            continue;
        }
        if (ch === '`') return out;
        out += ch;
    }
    return null;
}

function compareVersionsDesc(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    }
    return 0;
}

function dataFiles() {
    if (!fs.existsSync(DATA_DIR)) return [];
    return fs.readdirSync(DATA_DIR)
        .filter((f) => /^\d+\.\d+\.\d+\.ts$/.test(f))
        .map((f) => f.replace(/\.ts$/, ''))
        .sort(compareVersionsDesc);
}

/** 从旧单文件提取 { version: body }（模板字符串正文原样保留，含 \\` 转义） */
function parseMonolith(text) {
    const map = new Map();
    const keyRe = /"(\d+\.\d+\.\d+)"\s*:\s*`/g;
    let m;
    while ((m = keyRe.exec(text))) {
        const body = readTemplateBody(text, keyRe.lastIndex);
        if (body === null) {
            console.error(`版本 ${m[1]} 的更新日志模板字符串缺少结束反引号`);
            process.exit(1);
        }
        map.set(m[1], body);
        keyRe.lastIndex += body.length + 1;
    }
    return map;
}

function dataFileContent(version, body) {
    return `// 版本更新日志（数据文件）：${version}。正文为 Markdown；行内反引号写作 \\\`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default \`${body}\`;
`;
}

function aggregatorContent(versions) {
    // import 顺序按路径字典序（ESLint import/order 要求）；映射顺序仍为版本从新到旧（changelog 输出依赖此顺序）
    const imports = [...versions].sort().map((v) => {
        const ident = `v${v.replace(/\./g, '_')}`;
        return `import ${ident} from "./changelog/${v}";`;
    });
    const entries = versions.map((v) => {
        const ident = `v${v.replace(/\./g, '_')}`;
        return `    "${v}": ${ident},`;
    });
    return `${HEADER}
${imports.join('\n')}

export const changelog: { [version: string]: string } = {
${entries.join('\n')}
};
`;
}

function readIndex() {
    return fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';
}

function main() {
    const mode = process.argv.includes('--migrate') ? 'migrate'
        : process.argv.includes('--write') ? 'write'
            : 'check';

    if (mode === 'migrate') {
        const text = readIndex();
        if (!/export const changelog\s*:/.test(text) || !/:\s*`/.test(text)) {
            console.error('src/changelog.ts 不是旧的单文件格式，无需迁移（已是聚合索引）');
            process.exit(1);
        }
        const map = parseMonolith(text);
        if (map.size === 0) {
            console.error('未从 src/changelog.ts 解析到任何版本');
            process.exit(1);
        }
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const versions = [...map.keys()].sort(compareVersionsDesc);
        for (const v of versions) {
            fs.writeFileSync(path.join(DATA_DIR, `${v}.ts`), dataFileContent(v, map.get(v)), 'utf8');
        }
        fs.writeFileSync(INDEX, aggregatorContent(versions), 'utf8');
        console.log(`已迁移 ${versions.length} 个版本到 src/changelog/*.ts，并生成聚合索引`);
        return;
    }

    const versions = dataFiles();
    if (versions.length === 0) {
        console.error('src/changelog/ 下没有版本数据文件（先运行 --migrate）');
        process.exit(1);
    }
    const expected = aggregatorContent(versions);
    if (mode === 'write') {
        fs.writeFileSync(INDEX, expected, 'utf8');
        console.log(`已生成 src/changelog.ts（${versions.length} 个版本：${versions[0]} … ${versions[versions.length - 1]}）`);
        return;
    }
    if (readIndex() !== expected) {
        console.error('[FAIL] src/changelog.ts 与 src/changelog/*.ts 不一致（聚合索引需重新生成）');
        console.error('修复：node scripts/gen-changelog.mjs --write');
        process.exit(1);
    }
    console.log(`[OK] changelog 聚合索引与 ${versions.length} 个版本数据文件一致`);
}

main();
