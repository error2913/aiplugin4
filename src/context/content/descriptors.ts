// Content AST 标签描述符注册表（叶子层，纯逻辑）：
// - 每个标签只有一处定义：parsing / 规范文本投影 / 模型投影 / 平台投影 / 防注入策略；
// - Part 类型唯一来源是 ../events（不在这里重复定义）；
// - 不依赖 seal / Image / Config，媒体解析与平台能力全部由调用方注入。
//
// 三层格式规范（见 .dev/context-content-part-mapping.md）：
//   入口宽松（text_parse.ts 处理全角/旧标签/别名/转义）
//   内部严格（Part 唯一形状；文本 part 存"逻辑文本"）
//   出口唯一（renderText / toLLM / toPlatform 各平台只有一种投影）
import type { Part } from "../events";

// ---------------- 模式与能力 ----------------

/** 解析模式：决定可发送标签是"真标签"还是"字面量文本" */
export type ParseMode = 'user' | 'internal' | 'external' | 'model-output';

/** 标签防注入策略（见映射表 §六） */
export type TagPolicy = 'internal' | 'sendable' | 'context';

/** 模型能力：vision=false 时图片/头像只给规范文本标签 */
export interface LLMCaps {
    vision?: boolean;
    audio?: boolean;
}

/** 媒体解析（CIR ref → 模型可消费的 URL）；纯逻辑层不 import Image */
export interface MediaResolvers {
    imageUrl?(ref: string): string | null | undefined;
    avatarUrl?(uid: string): string | null | undefined;
    groupAvatarUrl?(gid: string): string | null | undefined;
}

export interface LLMTextPiece {
    kind: 'text';
    text: string;
}

export interface LLMImagePiece {
    kind: 'image';
    /** 原 CIR 引用（模型侧也要可见，见映射表 §七） */
    ref: string;
    url: string;
    alt?: string;
}

/** 中性模型投影：由 llm.ts 再转成 OpenAI / Anthropic 方言内容块 */
export type LLMPiece = LLMTextPiece | LLMImagePiece;

/** 平台能力：缺省视为支持（显式 false 才降级） */
export interface PlatformCaps {
    image?: boolean;
    record?: boolean;
    video?: boolean;
    file?: boolean;
    forward?: boolean;
    face?: boolean;
    at?: boolean;
    poke?: boolean;
    quote?: boolean;
    markdown?: boolean;
}

export type PlatformKind = keyof PlatformCaps;

/** 平台消息段（结构化输出；空 data 也表示段存在） */
export interface PlatformSegment {
    type: string;
    data: Record<string, unknown>;
}

/** 平台媒体解析（发送侧）；返回 null 表示取不到，调用方降级为规范文本 */
export interface PlatformHooks {
    imageFile?(ref: string): string | null | undefined;
    avatarFile?(uid: string): string | null | undefined;
    groupAvatarFile?(gid: string): string | null | undefined;
    recordFile?(handle: string): string | null | undefined;
    videoFile?(handle: string): string | null | undefined;
    fileFile?(handle: string): string | null | undefined;
    forwardId?(id: string): string | null | undefined;
    faceId?(name: string): string | null | undefined;
    uidToRaw?(uid: string): string | number | null | undefined;
    quoteToRaw?(id: string): string | number | null | undefined;
}

/** 一个内容标签的描述符；P 为其对应的 Part 子类型 */
export interface ContentDescriptor<P extends Part = Part> {
    /** 文本标签名（规范写法，如 at/img/record） */
    tag: string;
    /** 宽松接受的历史别名（如 user_avatar、audio） */
    aliases?: readonly string[];
    policy: TagPolicy;
    /** 规范文本投影是否为闭合标签（[tag:…]body[/tag]） */
    closed?: boolean;
    /** 是否额外接受旧式闭合写法（仅 face 使用：[face]name[/face]） */
    legacyClosed?: boolean;
    /** 解析单行标签头（content = 冒号后内容），无法解析返回 null → 降级 */
    parseTag(content: string, mode: ParseMode): P | null;
    /** 闭合标签体（body）解析：header 为 [tag:header] 的 header，可为空 */
    parseClosed?(header: string, body: string, mode: ParseMode): P | null;
    /** 唯一规范文本投影 */
    renderText(part: P): string;
    /** 模型投影：文本走 string；图片类在有视觉时返回 image piece */
    toLLM(part: P, caps: LLMCaps, resolve: MediaResolvers): LLMPiece | string;
    /** 平台投影：返回消息段；返回 string 表示按顶层文本降级 */
    toPlatform(part: P, caps: PlatformCaps, hooks: PlatformHooks): PlatformSegment | string;
}

