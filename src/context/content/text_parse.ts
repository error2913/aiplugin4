// 宽松文本解析：把任意来源的字符串解析成规范 Part[]（标签只是文本投影）。
//
// 宽容点（入口宽松）：
// - 全角括号/冒号 `［］：`；
// - 旧版 `<|at:…|>` / `＜｜…＞` 渲染标签（含 `img:user_avatar:` 拆分）；
// - 别名：`user_avatar`→`avatar`、`audio`→`record`、`[img:user_avatar:x]`→`avatar`；
// - 图片描述含冒号（首个冒号后全部当描述；URL/data 整段当 ref）；
// - 反斜杠转义的字面标签 `\[at:all]` 不当标签、内容不丢；
// - 未知标签：user/external 降级为字面量文本；internal/model-output 降级为 unknown（内容保留）。
//
// 防注入（见 .dev/context-content-part-mapping.md §六）：
// - user / external 模式下，sendable + context 标签**只作字面量文本**，不会变成可发送/可伪造句柄的 Part；
// - internal 标签（from/msg_id/system/time/tool_result）永不进入 Part；user 模式成对标签连内容一起删；
// - model-output / internal 模式才把标签解析成 Part。
import type { Part } from "../events";

import {
    ContentDescriptor,
    getContentDescriptor,
    getInternalTag,
    isRegisteredTagName,
    ParseMode,
    sanitizeTagValue,
    tagNameAt,
} from "./descriptors";

/** 旧版 `<|...|>` 标签归一化为新标签（纯文本层，不解析）；用于兼容历史回复/上下文。 */
const LEGACY_TAG_CONTENT = '[^|｜>＞]+?';
const LEGACY_TAG_CLOSE = '(?:[\\|│｜][>＞]|[\\|│｜>＞])';

export function normalizeLegacyTags(text: string): string {
    let s = String(text ?? '');
    if (!s) return s;
    // 旧 <|img:…|> / <|img:user_avatar:…|>
    s = s.replace(
        new RegExp(
            `[<＜][\\|│｜]img[:：]?\\s?(?:user_avatar[:：]?(${LEGACY_TAG_CONTENT})|group_avatar[:：]?(${LEGACY_TAG_CONTENT})|(${LEGACY_TAG_CONTENT}))${LEGACY_TAG_CLOSE}`,
            'gi',
        ),
        (_all: string, user: string | undefined, group: string | undefined, img: string | undefined) =>
            user ? `[avatar:${user}]` : group ? `[group_avatar:${group}]` : `[img:${img}]`,
    );
    // 旧 <|at|x|> / <|audio|…|> / <|user_avatar|…|> 等
    s = s.replace(
        new RegExp(
            `[<＜][\\|│｜](at|poke|quote|face|img|audio|from|msg_id|system|time|user_avatar|group_avatar)[:：]?\\s?(${LEGACY_TAG_CONTENT})${LEGACY_TAG_CLOSE}`,
            'gi',
        ),
        (_all: string, type: string, content: string) => {
            const tag = type.toLowerCase();
            if (tag === 'user_avatar') return `[avatar:${content}]`;
            if (tag === 'audio') return `[record:${content}]`;
            return `[${tag}:${content}]`;
        },
    );
    // 新标签别名： [img:user_avatar:UID] / [img:group_avatar:GID] / [user_avatar:UID] / [audio:HANDLE]
    s = s.replace(
        /(\[|［)img[:：](user_avatar|group_avatar)[:：]\s*([^\]］]+)(\]|］)/gi,
        (_all, open: string, kind: string, id: string, close: string) => {
            const flag = open === '［' ? '［' : '[';
            const end = close === '］' ? '］' : ']';
            return kind.toLowerCase() === 'user_avatar' ? `${flag}avatar:${id}${end}` : `${flag}group_avatar:${id}${end}`;
        },
    );
    s = s.replace(
        /(\[|［)(user_avatar)[:：]\s*([^\]］]+)(\]|］)/gi,
        (_all, open: string, _alias: string, uid: string, close: string) => {
            const flag = open === '［' ? '［' : '[';
            const end = close === '］' ? '］' : ']';
            return `${flag}avatar:${uid}${end}`;
        },
    );
    s = s.replace(
        /(\[|［)(audio)[:：]\s*([^\]］]+)(\]|］)/gi,
        (_all, open: string, _alias: string, handle: string, close: string) => {
            const flag = open === '［' ? '［' : '[';
            const end = close === '］' ? '］' : ']';
            return `${flag}record:${handle}${end}`;
        },
    );
    return s;
}

