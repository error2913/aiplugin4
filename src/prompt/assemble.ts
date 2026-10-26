// Prompt 组装器：段级流式组装（并行 build → 空段丢弃 → 截断 → 清洗 → hook → 拼接 → digest）。
import Logger from "../logger";
import { stripInternalTags } from "../utils/render_tags";

import { getCachedStringInfo } from "./prompt_cache";
import { EXTENSION_TOTAL_MAX_CHARS, resolvePromptSections } from "./registry";
import type { PromptContext, PromptParts, PromptSection, SectionStat } from "./types";

const log = Logger.withTag('prompt');

/** 段级缓存默认 TTL */
export const DEFAULT_SECTION_TTL = 30_000;
/** 全局段预算（字符）：0 = 关闭；>0 时从 order 最大的 optional 段开始丢弃 */
export const GLOBAL_PROMPT_BUDGET_CHARS = 0;
/** 截断占位符 */
const ELLIPSIS = '…';

/** 组装 hook：可整体改写 system/runtime 文本（外部插件扩展点） */
export type PromptAssembleHook = (parts: { system: string; runtime: string }) => { system?: string; runtime?: string } | void;

const hooks: PromptAssembleHook[] = [];

/** 注册组装 hook（按注册顺序依次执行） */
export function onPromptAssemble(hook: PromptAssembleHook): void {
    if (typeof hook === 'function') hooks.push(hook);
}

/** 清空 hook（测试 / JS 重载用） */
export function resetPromptHooks(): void {
    hooks.length = 0;
}

/** 文本归一：CRLF→LF、去首尾空白、折叠 3 个以上连续换行 */
function normalizeText(text: string): string {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 单段字符上限截断 */
function truncateTo(text: string, max?: number): string {
    if (!max || max <= 0 || text.length <= max) return text;
    return text.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

/** FNV-1a 32 位短哈希（Goja 可运行） */
function fnv1a(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** 段依赖签名：把 deps 返回值拼成稳定字符串 */
function depsKey(section: PromptSection, ctx: PromptContext): string {
    const deps = section.cache && section.cache.deps ? section.cache.deps(ctx) : [];
    return (deps || []).map(value => String(value)).join('|');
}

/** 执行一段的构建 + 归一/清洗/截断（缓存存的是最终文本） */
async function buildOnce(section: PromptSection, ctx: PromptContext): Promise<string> {
    let raw = '';
    try {
        raw = String((await section.build(ctx)) ?? '');
    } catch (error) {
        log.warning(`提示词段构建失败已跳过：${section.name}：${error instanceof Error ? error.message : String(error)}`);
        return '';
    }
    let text = normalizeText(raw);
    if (!text) return '';
    if ((section.sanitize || 'trusted') === 'external') text = normalizeText(stripInternalTags(text));
    if (!text) return '';
    return truncateTo(text, section.maxChars);
}

/** 构建单段（带段级缓存） */
async function buildSection(section: PromptSection, ctx: PromptContext): Promise<{ text: string; cache: SectionStat['cache'] }> {
    if (!section.cache) {
        return { text: await buildOnce(section, ctx), cache: 'none' };
    }
    const ttl = section.cache.ttlMs ?? DEFAULT_SECTION_TTL;
    const key = `sect:${section.name}|${depsKey(section, ctx)}`;
    const result = await getCachedStringInfo(key, ttl, () => buildOnce(section, ctx));
    return { text: result.value, cache: result.hit ? 'hit' : 'miss' };
}

function statOf(section: PromptSection, text: string, cache: SectionStat['cache']): SectionStat {
    const chars = text.length;
    return {
        name: section.name,
        order: section.order,
        channel: section.channel,
        chars,
        tokens: Math.ceil(chars / 3),
        cache,
    };
}

/** 组装一次提示词：返回 system / runtime 两路文本与统计。 */
export async function assemblePrompt(ctx: PromptContext): Promise<PromptParts> {
    const sections = resolvePromptSections();
    const built = await Promise.all(sections.map(async section => {
        const result = await buildSection(section, ctx);
        return { section, text: result.text, cache: result.cache };
    }));

    // 外部插件段总量上限：超过则按 order 丢弃后续扩展段
    let extensionChars = 0;
    const kept: Array<{ section: PromptSection; text: string; cache: SectionStat['cache'] }> = [];
    for (const item of built) {
        if (!item.text) continue;
        if (item.section.scope === 'extension') {
            if (extensionChars + item.text.length > EXTENSION_TOTAL_MAX_CHARS) {
                log.warning(`外部提示词段超出总预算已跳过：${item.section.name}`);
                continue;
            }
            extensionChars += item.text.length;
        }
        kept.push(item);
    }

    // 可选全局预算：从 order 最大的 optional 段开始丢弃
    let totalChars = kept.reduce((sum, item) => sum + item.text.length, 0);
    if (GLOBAL_PROMPT_BUDGET_CHARS > 0) {
        const droppable = kept
            .filter(item => item.section.optional)
            .slice()
            .sort((a, b) => b.section.order - a.section.order);
        for (const item of droppable) {
            if (totalChars <= GLOBAL_PROMPT_BUDGET_CHARS) break;
            const index = kept.indexOf(item);
            if (index < 0) continue;
            totalChars -= item.text.length;
            kept.splice(index, 1);
            log.warning(`提示词超出全局预算，已丢弃可选项：${item.section.name}`);
        }
    }

    const stats = kept.map(item => statOf(item.section, item.text, item.cache));
    const join = (channel: 'system' | 'runtime'): string => kept
        .filter(item => item.section.channel === channel)
        .map(item => item.text)
        .join('\n\n');

    let system = join('system');
    let runtime = join('runtime');

    for (const hook of hooks) {
        try {
            const patched = hook({ system, runtime });
            if (patched && typeof patched === 'object') {
                if (typeof patched.system === 'string') system = normalizeText(patched.system);
                if (typeof patched.runtime === 'string') runtime = normalizeText(patched.runtime);
            }
        } catch (error) {
            log.warning(`提示词组装 hook 执行失败已忽略：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const digest = fnv1a(`${system}\n--\n${runtime}`);
    const misses = stats.filter(item => item.cache === 'miss').length;
    log.debug(`prompt: ${stats.length} sections, ${system.length}+${runtime.length} chars, ${misses} misses, digest=${digest}`);

    return { system, runtime, stats, digest };
}

/** 段统计表（`.ai prompt sections` 使用） */
export function renderSectionTable(parts: PromptParts): string {
    const lines = [
        `# prompt digest ${parts.digest} · system ${parts.system.length} chars · runtime ${parts.runtime.length} chars · ${parts.stats.length} sections`,
        'order  name                          channel  chars  tokens  cache',
    ];
    for (const stat of parts.stats) {
        lines.push(
            `${String(stat.order).padStart(5)}  ${stat.name.padEnd(28)}  ${stat.channel.padEnd(7)}  ${String(stat.chars).padStart(5)}  ${String(stat.tokens).padStart(6)}  ${stat.cache}`,
        );
    }
    return lines.join('\n');
}