/** 内部上下文标签（只进渲染结果，绝不进存储） */
export interface InternalTagMeta {
    tag: string;
    aliases?: readonly string[];
    policy: 'internal';
    /** 是否存在成对写法（[system]…[/system] / [tool_result]…[/tool_result]） */
    closed: boolean;
}

// ---------------- 基础工具 ----------------

const TAG_NAME_RE = /[A-Za-z_]/;

/** 规范化标签名（小写、下划线保留） */
export function normalizeTagName(name: string): string {
    return String(name || '').trim().toLowerCase();
}

/** 把标签字段里的破坏性字符压平：换行/制表 → 空格，`]`/`］` → 全角右括号 */
export function sanitizeTagValue(value: unknown): string {
    return String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/]/g, '］')
        .replace(/］+/g, '］')
        .trim();
}

/** id 类字段额外把全角冒号归一成半角（平台 uid / 消息 id 只用半角冒号） */
export function sanitizeIdValue(value: unknown): string {
    return sanitizeTagValue(value).replace(/：/g, ':');
}

/** 能力判断：显式 false 才视为不支持 */
export function supports(caps: PlatformCaps | undefined, kind: PlatformKind): boolean {
    return !caps || caps[kind] !== false;
}

/** CQ 值转义（与 transport 既有 encodeNativeMessage 口径一致） */
export function escapeCQValue(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/\[/g, '&#91;')
        .replace(/]/g, '&#93;')
        .replace(/,/g, '&#44;');
}

/**
 * 从文本的 pos（指向 `[` / `［`）读取标签名：
 * 支持 `[tag]`、`[tag:…]`、`[/tag]`，返回小写标签名（不含斜杠）；不是标签语法返回 null。
 */
export function tagNameAt(text: string, pos: number): string | null {
    if (!text || pos < 0 || pos >= text.length) return null;
    const open = text[pos];
    if (open !== '[' && open !== '［') return null;
    let i = pos + 1;
    if (text[i] === '/' || text[i] === '／') i++;
    let name = '';
    while (i < text.length && TAG_NAME_RE.test(text[i])) {
        name += text[i];
        i++;
    }
    if (!name) return null;
    const next = text[i];
    if (next === ':' || next === '：' || next === ']' || next === '］') return name.toLowerCase();
    return null;
}

/** 标签名/别名 → 内容描述符 */
export function getContentDescriptor(tagOrAlias: string): ContentDescriptor | null {
    const name = normalizeTagName(tagOrAlias);
    const direct = CONTENT_BY_TAG.get(name);
    if (direct) return direct;
    const canonical = ALIAS_TO_TAG.get(name);
    return canonical ? CONTENT_BY_TAG.get(canonical) ?? null : null;
}

/** Part.type → 内容描述符（text 也有描述符） */
export function getDescriptorForPart(part: Part): ContentDescriptor {
    return PART_TYPE_TO_DESCRIPTOR[part.type];
}

/** 标签名/别名 → 内部标签元信息 */
export function getInternalTag(tagOrAlias: string): InternalTagMeta | null {
    return INTERNAL_BY_TAG.get(normalizeTagName(tagOrAlias)) ?? null;
}

/** 是否是已登记的标签名（内容标签或内部标签，含别名） */
export function isRegisteredTagName(tagOrAlias: string): boolean {
    return !!getContentDescriptor(tagOrAlias) || !!getInternalTag(tagOrAlias);
}

/**
 * 规范文本投影转义：把文本里**看起来像标签**的 `[` / `［` 前缀加反斜杠，
 * 保证 `parseText(renderText(part)) === part`（INV-O）且字面标签不会被下游误当标签。
 * - 只处理"标签语法形态"（`[name]` / `[name:…]` / `[/name]`），普通方括号文本不受影响；
 * - 未登记的标签名同样转义：否则 model-output 解析会把字面文本升级成 unknown part，破坏往返；
 * - 幂等：已经带反斜杠的不重复转义。
 */
