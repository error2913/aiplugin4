// 无依赖 token 估算（L1 叶子）：按 Unicode 类别分桶近似 BPE。
//
// 从 `utils/message.ts` 拆出，供上下文层（context/context.ts）等不能反向依赖 message 的模块复用；
// `utils/message.ts` 仍同名 re-export，既有 import 零改动。
// 用于「上下文最大 token」的整包预算估算，避免依赖外部 tokenizer。

export function estimateTextTokens(text: string): number {
    let asciiAlnum = 0;
    let asciiSpace = 0;
    let asciiPunct = 0;
    let cjk = 0;
    let cjkLike = 0;
    let otherBmp = 0;
    let astral = 0;

    for (const ch of String(text || '')) {
        const cp = ch.codePointAt(0) as number;
        if (isCjkCodePoint(cp)) {
            cjk++;
        } else if (cp > 0xFFFF) {
            astral++;
        } else if (cp <= 0x7F) {
            if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) {
                asciiAlnum++;
            } else if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0D)) {
                asciiSpace++;
            } else if (cp >= 0x21 && cp <= 0x7E) {
                asciiPunct++;
            } else {
                asciiSpace++;
            }
        } else if (isCjkLikeCodePoint(cp)) {
            cjkLike++;
        } else {
            otherBmp++;
        }
    }

    return Math.ceil(asciiAlnum / 4)
        + Math.ceil(asciiSpace / 4)
        + Math.ceil(asciiPunct / 2)
        + cjk
        + Math.ceil(cjkLike * 3 / 2)
        + Math.ceil(otherBmp / 2)
        + astral * 2;
}

function isCjkCodePoint(cp: number): boolean {
    return (cp >= 0x3400 && cp <= 0x4DBF)
        || (cp >= 0x4E00 && cp <= 0x9FFF)
        || (cp >= 0xF900 && cp <= 0xFAFF)
        || (cp >= 0x20000 && cp <= 0x2FA1F);
}

function isCjkLikeCodePoint(cp: number): boolean {
    return (cp >= 0x3040 && cp <= 0x30FF)
        || (cp >= 0xAC00 && cp <= 0xD7AF);
}

/**
 * 事件级 token 估算（与 `estimateTextTokens` 同口径，供事件账本/编译/压缩共用）。
 *
 * 历史实现按「字符数 / 3」估算，对中文（CJK 约 1 token/字符）会低估约 3 倍，
 * 导致编译以为装得下、实际请求体超预算，且 `omittedFromSeq` 检测不到（预算到顶不触发）。
 * 这里统一走 `estimateTextTokens`：
 * - 文本 part：按 `estimateTextTokens`；
 * - 图片等非文本 part：固定 64（与 `estimateMessageTokens` 一致）；
 * - tool_call 的 args、assistant 的 reasoning：按文本估算；
 * - +4 结构开销（role/字段名）；不包含编译层渲染前缀（[from]/[time]/[msg_id]）。
 *
 * 注意：本函数是 L1 叶子，不得 import 任何上层类型；用结构化参数接收事件。
 */
export interface EventTokenLike {
    kind?: string;
    parts?: ReadonlyArray<{ type?: string; text?: string } | null | undefined>;
    args?: string;
    reasoning?: string;
}

export function estimateEventTokens(event: EventTokenLike | null | undefined): number {
    if (!event || typeof event !== 'object') return 1;
    const parts = Array.isArray(event.parts) ? event.parts : [];
    let tokens = 4;
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text') tokens += estimateTextTokens(String(part.text ?? ''));
        else tokens += 64;
    }
    if (event.kind === 'tool_call') tokens += estimateTextTokens(String(event.args ?? ''));
    if (typeof event.reasoning === 'string') tokens += estimateTextTokens(event.reasoning);
    return Math.max(1, tokens);
}