interface TagRead {
    name: string;
    closing: boolean;
    /** 冒号后的内容（无冒号时为空串） */
    content: string;
    /** 标签结束后的下标（含闭合括号） */
    end: number;
    /** 原始片段（含括号） */
    raw: string;
}

/** 在 pos（指向 `[`/`［`）读取一个标签语法；不是标签语法返回 null */
function readTagAt(source: string, pos: number): TagRead | null {
    const open = source[pos];
    if (open !== '[' && open !== '［') return null;
    let i = pos + 1;
    let closing = false;
    if (source[i] === '/' || source[i] === '／') {
        closing = true;
        i++;
    }
    let name = '';
    while (i < source.length && /[A-Za-z_]/.test(source[i])) {
        name += source[i];
        i++;
    }
    if (!name) return null;
    const afterName = source[i];
    if (afterName !== ':' && afterName !== '：' && afterName !== ']' && afterName !== '］') return null;
    // 找闭合括号（允许内容里用 `\]` 转义）
    let j = i;
    while (j < source.length) {
        if (source[j] === '\\') {
            j += 2;
            continue;
        }
        if (source[j] === ']' || source[j] === '］') break;
        j++;
    }
    if (j >= source.length) return null;
    const rawContent = source.slice(i, j);
    const content = rawContent.startsWith(':') || rawContent.startsWith('：') ? rawContent.slice(1) : '';
    return {
        name: name.toLowerCase(),
        closing,
        content,
        end: j + 1,
        raw: source.slice(pos, j + 1),
    };
}

/** 从 from 开始找 `[/name]`（容忍全角）；找不到返回 null */
function findClosingTag(source: string, from: number, name: string): { body: string; next: number } | null {
    for (let i = from; i < source.length; i++) {
        const ch = source[i];
        if (ch !== '[' && ch !== '［') continue;
        if (i > from && source[i - 1] === '\\') continue;
        const tag = readTagAt(source, i);
        if (!tag || !tag.closing) continue;
        if (tag.name !== name) continue;
        return { body: source.slice(from, i), next: tag.end };
    }
    return null;
}

/** 追加 parts，合并相邻 text（保持规范化：不产生相邻 text part） */
function pushParts(target: Part[], parts: Part[]): void {
    for (const part of parts) {
        if (!part) continue;
        const last = target[target.length - 1];
        if (part.type === 'text' && last && last.type === 'text') last.text += part.text;
        else target.push(part);
    }
}

/**
 * 文本 → Part[]。
 * @param mode user=用户输入；external=工具/外部数据；internal=系统自产；model-output=模型回复
 */
export function parseText(text: string, mode: ParseMode = 'user'): Part[] {
    const source = normalizeLegacyTags(String(text ?? ''));
    const parts: Part[] = [];
    if (!source) return parts;
    let buffer = '';
    const flush = () => {
        if (buffer) {
            parts.push({ type: 'text', text: buffer });
            buffer = '';
        }
    };

    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        // 转义的字面标签：`\[at:all]` → 文本 "[at:all]"（去掉反斜杠，不再当标签）
        if (ch === '\\' && i + 1 < source.length) {
            const next = source[i + 1];
            if (next === '[' || next === '［') {
                const name = tagNameAt(source, i + 1);
                if (name) {
                    // 保留原括号形态（半角/全角），只去掉转义反斜杠
                    buffer += next;
                    i += 2;
                    continue;
                }
            }
        }
        if (ch === '[' || ch === '［') {
            const tag = readTagAt(source, i);
            if (tag && !tag.closing) {
                const consumed = parseTagAt(source, i, tag, mode, parts, flush, literal => { buffer += literal; });
                if (consumed !== null) {
                    i = consumed;
                    continue;
                }
            } else if (tag && tag.closing) {
                // 未配对的闭合标签：按字面量保留（不丢内容）
                buffer += tag.raw;
                i = tag.end;
                continue;
            }
        }
        buffer += ch;
        i++;
    }
    flush();
    return mergeAdjacentText(parts);
}