export function escapeTagLiteral(text: string): string {
    const source = String(text ?? '');
    if (!source.includes('[') && !source.includes('［')) return source;
    let out = '';
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (ch !== '[' && ch !== '［') {
            out += ch;
            continue;
        }
        const prev = i > 0 ? source[i - 1] : '';
        if (prev === '\\') {
            out += ch;
            continue;
        }
        if (tagNameAt(source, i)) out += `\\${ch}`;
        else out += ch;
    }
    return out;
}

/** 转义文本里所有标签名前缀（用于 external 输入把可发送标签变字面量） */
export function escapeAllTagLiterals(text: string): string {
    return escapeTagLiteral(text);
}

/** 解析 `[img:ref:desc]` 的 ref/desc：首个冒号后为描述；URL/data 形式整段视为 ref */
export function splitImageRefAndDesc(content: string): { ref: string; desc?: string } {
    const raw = String(content ?? '').trim();
    if (!raw) return { ref: '' };
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|data:)/i.test(raw)) return { ref: sanitizeTagValue(raw) };
    const half = raw.indexOf(':');
    const full = raw.indexOf('：');
    const colon = half < 0 ? full : full < 0 ? half : Math.min(half, full);
    if (colon < 0) return { ref: sanitizeTagValue(raw) };
    const ref = sanitizeTagValue(raw.slice(0, colon));
    const desc = sanitizeTagValue(raw.slice(colon + 1));
    return desc ? { ref, desc } : { ref };
}

// ---------------- 各 Part 描述符 ----------------

const TEXT_DESCRIPTOR: ContentDescriptor<{ type: 'text'; text: string }> = {
    tag: 'text',
    policy: 'context',
    parseTag: () => null,
    renderText: part => escapeTagLiteral(part.text),
    toLLM: part => escapeTagLiteral(part.text),
    toPlatform: part => part.text,
};

const mentionDescriptor: ContentDescriptor<{ type: 'mention'; id: string; all?: true }> = {
    tag: 'at',
    aliases: ['mention'],
    policy: 'sendable',
    parseTag(content) {
        const value = sanitizeIdValue(content);
        if (!value) return null;
        if (value.toLowerCase() === 'all') return { type: 'mention', id: 'all', all: true };
        return { type: 'mention', id: value };
    },
    renderText(part) {
        return part.all || part.id.toLowerCase() === 'all' ? '[at:all]' : `[at:${sanitizeIdValue(part.id)}]`;
    },
    toLLM(part) {
        return mentionDescriptor.renderText(part);
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'at')) return this.renderText(part);
        if (part.all || part.id.toLowerCase() === 'all') return { type: 'at', data: { qq: 'all' } };
        const raw = hooks.uidToRaw?.(part.id);
        if (raw === null || raw === undefined || raw === '') return this.renderText(part);
        return { type: 'at', data: { qq: raw } };
    },
};

const quoteDescriptor: ContentDescriptor<{ type: 'quote'; id: string }> = {
    tag: 'quote',
    policy: 'sendable',
    parseTag(content) {
        const id = sanitizeIdValue(content);
        return id ? { type: 'quote', id } : null;
    },
    renderText(part) {
        return `[quote:${sanitizeIdValue(part.id)}]`;
    },
    toLLM(part) {
        return quoteDescriptor.renderText(part);
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'quote')) return this.renderText(part);
        const raw = hooks.quoteToRaw?.(part.id);
        if (raw === null || raw === undefined || raw === '') return this.renderText(part);
        return { type: 'reply', data: { id: String(raw) } };
    },
};

