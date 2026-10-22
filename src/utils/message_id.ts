// 消息 ID 转换（叶子模块）：十进制 ↔ base36（大整数安全）、milky 原生 ID → OB11 message_id。
// 从 utils/utils.ts 拆出：transport/utils 多处只用消息 ID 工具，不应经由 utils/utils 拉进
//「utils → string → image → model → …」整圈依赖。
import { logger } from "../logger";
export function transformMsgId(msgId: string | number | null): string {
    if (msgId === null || msgId === '') {
        return '';
    }
    let s: string;
    if (typeof msgId === 'number') {
        // 浮点数或超出安全整数范围的数字本身已丢失精度，无法还原，直接拒绝
        if (!Number.isFinite(msgId) || !Number.isSafeInteger(msgId)) return '';
        s = String(msgId);
    } else {
        s = String(msgId).trim();
        if (!/^[+-]?\d+$/.test(s)) return '';
    }
    if (/^[+-]?0+$/.test(s)) return '0';
    const negative = s.startsWith('-');
    const digits = s.replace(/^[+-]?/, '').replace(/^0+/, '') || '0';
    const base36 = decimalToBase36(digits);
    return negative ? `-${base36}` : base36;
}

/**
 * 去重/比对用消息 ID 归一：十进制（含负数，QQ/NapCat 形态）转 base36，与上下文记录
 * （getRecordMessageId）口径一致，保证原生回调与 ob11 依赖两条路径对同一 messageId
 * 拼出相同字符串；已是 base36/非十进制（其它平台）保持原样。空值返回 ''。
 */
export function normalizeMsgId(msgId: string | number | null | undefined): string {
    if (msgId === undefined || msgId === null) return '';
    const s = String(msgId).trim();
    if (!s) return '';
    const base36 = transformMsgId(s);
    return base36 || s;
}

/**
 * base36 短 ID → 原始十进制消息 ID。
 * 安全整数（|n| ≤ 2^53-1）返回 number（兼容旧行为），超出安全范围返回精确十进制字符串，避免精度丢失。
 * 非法输入返回 ''。
 */
export function transformMsgIdBack(msgId: string): number | string {
    const s = String(msgId ?? '').trim();
    if (!s) return '';
    const negative = s.startsWith('-');
    const digits = s.replace(/^[+-]?/, '');
    if (!digits || !/^[0-9a-z]+$/i.test(digits)) return '';
    const decimal = base36ToDecimal(digits);
    if (decimal === '') return '';
    const signed = (negative ? '-' : '') + decimal;
    const num = Number(signed);
    if (Number.isSafeInteger(num)) return num;
    return signed;
}

// ---- 大整数 base36 转换辅助（消息 ID 可能超出 2^53，不能用 Number 直接转换） ----

const BASE36_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 十进制字符串乘加：decimal = decimal * multiplier + addend（multiplier/addend 为 0~35 的小整数） */
function decimalMulAdd(decimal: string, multiplier: number, addend: number): string {
    let carry = addend;
    let result = '';
    for (let i = decimal.length - 1; i >= 0; i--) {
        const sum = (decimal.charCodeAt(i) - 48) * multiplier + carry;
        result = String(sum % 10) + result;
        carry = Math.floor(sum / 10);
    }
    while (carry > 0) {
        result = String(carry % 10) + result;
        carry = Math.floor(carry / 10);
    }
    return result || '0';
}

/** 十进制字符串除以 36：返回商与余数（长除法，避免 Number 精度丢失） */
function decimalDivMod36(decimal: string): { quotient: string; remainder: number } {
    let quotient = '';
    let remainder = 0;
    for (let i = 0; i < decimal.length; i++) {
        const current = remainder * 10 + (decimal.charCodeAt(i) - 48);
        const q = Math.floor(current / 36);
        remainder = current % 36;
        if (quotient !== '' || q > 0) quotient += String(q);
    }
    return { quotient: quotient || '0', remainder };
}

/** 非负十进制字符串 → base36（大整数安全） */
function decimalToBase36(decimal: string): string {
    let n = decimal.replace(/^0+/, '') || '0';
    if (n === '0') return '0';
    let result = '';
    while (n !== '0') {
        const { quotient, remainder } = decimalDivMod36(n);
        result = BASE36_DIGITS[remainder] + result;
        n = quotient;
    }
    return result;
}

/** 非负 base36 字符串 → 十进制字符串（大整数安全）；含非法字符返回 '' */
function base36ToDecimal(base36: string): string {
    let decimal = '0';
    for (const ch of base36.toLowerCase()) {
        const digit = BASE36_DIGITS.indexOf(ch);
        if (digit < 0) return '';
        decimal = decimalMulAdd(decimal, 36, digit);
    }
    return decimal;
}

/**
 * 消息记录用的唯一 ID。milky 格式（msg.segment 非空）下 msg.rawId 只是会话内的
 * message_seq，经 ob11 依赖的 net.messageId 转成 OB11 唯一 message_id 后再按现有
 * base36 规则记录；未装依赖、参数缺失或转换失败时回退原逻辑（transformMsgId(rawId)）。
 * 注意：发送引用仍使用原始 rawId（milky 端需要 message_seq），此处仅用于上下文记录。
 */
export function getRecordMessageId(ctx: seal.MsgContext, msg: seal.Message): string {
    const segments = (msg as any).segment;
    if (Array.isArray(segments) && segments.length > 0) {
        const net = (globalThis as any).net;
        if (net && typeof net.messageId === 'function' && msg.rawId !== null && msg.rawId !== undefined && msg.rawId !== '') {
            try {
                const rawStr = String(msg.rawId);
                const peerStr = ctx.isPrivate ? (ctx.player && ctx.player.userId) || '' : (ctx.group && ctx.group.groupId) || '';
                const peerMatch = /(\d+)$/.exec(peerStr);
                if (peerMatch && /^\d+$/.test(rawStr)) {
                    const mid = net.messageId({ scene: ctx.isPrivate ? 'friend' : 'group', id: Number(peerMatch[1]), msgid: Number(rawStr) });
                    if (mid !== null && mid !== undefined) {
                        return transformMsgId(Number(mid));
                    }
                }
            } catch (e) {
                logger.warning(`milky 消息 ID 转换失败，回退原始 rawId:${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    return transformMsgId(msg.rawId);
}

/**
 * 把 milky 原生消息段的 replySeq（会话内 message_seq）转成 OB11 唯一 message_id。
 * 依赖未安装、参数不合法或转换失败时回退原始 replySeq，保持与无 ob11 依赖时
 * 上下文里 transformMsgId(rawId) 记录方式一致。
 */
export function getMilkyReplyQuoteId(ctx: seal.MsgContext, replySeq: string | number): string {
    const seq = String(replySeq ?? '');
    if (!seq) return '';
    const net = (globalThis as any).net;
    if (net && typeof net.messageId === 'function') {
        try {
            const peerStr = ctx.isPrivate ? (ctx.player && ctx.player.userId) || '' : (ctx.group && ctx.group.groupId) || '';
            const peerMatch = /(\d+)$/.exec(peerStr);
            if (peerMatch && /^\d+$/.test(seq)) {
                const mid = net.messageId({
                    scene: ctx.isPrivate ? 'friend' : 'group',
                    id: Number(peerMatch[1]),
                    msgid: Number(seq)
                });
                if (mid !== null && mid !== undefined) return String(mid);
            }
        } catch (e) {
            logger.warning(`milky 回复消息 ID 转换失败，回退原始 replySeq:${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return seq;
}
