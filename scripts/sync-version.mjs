#!/usr/bin/env node
// 版本号单一事实源（single source of truth = src/config/static_config/meta.ts 的 VERSION）。
// 用法：
//   node scripts/sync-version.mjs            # 校验所有出现处（CI 用）
//   node scripts/sync-version.mjs --write    # 以 meta.ts 为准回写其余文件
// 校验范围：header.txt(@version)、package.json、package-lock.json（根 + packages[""]）、
//           src/changelog.ts（必须有该版本条目）、sealpack/info.toml。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const write = process.argv.includes('--write');

function read(rel) {
    const abs = path.join(ROOT, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function sourceVersion() {
    const text = read('src/config/static_config/meta.ts');
    const m = text && text.match(/export const VERSION\s*=\s*["']([0-9]+\.[0-9]+\.[0-9]+)["']/);
    if (!m) {
        console.error('无法从 src/config/static_config/meta.ts 读取 VERSION');
        process.exit(2);
    }
    return m[1];
}

const version = sourceVersion();
const mismatches = []; // 可自动修复（--write）
const fatal = [];      // 无法自动修复（缺文件 / changelog 缺条目）
const updated = [];
const seen = [];

function record(rel, current, expected = version) {
    seen.push(`${rel} = ${current ?? '(缺失)'}`);
    if (current !== expected) mismatches.push(`${rel}: ${current ?? '(缺失)'} != ${expected}`);
}

/** 单处替换：校验 + 可选回写 */
function sync(rel, regex, replacement) {
    const text = read(rel);
    if (text === null) {
        fatal.push(`${rel}: 文件不存在`);
        return;
    }
    const m = text.match(regex);
    record(rel, m ? m[1] : undefined);
    if (write && !m) {
        fatal.push(`${rel}: 未找到版本字段，无法自动回写`);
        return;
    }
    if (write && m[1] !== version) {
        fs.writeFileSync(path.join(ROOT, rel), text.replace(regex, replacement(version)), 'utf8');
        updated.push(rel);
    }
}

sync('header.txt', /\/\/ @version\s+([0-9]+\.[0-9]+\.[0-9]+)/, (v) => `// @version      ${v}`);
sync('package.json', /"version":\s*"([0-9]+\.[0-9]+\.[0-9]+)"/, (v) => `"version": "${v}"`);

// package-lock：根 version 与 packages[""].version 两处
{
    const text = read('package-lock.json');
    if (text === null) {
        fatal.push('package-lock.json: 文件不存在');
    } else {
        const all = [...text.matchAll(/"version":\s*"([0-9]+\.[0-9]+\.[0-9]+)"/g)].map((m) => m[1]);
        record('package-lock.json(root)', all[0]);
        record('package-lock.json(packages[""])', all[1]);
        if (write && (all[0] !== version || all[1] !== version)) {
            let index = 0;
            const next = text.replace(/"version":\s*"([0-9]+\.[0-9]+\.[0-9]+)"/g, (full) => {
                index += 1;
                return index <= 2 ? `"version": "${version}"` : full;
            });
            fs.writeFileSync(path.join(ROOT, 'package-lock.json'), next, 'utf8');
            updated.push('package-lock.json');
        }
    }
}

// changelog 数据文件：必须有该版本条目（发布工作流读取它生成 Release 正文）——只能人工补
{
    const rel = `src/changelog/${version}.ts`;
    const text = read(rel);
    if (text === null) {
        fatal.push(`${rel}: 文件不存在（新版本需先建 changelog 数据文件）`);
    } else {
        const has = /export default `[\s\S]+`/.test(text);
        seen.push(`${rel} = ${has ? '非空' : '空文件'}`);
        if (!has) fatal.push(`${rel}: 更新日志正文不能为空`);
    }
}

sync('sealpack/info.toml', /^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/m, (v) => `version = "${v}"`);

if (write) {
    if (updated.length) console.log(`已按 ${version} 回写：${[...new Set(updated)].join(', ')}`);
    if (!fatal.length) {
        console.log(`[OK] 所有可同步来源已统一为 ${version}`);
        process.exit(0);
    }
}

if (fatal.length || (!write && mismatches.length)) {
    console.error(`\n[FAIL] 版本号不一致（单一事实源指 src/config/static_config/meta.ts 的 VERSION=${version}）：`);
    for (const p of [...mismatches, ...fatal]) console.error(`  ✗ ${p}`);
    if (mismatches.length) console.error('\n可自动修复：node scripts/sync-version.mjs --write');
    process.exit(1);
}

console.log(`[OK] 版本 ${version} 在所有来源一致：`);
for (const s of seen) console.log(`  - ${s}`);