const imageDescriptor: ContentDescriptor<{ type: 'image'; ref: string; desc?: string }> = {
    tag: 'img',
    aliases: ['image'],
    policy: 'sendable',
    parseTag(content) {
        const { ref, desc } = splitImageRefAndDesc(content);
        if (!ref) return null;
        return desc ? { type: 'image', ref, desc } : { type: 'image', ref };
    },
    renderText(part) {
        const ref = sanitizeTagValue(part.ref);
        const desc = part.desc ? sanitizeTagValue(part.desc) : '';
        return desc ? `[img:${ref}:${desc}]` : `[img:${ref}]`;
    },
    toLLM(part, caps, resolve) {
        const tag = imageDescriptor.renderText(part);
        if (!caps.vision) return tag;
        const url = resolve.imageUrl?.(part.ref);
        if (!url) return tag;
        return { kind: 'image', ref: part.ref, url, ...(part.desc ? { alt: part.desc } : {}) };
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'image')) return this.renderText(part);
        const file = hooks.imageFile?.(part.ref);
        if (!file) return this.renderText(part);
        return { type: 'image', data: { file } };
    },
};

const avatarDescriptor: ContentDescriptor<{ type: 'avatar'; uid: string }> = {
    tag: 'avatar',
    aliases: ['user_avatar'],
    policy: 'sendable',
    parseTag(content) {
        const uid = sanitizeIdValue(content);
        return uid ? { type: 'avatar', uid } : null;
    },
    renderText(part) {
        return `[avatar:${sanitizeIdValue(part.uid)}]`;
    },
    toLLM(part, caps, resolve) {
        const tag = avatarDescriptor.renderText(part);
        if (!caps.vision) return tag;
        const url = resolve.avatarUrl?.(part.uid);
        return url ? { kind: 'image', ref: `user_avatar:${part.uid}`, url } : tag;
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'image')) return this.renderText(part);
        const file = hooks.avatarFile?.(part.uid);
        return file ? { type: 'image', data: { file } } : this.renderText(part);
    },
};

const groupAvatarDescriptor: ContentDescriptor<{ type: 'group_avatar'; gid: string }> = {
    tag: 'group_avatar',
    policy: 'sendable',
    parseTag(content) {
        const gid = sanitizeIdValue(content);
        return gid ? { type: 'group_avatar', gid } : null;
    },
    renderText(part) {
        return `[group_avatar:${sanitizeIdValue(part.gid)}]`;
    },
    toLLM(part, caps, resolve) {
        const tag = groupAvatarDescriptor.renderText(part);
        if (!caps.vision) return tag;
        const url = resolve.groupAvatarUrl?.(part.gid);
        return url ? { kind: 'image', ref: `group_avatar:${part.gid}`, url } : tag;
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'image')) return this.renderText(part);
        const file = hooks.groupAvatarFile?.(part.gid);
        return file ? { type: 'image', data: { file } } : this.renderText(part);
    },
};

function makeClosedMediaDescriptor(
    tag: 'record' | 'video' | 'file',
    partType: 'record' | 'video' | 'file',
    cap: 'record' | 'video' | 'file',
    hook: 'recordFile' | 'videoFile' | 'fileFile',
    aliases: readonly string[] = [],
): ContentDescriptor<{ type: typeof partType; handle: string; summary?: string }> {
    const descriptor: ContentDescriptor<{ type: typeof partType; handle: string; summary?: string }> = {
        tag,
        aliases,
        policy: 'context',
        closed: true,
        parseTag(content) {
            const handle = sanitizeTagValue(content);
            return handle ? { type: partType, handle } : null;
        },
        parseClosed(header, body) {
            const handle = sanitizeTagValue(header);
            if (!handle) return null;
            const summary = sanitizeTagValue(body);
            return summary ? { type: partType, handle, summary } : { type: partType, handle };
        },
        renderText(part) {
            const handle = sanitizeTagValue(part.handle);
            const summary = part.summary ? sanitizeTagValue(part.summary) : '';
            return `[${tag}:${handle}]${summary}[/${tag}]`;
        },
        toLLM(part) {
            return descriptor.renderText(part);
        },
        toPlatform(part, caps, hooks) {
            if (!supports(caps, cap)) return this.renderText(part);
            const file = hooks[hook]?.(part.handle);
            return file ? { type: tag, data: { file } } : this.renderText(part);
        },
    };
    return descriptor;
}

const recordDescriptor = makeClosedMediaDescriptor('record', 'record', 'record', 'recordFile', ['audio']);
const videoDescriptor = makeClosedMediaDescriptor('video', 'video', 'video', 'videoFile');
const fileDescriptor = makeClosedMediaDescriptor('file', 'file', 'file', 'fileFile');

