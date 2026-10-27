// 渲染标签解析（叶子模块）：内部上下文标签剥离 / 转义保护 / 可发送标签（img/at/poke/quote/face/audio/avatar）
// 解析为 TokenSegment。纯函数、不依赖 Config / seal / Image，供 utils、transport 与各消费方直接引用，
// 避免为解析一个标签经 utils/string 拉进整圈依赖（见 deps:check 的 17 环）。

export interface TokenSegment {
    type: 'text' | 'at' | 'poke' | 'quote' | 'img' | 'avatar' | 'group_avatar' | 'face' | 'audio';
    content: string;
}

/** 旧版 <|xxx|> 渲染标签归一化为新版 [xxx]（含全角/缺竖杠变体）；仅用于 4.14.0 首次对话的历史数据迁移，解析层不再兼容旧标签 */
const RENDER_TAG_CONTENT = '[^|｜>＞]+?';
const RENDER_TAG_CLOSE = '(?:[\\|│｜][>＞]|[\\|│｜>＞])';

/** 将模型常见的字面量换行转义（\n / \r\n）还原为真实换行。
 * 注意：不处理 \f；\f 是内置多消息分隔符/内部消息边界，另可由「额外消息分隔符」配置追加分隔符。 */
export function decodeEscapedNewlines(s: string): string {
    return s
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n');
}

export function normalizeRenderTags(s: string): string {
    if (!s.includes('<')) return s;
    // 图片标签特殊处理：user_avatar/group_avatar 前缀拆成独立标签 [avatar]/[group_avatar]
    s = s.replace(
        new RegExp(`[<＜][\\|│｜]img[:：]?\\s?(?:user_avatar[:：]?(${RENDER_TAG_CONTENT})|group_avatar[:：]?(${RENDER_TAG_CONTENT})|(${RENDER_TAG_CONTENT}))${RENDER_TAG_CLOSE}`, 'gi'),
        (_all: string, user: string | undefined, group: string | undefined, img: string | undefined) =>
            user ? `[avatar:${user}]` : group ? `[group_avatar:${group}]` : `[img:${img}]`
    );
    return s.replace(
        new RegExp(`[<＜][\\|│｜](at|poke|quote|face|img|audio|from|msg_id|system|time|user_avatar|group_avatar)[:：]?\\s?(${RENDER_TAG_CONTENT})${RENDER_TAG_CLOSE}`, 'gi'),
        (_all: string, type: string, content: string) =>
            type === 'user_avatar' ? `[avatar:${content}]` : `[${type}:${content}]`
    );
}

/** 内部上下文标签名：由代码注入上下文，其余任何来源（用户输入/AI 回复/工具回调/记忆等）出现时一律剥离 */
const INTERNAL_TAG_NAMES = ['from', 'msg_id', 'system', 'time', 'tool_result'];
const INTERNAL_TAG_TYPES = new Set(INTERNAL_TAG_NAMES);

/** 可发送单行标签名：AI 输出可解析为消息段；用户输入中出现时转义为字面量 */
const SENDABLE_TAG_NAMES = ['at', 'poke', 'quote', 'img', 'avatar', 'group_avatar', 'face', 'audio'];

/** 上下文专用闭合标签名：仅渲染进上下文供 AI 阅读，不用于发送；
 *  用户输入中伪造的 [name]...[/name] 整段删除（record/video/file/face/xml/markdown/forward/node/music/card） */
const CLOSED_CONTEXT_TAG_NAMES = ['record', 'video', 'file', 'face', 'xml', 'markdown', 'forward', 'node', 'music', 'card'];

/** 全部插件标签名（用户输入剥离与渲染清洗共用） */
const ALL_TAG_NAMES = [...INTERNAL_TAG_NAMES, ...SENDABLE_TAG_NAMES, ...CLOSED_CONTEXT_TAG_NAMES];

/** 剥离内部上下文标签（from/msg_id/system/time/tool_result）：先归一化旧版 <|...|> 变体，再移除新/旧方括号格式（含全角）；
 *  保留 at/poke/quote/img/avatar/group_avatar/face/audio 等可发送标签与 record/video/file 等上下文闭合标签。
 *  注意：本函数保留闭合标签的内容（[system]内容[/system] → 内容），只用于系统自产内容流转；用户输入入口请用 stripUserTags。 */
export function stripInternalTags(s: string): string {
    if (!s) return s;
    s = normalizeRenderTags(s);
    return s.replace(new RegExp(`[[［][/／]?(?:${INTERNAL_TAG_NAMES.join('|')})[:：]?\\s?[^\\]］]*[\\]］]`, 'gi'), '');
}

