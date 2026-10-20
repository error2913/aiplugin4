// 角色 / 技能 / MCP / 知识库配置（JSON v1）的解析与校验。
//
// 纯逻辑，不依赖 seal / Config。校验失败返回**全部问题**（一次报全），
// 调用方整份拒绝；path 用 $.skills[0].name 形式。
//
// MCP 使用标准 mcpServers 结构（键 = 服务器名，无 version）；stdio / SSE 会被跳过并记 warning。
import { parseJSONWithTrailingCommas } from '../../utils/json';

import {
    DOMAIN_VERSION, DomainIssue, DomainParseResult, KbConfig, KbEntry,
    McpConfig, McpServerEntry, RoleEntry, RolesConfig, SkillEntry, SkillsConfig,
} from './types';

const MCP_TYPES = ['http', 'streamable-http'];
const MAX_ROLE_NAME = 20;
/** 技能描述超过该长度给 warning（注入摘要时按 SKILL_SUMMARY_DESC_MAX 截断） */
const MAX_SKILL_DESC_WARN = 300;
/** 技能名超过该长度给 warning（不截断，名称是 use_skill / .ai skill 的键） */
const MAX_SKILL_NAME_WARN = 40;
/** 单个技能资源的字符上限（use_skill 返回时截断） */
const MAX_SKILL_RESOURCE_CHARS = 12000;
/** 单个技能的资源数量警告阈值 */
const MAX_SKILL_RESOURCES = 50;
const MAX_SKILL_RESOURCE_KEY = 120;