const faceDescriptor: ContentDescriptor<{ type: 'face'; name: string }> = {
    tag: 'face',
    policy: 'sendable',
    legacyClosed: true,
    parseTag(content) {
        const name = sanitizeTagValue(content);
        return name ? { type: 'face', name } : null;
    },
    renderText(part) {
        return `[face:${sanitizeTagValue(part.name)}]`;
    },
    toLLM(part) {
        return faceDescriptor.renderText(part);
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'face')) return this.renderText(part);
        const id = hooks.faceId?.(part.name);
        return id ? { type: 'face', data: { id } } : this.renderText(part);
    },
};

const pokeDescriptor: ContentDescriptor<{ type: 'poke'; id: string }> = {
    tag: 'poke',
    policy: 'sendable',
    parseTag(content) {
        const id = sanitizeIdValue(content);
        return id ? { type: 'poke', id } : null;
    },
    renderText(part) {
        return `[poke:${sanitizeIdValue(part.id)}]`;
    },
    toLLM(part) {
        return pokeDescriptor.renderText(part);
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'poke')) return this.renderText(part);
        const raw = hooks.uidToRaw?.(part.id);
        if (raw === null || raw === undefined || raw === '') return this.renderText(part);
        return { type: 'poke', data: { qq: raw } };
    },
};

const forwardDescriptor: ContentDescriptor<{ type: 'forward'; id: string }> = {
    tag: 'forward',
    policy: 'context',
    parseTag(content) {
        const id = sanitizeIdValue(content);
        return id ? { type: 'forward', id } : null;
    },
    renderText(part) {
        return `[forward:${sanitizeIdValue(part.id)}]`;
    },
    toLLM(part) {
        return forwardDescriptor.renderText(part);
    },
    toPlatform(part, caps, hooks) {
        if (!supports(caps, 'forward')) return this.renderText(part);
        const id = hooks.forwardId?.(part.id);
        return id ? { type: 'forward', data: { id } } : this.renderText(part);
    },
};

const markdownDescriptor: ContentDescriptor<{ type: 'markdown'; text: string }> = {
    tag: 'markdown',
    policy: 'context',
    closed: true,
    parseTag(content) {
        const text = String(content ?? '');
        return text ? { type: 'markdown', text } : null;
    },
    parseClosed(_header, body) {
        return { type: 'markdown', text: String(body ?? '') };
    },
    renderText(part) {
        return `[markdown]${part.text}[/markdown]`;
    },
    toLLM(part) {
        return part.text;
    },
    toPlatform(part, caps) {
        return supports(caps, 'markdown')
            ? { type: 'markdown', data: { content: part.text } }
            : part.text;
    },
};

const resourceDescriptor: ContentDescriptor<{
    type: 'resource';
    uri: string;
    name?: string;
    mime?: string;
}> = {
    tag: 'resource',
    policy: 'context',
    closed: true,
    parseTag(content) {
        const parsed = parseResourceHeader(content);
        return parsed ? { type: 'resource', ...parsed } : null;
    },
    parseClosed(header, body) {
        const parsed = parseResourceHeader(header);
        if (!parsed) return null;
        const name = sanitizeTagValue(body);
        return name ? { type: 'resource', ...parsed, name } : { type: 'resource', ...parsed };
    },
    renderText(part) {
        const uri = sanitizeTagValue(part.uri);
        const mime = part.mime ? `|mime=${sanitizeTagValue(part.mime)}` : '';
        const name = part.name ? sanitizeTagValue(part.name) : '';
        return name ? `[resource:${uri}${mime}]${name}[/resource]` : `[resource:${uri}${mime}]`;
    },
    toLLM(part) {
        return part.name ? `${part.name} (${part.uri})` : resourceDescriptor.renderText(part);
    },
    toPlatform(part) {
        return part.name ? `${part.name} (${part.uri})` : resourceDescriptor.renderText(part);
    },
};