/** 用户输入防注入剥离：整段删除伪造的闭合标签（[system]注入[/system]、[record:x]fake[/record]、[tool_result]...[/tool_result] 等，含内容），
 *  删除单行内部上下文标签（[system:...]/[from:...] 等），并把可发送/媒体单行标签转义为字面量（\\[at:all]、\\[img:xxx]），
 *  避免用户输入中的标签被当作上下文指令或发送指令。只用于用户原始文本入口（transformArrayToContent）。 */
export function stripUserTags(s: string): string {
    if (!s) return s;
    let out = normalizeRenderTags(s);
    // 1) 整段删除闭合标签 span（含内容），反复直到无残留（覆盖嵌套/多个相邻）
    const closedRe = new RegExp(`[[［](${INTERNAL_TAG_NAMES.concat(CLOSED_CONTEXT_TAG_NAMES).join('|')})[:：]?[^\\]］]*[\\]］][\\s\\S]*?[[［]/\\1[\\]］]`, 'gi');
    let prev = '';
    while (prev !== out) {
        prev = out;
        out = out.replace(closedRe, '');
    }
    // 2) 删除单行内部上下文标签（上下文专用，不应出现在用户输入）
    out = out.replace(new RegExp(`[[［](${INTERNAL_TAG_NAMES.join('|')})[:：]?[^\\]］]*[\\]］]`, 'gi'), '');
    // 3) 可发送/媒体单行标签转义为字面量，避免被当作发送指令
    out = out.replace(new RegExp(`[[［](${SENDABLE_TAG_NAMES.concat(CLOSED_CONTEXT_TAG_NAMES).join('|')})[:：]?[^\\]］]*[\\]］]`, 'gi'), (m) => '\\' + m);
    return out;
}

/** 剥离全部插件标签（渲染 + 内部），仅保留纯文本/Markdown；用于论坛等不支持消息段的纯文本出口 */
export function stripRenderTags(s: string): string {
    if (!s) return s;
    s = normalizeRenderTags(s);
    return s
        .replace(new RegExp(`[[［][/／]?(?:${ALL_TAG_NAMES.join('|')}|user_avatar)[:：]?\\s?[^\\]］]*[\\]］]`, 'gi'), '')
        .trim();
}
/**
 * 转义工具结果边界标记：避免工具/技能正文里的 [/tool_result] 提前闭合
 * buildContent 给 tool 消息包的外层 [tool_result]…[/tool_result] 边界。
 * 已带反斜杠的标记不重复转义（幂等）。
 */
export function escapeToolResultBoundary(text: string): string {
    return String(text || '').replace(
        /(^|[^\\])\[(\/?)(tool_result)\b/gi,
        (_m, prefix: string, slash: string, name: string) => `${prefix}\\[${slash}${name}`,
    );
}

export function parseSpecialTokens(s: string): TokenSegment[] {
    const result: TokenSegment[] = [];
    // 转义感知：stripUserTags 转义的字面标签（\\[at:all]）不再当标签解析，按文本保留
    const placeholders = new Map<string, string>();
    let phIndex = 0;
    const protectedStr = s.replace(/\\([[［][/／]?[a-z_]+[:：]?[^\\\[［\\\]］]*[\\\]］])/gi, (_m, tag: string) => {
        const ph = `\uE000${phIndex++}\uE001`;
        placeholders.set(ph, tag);
        return ph;
    });
    const restore = (text: string): string =>
        text.replace(/\uE000\d+\uE001/g, ph => placeholders.get(ph) ?? ph);
    const segs = protectedStr.split(/([[［][/／]?(?:at|poke|quote|face|img|avatar|group_avatar|audio|from|msg_id|system|time|tool_result|user_avatar)[:：]?[^\\\[［\\\]］]*[\\\]］])/);
    segs.forEach(seg => {
        if (!seg) return;
        const match = seg.match(/^[[［][/／]?([a-z_]+)[:：]?\s?([^\\\[［\\\]］]*)[\\\]］]$/i);
        if (!match) {
            result.push({
                type: 'text',
                content: restore(seg)
            })
            return;
        }
        const [_, rawType = 'text', content = ''] = match;
        const type = rawType.toLowerCase();
        // 内部上下文标签（来源/消息ID/系统/时间）不用于发送，直接丢弃避免泄露
        if (INTERNAL_TAG_TYPES.has(type)) return;
        // 兼容旧格式 [user_avatar:xxx] 别名
        const mapped = type === 'user_avatar' ? 'avatar' : type;
        // 闭合标签 [/xxx] 或内容为空的标签（如 [face] 商城表情的开标签）不是可发送标签，按文本保留
        const isClosing = /^[[［]\//.test(seg);
        if (isClosing || !content.trim() || !['at', 'poke', 'quote', 'img', 'avatar', 'group_avatar', 'face', 'audio'].includes(mapped)) {
            result.push({
                type: 'text',
                content: restore(seg)
            })
            return;
        }
        result.push({
            type: mapped as TokenSegment['type'],
            content: content
        })
    })
    return result;
}