function isPlainObject(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function issue(path: string, msg: string): DomainIssue {
    return { path, msg };
}

/** 解析 JSON 文本；空文本返回 null（调用方决定回退默认值） */
function parseJson(text: string): { value: any; issues: DomainIssue[]; empty: boolean } {
    const raw = String(text ?? '').trim();
    if (!raw) return { value: null, issues: [], empty: true };
    try {
        return { value: parseJSONWithTrailingCommas(raw), issues: [], empty: false };
    } catch (e) {
        return { value: null, issues: [issue('$', `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)], empty: false };
    }
}

/** 归一化 platform：字符串或字符串数组；缺省/空 = []（所有平台） */
function readPlatform(value: unknown, path: string, issues: DomainIssue[]): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') {
        let v = value.trim();
        if (!v) return [];
        if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
        return v.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    if (!Array.isArray(value)) {
        issues.push(issue(path, 'platform 必须是字符串或字符串数组'));
        return [];
    }
    const out: string[] = [];
    value.forEach((item, i) => {
        if (typeof item !== 'string') {
            issues.push(issue(`${path}[${i}]`, '平台名必须是字符串'));
            return;
        }
        const name = item.trim();
        if (name) out.push(name);
    });
    return out;
}

function checkVersion(value: Record<string, any>, issues: DomainIssue[]): boolean {
    if (value.version !== DOMAIN_VERSION) {
        issues.push(issue('$.version', `版本必须是 ${DOMAIN_VERSION}（当前 ${JSON.stringify(value.version)}）`));
        return false;
    }
    return true;
}

function readName(value: unknown, path: string, issues: DomainIssue[]): string {
    if (typeof value !== 'string' || !value.trim()) {
        issues.push(issue(path, 'name 必填（字符串）'));
        return '';
    }
    return value.trim();
}

function readContent(value: unknown, path: string, issues: DomainIssue[], label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        issues.push(issue(path, `${label} 必填（字符串）`));
        return '';
    }
    return value;
}

function findDuplicates(names: string[]): string[] {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const raw of names) {
        if (!raw) continue;
        if (seen.has(raw)) dup.add(raw);
        seen.add(raw);
    }
    return [...dup];
}

/** 角色配置 → {version, roles:[{name,prompt}]} */
export function parseRolesConfig(text: string): DomainParseResult<RolesConfig> {
    const { value, issues, empty } = parseJson(text);
    if (empty) return { config: null, issues: [], warnings: [] };
    if (issues.length > 0) return { config: null, issues, warnings: [] };
    if (!isPlainObject(value)) {
        return { config: null, issues: [issue('$', '角色配置必须是一个 JSON 对象')], warnings: [] };
    }
    const warnings: DomainIssue[] = [];
    if (!checkVersion(value, issues)) return { config: null, issues, warnings };
    if (!Array.isArray(value.roles)) {
        return { config: null, issues: [issue('$.roles', 'roles 必须是数组')], warnings: [] };
    }

    const roles: RoleEntry[] = [];
    const names: string[] = [];
    value.roles.forEach((item, i) => {
        const path = `$.roles[${i}]`;
        if (!isPlainObject(item)) {
            issues.push(issue(path, '角色条目必须是对象'));
            return;
        }
        let name = readName(item.name, `${path}.name`, issues);
        if (name.length > MAX_ROLE_NAME) {
            warnings.push(issue(`${path}.name`, `角色名超过 ${MAX_ROLE_NAME} 字符，已截断为「${name.slice(0, MAX_ROLE_NAME)}」`));
            name = name.slice(0, MAX_ROLE_NAME);
        }
        const prompt = readContent(item.prompt, `${path}.prompt`, issues, 'prompt');
        names.push(name);
        roles.push({ name, prompt });
    });
    for (const dup of findDuplicates(names)) issues.push(issue('$.roles', `角色名重复：${dup}`));
    return { config: issues.length > 0 ? null : { version: DOMAIN_VERSION, roles }, issues, warnings };
}

/** 是否含控制字符（换行/制表/空字符等） */
function hasControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

/** 归一化资源路径：统一用 /，去掉首尾空白 */
function normalizeResourceKey(raw: string): string {
    return String(raw ?? '').trim().replace(/\\/g, '/');
}

/** 校验资源相对路径；返回错误文案，合法返回 null */
function resourceKeyProblem(key: string): string | null {
    if (!key) return '资源路径不能为空';
    if (key.length > MAX_SKILL_RESOURCE_KEY) return `资源路径超过 ${MAX_SKILL_RESOURCE_KEY} 字符`;
    if (hasControlChar(key)) return '资源路径含控制字符';
    if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) return '资源路径必须是相对路径';
    const parts = key.split('/');
    if (parts.some(part => part === '' || part === '.' || part === '..')) {
        return '资源路径不能包含空段 / . / ..';
    }
    return null;
}

/** 技能 resources：只读参考文件（相对路径 → 文本）；非法项按 warning 跳过，不整份拒绝 */
function readSkillResources(
    value: unknown,
    path: string,
    warnings: DomainIssue[],
): { [path: string]: string } {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
        warnings.push(issue(path, 'resources 必须是对象（相对路径 → 文本），已忽略'));
        return {};
    }
    const out: { [path: string]: string } = {};
    const keys = Object.keys(value);
    if (keys.length > MAX_SKILL_RESOURCES) {
        warnings.push(issue(path, `资源数量超过 ${MAX_SKILL_RESOURCES} 个：use_skill 只列前 ${MAX_SKILL_RESOURCES} 个`));
    }
    for (const rawKey of keys) {
        const key = normalizeResourceKey(rawKey);
        const problem = resourceKeyProblem(key);
        if (problem) {
            warnings.push(issue(`${path}.${rawKey}`, `${problem}，已跳过`));
            continue;
        }
        const raw = value[rawKey];
        if (typeof raw !== 'string' || !raw.trim()) {
            warnings.push(issue(`${path}.${rawKey}`, '资源内容必须是非空字符串，已跳过'));
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) {
            warnings.push(issue(`${path}.${rawKey}`, '资源路径归一化后重复，已跳过'));
            continue;
        }
        if (raw.length > MAX_SKILL_RESOURCE_CHARS) {
            warnings.push(issue(`${path}.${rawKey}`, `资源超过 ${MAX_SKILL_RESOURCE_CHARS} 字符：use_skill 返回时会截断`));
        }
        // 用 defineProperty 而不是 out[key]：资源名可能是 __proto__ 这类特殊键
        Object.defineProperty(out, key, {
            value: raw, enumerable: true, configurable: true, writable: true,
        });
    }
    return out;
}

/** 技能配置 → {version, includeDefaults, skills:[{name,description,platform,content,resources}]} */
export function parseSkillsConfig(text: string): DomainParseResult<SkillsConfig> {
    const { value, issues, empty } = parseJson(text);
    if (empty) return { config: null, issues: [], warnings: [] };
    if (issues.length > 0) return { config: null, issues, warnings: [] };
    if (!isPlainObject(value)) {
        return { config: null, issues: [issue('$', '技能配置必须是一个 JSON 对象')], warnings: [] };
    }
    const warnings: DomainIssue[] = [];
    if (!checkVersion(value, issues)) return { config: null, issues, warnings };
    if (!Array.isArray(value.skills)) {
        return { config: null, issues: [issue('$.skills', 'skills 必须是数组')], warnings: [] };
    }
    let includeDefaults = true;
    if (value.includeDefaults !== undefined && value.includeDefaults !== null) {
        if (typeof value.includeDefaults !== 'boolean') {
            warnings.push(issue('$.includeDefaults', 'includeDefaults 必须是布尔值，已按 true 处理'));
        } else {
            includeDefaults = value.includeDefaults;
        }
    }

    const skills: SkillEntry[] = [];
    const names: string[] = [];
    value.skills.forEach((item, i) => {
        const path = `$.skills[${i}]`;
        if (!isPlainObject(item)) {
            issues.push(issue(path, '技能条目必须是对象'));
            return;
        }
        const name = readName(item.name, `${path}.name`, issues);
        if (name.length > MAX_SKILL_NAME_WARN) {
            warnings.push(issue(`${path}.name`, `技能名超过 ${MAX_SKILL_NAME_WARN} 字符，建议缩短`));
        }
        if (hasControlChar(name)) {
            warnings.push(issue(`${path}.name`, '技能名含换行/控制字符：展示时会被清理，但请避免'));
        }
        if (item.description !== undefined && item.description !== null && typeof item.description !== 'string') {
            issues.push(issue(`${path}.description`, 'description 必须是字符串'));
        }
        const description = typeof item.description === 'string' ? item.description : '';
        if (/[\r\n]/.test(description)) {
            warnings.push(issue(`${path}.description`, '描述中的换行会在注入摘要时合并为空格'));
        }
        if (description.length > MAX_SKILL_DESC_WARN) {
            warnings.push(issue(`${path}.description`, `描述超过 ${MAX_SKILL_DESC_WARN} 字符：注入摘要时会截断`));
        }
        const platforms = readPlatform(item.platform, `${path}.platform`, issues);
        const content = readContent(item.content, `${path}.content`, issues, 'content');
        if (content.length > 12000) {
            warnings.push(issue(`${path}.content`, `内容超过 12000 字符：use_skill 返回时会截断（配置仍完整保存）`));
        }
        const resources = readSkillResources(item.resources, `${path}.resources`, warnings);
        names.push(name);
        skills.push({ name, description, platforms, content, resources });
    });
    for (const dup of findDuplicates(names)) issues.push(issue('$.skills', `技能名重复：${dup}`));
    return {
        config: issues.length > 0 ? null : { version: DOMAIN_VERSION, includeDefaults, skills },
        issues,
        warnings,
    };
}

/**
 * MCP 配置 → 标准 mcpServers。
 * 结构：{ "mcpServers": { "<服务器名>": { type, url, headers, platform } } }
 * stdio（command）与 SSE 服务器跳过并记 warning（海豹环境不支持）。
 */
export function parseMcpConfig(text: string): DomainParseResult<McpConfig> {
    const { value, issues, empty } = parseJson(text);
    if (empty) return { config: null, issues: [], warnings: [] };
    if (issues.length > 0) return { config: null, issues, warnings: [] };
    if (!isPlainObject(value)) {
        return { config: null, issues: [issue('$', 'MCP 配置必须是一个 JSON 对象')], warnings: [] };
    }
    if (!isPlainObject(value.mcpServers)) {
        return { config: null, issues: [issue('$.mcpServers', '标准 MCP 配置需要顶层 mcpServers 对象')], warnings: [] };
    }

    const warnings: DomainIssue[] = [];
    const servers: McpServerEntry[] = [];
    for (const [rawName, rawCfg] of Object.entries(value.mcpServers)) {
        const name = rawName.trim();
        const path = `$.mcpServers.${rawName}`;
        if (!name) {
            issues.push(issue(path, '服务器名（mcpServers 的键）不能为空'));
            continue;
        }
        if (!isPlainObject(rawCfg)) {
            issues.push(issue(path, '服务器配置必须是对象'));
            continue;
        }
        const type = typeof rawCfg.type === 'string' && rawCfg.type.trim()
            ? rawCfg.type.trim().toLowerCase()
            : 'http';
        if (rawCfg.command !== undefined || type === 'stdio') {
            warnings.push(issue(path, `服务器 ${name} 使用 stdio（command），海豹无法拉起子进程，已跳过`));
            continue;
        }
        if (type === 'sse') {
            warnings.push(issue(path, `服务器 ${name} 使用 SSE 传输，插件只支持 Streamable HTTP，已跳过`));
            continue;
        }
        if (!MCP_TYPES.includes(type)) {
            issues.push(issue(`${path}.type`, `不支持的传输类型 ${JSON.stringify(rawCfg.type)}（仅支持 ${MCP_TYPES.join(' / ')}）`));
            continue;
        }
        if (rawCfg.enabled !== undefined) {
            warnings.push(issue(path, 'enabled 字段已废弃：请在生成器里直接用「启用」开关，关闭的服务器不会写进配置'));
        }
        if (typeof rawCfg.url !== 'string' || !rawCfg.url.trim()) {
            issues.push(issue(`${path}.url`, 'url 必填（字符串）'));
            continue;
        }
        const url = rawCfg.url.trim();
        if (!/^https?:\/\/\S+$/i.test(url)) {
            issues.push(issue(`${path}.url`, 'url 必须是 http:// 或 https:// 地址'));
            continue;
        }
        if (rawCfg.token !== undefined && rawCfg.token !== null && typeof rawCfg.token !== 'string') {
            issues.push(issue(`${path}.token`, 'token 必须是字符串'));
        }
        let token = typeof rawCfg.token === 'string' ? rawCfg.token.trim() : '';
        const headers: { [key: string]: string } = {};
        if (rawCfg.headers !== undefined && rawCfg.headers !== null) {
            if (!isPlainObject(rawCfg.headers)) {
                issues.push(issue(`${path}.headers`, 'headers 必须是对象'));
            } else {
                for (const [k, v] of Object.entries(rawCfg.headers)) {
                    if (typeof v !== 'string') issues.push(issue(`${path}.headers.${k}`, 'header 值必须是字符串'));
                    else headers[k] = v;
                }
            }
        }
        if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
        const auth = headers.Authorization || '';
        if (!token && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
        const platforms = readPlatform(rawCfg.platform, `${path}.platform`, issues);
        servers.push({ name, platforms, type, url, token, headers });
    }

    return { config: issues.length > 0 ? null : { servers }, issues, warnings };
}

/** 知识库配置 → {version, libraries:[{name,description,platform,content}]} */
export function parseKbConfig(text: string): DomainParseResult<KbConfig> {
    const { value, issues, empty } = parseJson(text);
    if (empty) return { config: null, issues: [], warnings: [] };
    if (issues.length > 0) return { config: null, issues, warnings: [] };
    if (!isPlainObject(value)) {
        return { config: null, issues: [issue('$', '知识库配置必须是一个 JSON 对象')], warnings: [] };
    }
    const warnings: DomainIssue[] = [];
    if (!checkVersion(value, issues)) return { config: null, issues, warnings };
    if (!Array.isArray(value.libraries)) {
        return { config: null, issues: [issue('$.libraries', 'libraries 必须是数组')], warnings: [] };
    }

    const libraries: KbEntry[] = [];
    const names: string[] = [];
    value.libraries.forEach((item, i) => {
        const path = `$.libraries[${i}]`;
        if (!isPlainObject(item)) {
            issues.push(issue(path, '知识库条目必须是对象'));
            return;
        }
        const name = readName(item.name, `${path}.name`, issues);
        if (item.description !== undefined && item.description !== null && typeof item.description !== 'string') {
            issues.push(issue(`${path}.description`, 'description 必须是字符串'));
        }
        const description = typeof item.description === 'string' ? item.description : '';
        const platforms = readPlatform(item.platform, `${path}.platform`, issues);
        const content = readContent(item.content, `${path}.content`, issues, 'content');
        names.push(name);
        libraries.push({ name, description, platforms, content });
    });
    for (const dup of findDuplicates(names)) issues.push(issue('$.libraries', `知识库名重复：${dup}`));
    return { config: issues.length > 0 ? null : { version: DOMAIN_VERSION, libraries }, issues, warnings };
}

/** 供测试/默认值比较：把字符串数组平台归一为数组 */
export function normalizePlatformList(value: unknown): string[] {
    return readPlatform(value, '$', []);
}