/** `[resource:<uri>[|mime=<mime>]]` 的 header 解析 */
function parseResourceHeader(content: string): { uri: string; mime?: string } | null {
    const raw = String(content ?? '').trim();
    if (!raw) return null;
    const sep = raw.lastIndexOf('|mime=');
    if (sep < 0) {
        const uri = sanitizeTagValue(raw);
        return uri ? { uri } : null;
    }
    const uri = sanitizeTagValue(raw.slice(0, sep));
    const mime = sanitizeTagValue(raw.slice(sep + 6));
    if (!uri) return null;
    return mime ? { uri, mime } : { uri };
}

const unknownDescriptor: ContentDescriptor<{ type: 'unknown'; tag: string; content: string }> = {
    tag: 'unknown',
    policy: 'context',
    parseTag() {
        return null;
    },
    renderText(part) {
        return `[${sanitizeTagValue(part.tag)}:${sanitizeTagValue(part.content)}]`;
    },
    toLLM(part) {
        return unknownDescriptor.renderText(part);
    },
    toPlatform(part) {
        return unknownDescriptor.renderText(part);
    },
};

// ---------------- 注册表 ----------------

/** 全部内容标签描述符（含 text；顺序即注册顺序，不承载语义） */
export const CONTENT_DESCRIPTORS: readonly ContentDescriptor[] = [
    TEXT_DESCRIPTOR,
    mentionDescriptor,
    quoteDescriptor,
    imageDescriptor,
    avatarDescriptor,
    groupAvatarDescriptor,
    recordDescriptor,
    videoDescriptor,
    fileDescriptor,
    faceDescriptor,
    pokeDescriptor,
    forwardDescriptor,
    markdownDescriptor,
    resourceDescriptor,
    unknownDescriptor,
];

/** 内部标签元信息（永不进入 Part，只在渲染结果里出现） */
export const INTERNAL_TAGS: readonly InternalTagMeta[] = [
    { tag: 'from', policy: 'internal', closed: false },
    { tag: 'msg_id', policy: 'internal', closed: false },
    { tag: 'system', policy: 'internal', closed: true },
    { tag: 'time', policy: 'internal', closed: false },
    { tag: 'tool_result', policy: 'internal', closed: true },
];

const CONTENT_BY_TAG = new Map<string, ContentDescriptor>();
const ALIAS_TO_TAG = new Map<string, string>();
const INTERNAL_BY_TAG = new Map<string, InternalTagMeta>();
const PART_TYPE_TO_DESCRIPTOR: Record<Part['type'], ContentDescriptor> = {
    text: TEXT_DESCRIPTOR as unknown as ContentDescriptor,
    mention: mentionDescriptor as unknown as ContentDescriptor,
    quote: quoteDescriptor as unknown as ContentDescriptor,
    image: imageDescriptor as unknown as ContentDescriptor,
    avatar: avatarDescriptor as unknown as ContentDescriptor,
    group_avatar: groupAvatarDescriptor as unknown as ContentDescriptor,
    record: recordDescriptor as unknown as ContentDescriptor,
    video: videoDescriptor as unknown as ContentDescriptor,
    file: fileDescriptor as unknown as ContentDescriptor,
    face: faceDescriptor as unknown as ContentDescriptor,
    poke: pokeDescriptor as unknown as ContentDescriptor,
    forward: forwardDescriptor as unknown as ContentDescriptor,
    markdown: markdownDescriptor as unknown as ContentDescriptor,
    resource: resourceDescriptor as unknown as ContentDescriptor,
    unknown: unknownDescriptor as unknown as ContentDescriptor,
};

for (const descriptor of CONTENT_DESCRIPTORS) {
    CONTENT_BY_TAG.set(descriptor.tag, descriptor);
    for (const alias of descriptor.aliases || []) ALIAS_TO_TAG.set(alias, descriptor.tag);
}
for (const descriptor of CONTENT_DESCRIPTORS) ALIAS_TO_TAG.set(descriptor.tag, descriptor.tag);
for (const meta of INTERNAL_TAGS) {
    INTERNAL_BY_TAG.set(meta.tag, meta);
    for (const alias of meta.aliases || []) INTERNAL_BY_TAG.set(alias, meta);
}

/** 所有已登记标签名（内容 + 内部 + 别名），供文档/测试/诊断使用 */
export function registeredTagNames(): string[] {
    return [...CONTENT_BY_TAG.keys(), ...INTERNAL_BY_TAG.keys(), ...ALIAS_TO_TAG.keys()];
}
