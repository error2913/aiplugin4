// frontmatter 解析：统一 --- 块切分与元数据（name/description/platforms）解析。
// 技能(SKILL.md)、知识库(Markdown)、MCP(服务器条目)共用同一套解析；
// 不引入 YAML 依赖（goja 运行环境），只支持逐行 key: value 与 platform 的简单数组写法。

export interface FrontmatterMeta {
    name?: string;
    description?: string;
    /** 平台白名单（数组元素已去空白/引号）；缺省或空数组 = 所有平台 */
    platforms?: string[];
}

// 与既有解析保持一致的 frontmatter 块切分：必须整段以 --- 开头、以 --- 结尾
const FM_BLOCK_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

function unquote(value: string): string {
    return value.trim().replace(/^['"]|['"]$/g, '');
}

/**
 * 解析 platform 字段值 → 平台名数组。
 * 支持 platform: [QQ, DISCORD]、platform: [ "QQ" , "DISCORD" ]、platform: QQ；
 * 空值 / 空数组 / 缺省 → undefined（= 所有平台）。
 */
export function parsePlatformField(value: string): string[] | undefined {
    let v = String(value ?? '').trim();
    if (!v) return undefined;
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    const parts = v
        .split(',')
        .map(s => unquote(s))
        .filter(Boolean);
    if (parts.length === 0) return undefined;
    return parts;
}

/** 解析 frontmatter 内容块（不含首尾 --- 行）为元数据 */
export function parseFrontmatterMeta(raw: string): FrontmatterMeta {
    const meta: FrontmatterMeta = {};
    for (const line of String(raw ?? '').split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (!value) continue;
        if (key === 'name') meta.name = unquote(value);
        else if (key === 'description') meta.description = unquote(value);
        else if (key === 'platform') meta.platforms = parsePlatformField(value);
    }
    return meta;
}

/** 拆分文本：命中 frontmatter 块返回 { meta, body }，否则返回 null */
export function splitFrontmatter(text: string): { meta: FrontmatterMeta; body: string } | null {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    const m = normalized.match(FM_BLOCK_RE);
    if (!m) return null;
    return { meta: parseFrontmatterMeta(m[1]), body: m[2].trim() };
}