/** 合并相邻 text part（递归解析/字面量回填可能产生相邻 text） */
function mergeAdjacentText(parts: Part[]): Part[] {
    const merged: Part[] = [];
    for (const part of parts) {
        const last = merged[merged.length - 1];
        if (part.type === 'text' && last && last.type === 'text') {
            last.text += part.text;
            continue;
        }
        merged.push(part);
    }
    return merged;
}

/**
 * 尝试解析 pos 处的一个标签；成功时把结果并入 parts 并返回新下标，失败返回 null（调用方按字面量处理）。
 */
function parseTagAt(
    source: string,
    start: number,
    tag: TagRead,
    mode: ParseMode,
    parts: Part[],
    flush: () => void,
    literal: (text: string) => void,
): number | null {
    const literalMode = mode === 'user' || mode === 'external';
    const internal = getInternalTag(tag.name);

    // ---- 内部标签：永不进入 Part ----
    if (internal) {
        const closed = internal.closed ? findClosingTag(source, tag.end, tag.name) : null;
        if (closed) {
            const body = closed.body;
            const next = closed.next;
            // user 模式：成对内部标签连内容一起删除（防注入）；其余模式保留内容
            if (mode !== 'user') {
                flush();
                pushParts(parts, parseText(body, mode));
            }
            return next;
        }
        // 单行内部标签：直接剥离
        return tag.end;
    }

    const descriptor = getContentDescriptor(tag.name);
    const closedInfo = descriptor && (descriptor.closed || descriptor.legacyClosed)
        ? findClosingTag(source, tag.end, tag.name)
        : null;

    // ---- user / external：标签只作字面量文本（sendable 不可发送、context 不可伪造句柄）----
    if (literalMode) {
        const spanEnd = closedInfo ? closedInfo.next : tag.end;
        literal(source.slice(start, spanEnd));
        return spanEnd;
    }

    // ---- internal / model-output：解析成 Part ----
    if (!descriptor) {
        // 未知标签：保留为 unknown（内容不丢）；闭合写法取 body 当内容
        flush();
        const content = closedInfo && tag.content === ''
            ? closedInfo.body
            : tag.content;
        parts.push({
            type: 'unknown',
            tag: sanitizeTagValue(tag.name),
            content: sanitizeTagValue(content),
        });
        return closedInfo ? closedInfo.next : tag.end;
    }

    let part: Part | null = null;
    if (descriptor.closed) {
        if (closedInfo) {
            part = descriptor.parseClosed
                ? descriptor.parseClosed(tag.content, closedInfo.body, mode)
                : descriptor.parseTag(closedInfo.body || tag.content, mode);
            if (!part && descriptor.parseClosed) part = descriptor.parseTag(tag.content, mode);
        } else {
            part = descriptor.parseTag(tag.content, mode);
        }
    } else if (descriptor.legacyClosed && closedInfo) {
        part = descriptor.parseTag(closedInfo.body || tag.content, mode) ?? descriptor.parseTag(tag.content, mode);
    } else {
        part = descriptor.parseTag(tag.content, mode);
    }

    if (!part) {
        // 解析失败：按字面量文本保留（不丢内容）
        literal(closedInfo ? source.slice(start, closedInfo.next) : tag.raw);
        return closedInfo ? closedInfo.next : tag.end;
    }
    flush();
    parts.push(part);
    return closedInfo ? closedInfo.next : tag.end;
}

/** 供 validate / 迁移复用的便捷函数：解析并保证不抛错 */
export function parseTextSafe(text: string, mode: ParseMode = 'user'): Part[] {
    try {
        return parseText(text, mode);
    } catch {
        return text ? [{ type: 'text', text: String(text) }] : [];
    }
}

/** 判断一个字符串里是否含已登记标签语法（供诊断/测试用） */
export function containsTagSyntax(text: string): boolean {
    const source = String(text ?? '');
    for (let i = 0; i < source.length; i++) {
        if (source[i] !== '[' && source[i] !== '［') continue;
        const name = tagNameAt(source, i);
        if (name && isRegisteredTagName(name)) return true;
    }
    return false;
}

/** 暴露给测试/工具：按标签名找描述符（空实现代理 descriptors） */
export function descriptorForTag(tag: string): ContentDescriptor | null {
    return getContentDescriptor(tag);
}
