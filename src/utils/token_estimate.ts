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
