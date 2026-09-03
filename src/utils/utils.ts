// 通用工具：消息ID转换/回复发送/超时/revive/路径解析等
import Config from "../config/config";
import { ALIAS_MAP } from "../config/static_config";
import { logger } from "../logger";
import { callOb11ApiForContext } from "../transport/ob11/dispatcher";

import { netExists } from "./ob11";
import { transformTextToArray } from "./string";

const sendLog = logger.withTag('send');

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

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}

export async function replyToSender(ctx: seal.MsgContext, msg: seal.Message, session: { context: { lastReply: string } }, s: string): Promise<string> {
    if (!s) {
        return '';
    }

    const { showMsgId = true } = Config.context as any;
    if (showMsgId && netExists()) {
        try {
            const rawMessageArray = transformTextToArray(s);
            const messageArray = rawMessageArray.filter(item => item.type !== 'poke');

            // 处理戳戳戳
            const pokeMsgArr = rawMessageArray.filter(item => item.type === 'poke');
            if (pokeMsgArr.length > 0) {
                pokeMsgArr.forEach(item => {
                    const s = `[CQ:poke,qq=${item.data.qq}]`;
                    session.context.lastReply = s;
                    seal.replyToSender(ctx, msg, s);
                });
            }

            if (messageArray.length === 0) return '';

            const uid = ctx.player!.userId;
            if (msg.messageType === 'private') {
                const result = await callOb11ApiForContext(ctx, msg, "send_private_msg", { user_id: uid.replace(/^.+:/, ""), message: messageArray });
                if (result.ok && result.message_id) {
                    sendLog.debug(`(${result.message_id})发送给${uid}:${s}`);
                    return transformMsgId(result.message_id);
                }
            } else if (msg.messageType === 'group') {
                const gid = ctx.group ? ctx.group.groupId : '';
                const result = await callOb11ApiForContext(ctx, msg, "send_group_msg", { group_id: gid.replace(/^.+:/, ""), message: messageArray });
                if (result.ok && result.message_id) {
                    sendLog.debug(`(${result.message_id})发送给${gid}:${s}`);
                    return transformMsgId(result.message_id);
                }
            }
            sendLog.warning('无法获取 message_id');
        } catch (error) {
            // OB11 发送链路（含参数构造/上下文取值）任何异常都不允许吞掉回复：落回海豹 API 发送
            sendLog.exception('OB11 发送异常，落回海豹 API 发送', error);
        }
    }
    session.context.lastReply = s;
    seal.replyToSender(ctx, msg, s);
    return '';
}

/**
 * 会话级「停止事件」信号：stop 时置 fired 并同步唤醒全部等待者。
 * 海豹 goja 环境没有 AbortController/AbortSignal（goja 核心、gojax fetch、sealdice-core 均未实现），
 * 无法硬中断底层 fetch/网络 I/O；此信号让插件侧所有 await 在 stop 时刻立即以 StopError 退出：
 * 不再消费模型结果、不再重试、不再回填工具链、不再续跑挂起消息。
 */
export interface StopEvent {
    fired: boolean;
    waiters: Array<() => void>;
}

/** 因会话 stop 而中止运行的控制流异常：各层捕获后静默返回，不打印堆栈 */
export class StopError extends Error {
    constructor() {
        super('会话已停止');
        this.name = 'StopError';
    }
}

export function createStopEvent(): StopEvent {
    return { fired: false, waiters: [] };
}

/** 触发停止信号：置 fired 并同步唤醒全部等待者（goja 单线程，唤醒在 stop 调用栈内同步执行） */
export function fireStopEvent(ev: StopEvent): void {
    ev.fired = true;
    const waiters = ev.waiters;
    ev.waiters = [];
    for (const w of waiters) {
        try {
            w();
        } catch (_e) {
            // 等待者回调只做 reject，兜底吞掉避免 stop 流程被异常打断
        }
    }
}

/** 重置停止信号：新一轮 run 启动且通过代际检查后调用（同会话单 run 闸门保证此时无在跑的 waiters） */
export function resetStopEvent(ev: StopEvent): void {
    ev.fired = false;
    ev.waiters = [];
}

export function withTimeout<T>(asyncFunc: () => Promise<T>, timeoutMs: number, opts?: { stopEvent?: StopEvent }): Promise<T> {
    const { stopEvent } = opts ?? {};
    if (!stopEvent) {
        return Promise.race([
            asyncFunc(),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
            })
        ]);
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: number | null = null;
        const waiter = () => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            reject(new StopError());
        };
        if (stopEvent.fired) {
            reject(new StopError());
            return;
        }
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            const idx = stopEvent.waiters.indexOf(waiter);
            if (idx !== -1) stopEvent.waiters.splice(idx, 1);
            reject(new Error(`操作超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        stopEvent.waiters.push(waiter);
        asyncFunc().then(
            value => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                const idx = stopEvent.waiters.indexOf(waiter);
                if (idx !== -1) stopEvent.waiters.splice(idx, 1);
                resolve(value);
            },
            error => {
                if (settled) return;
                settled = true;
                if (timer !== null) clearTimeout(timer);
                const idx = stopEvent.waiters.indexOf(waiter);
                if (idx !== -1) stopEvent.waiters.splice(idx, 1);
                reject(error);
            }
        );
    });
}

export type TypeDescriptor<T> =
    'default'
    | 'string'
    | 'number'
    | 'boolean'
    | 'any'
    | TypeDescriptor<any>[] // 元组元素类型
    | { array: TypeDescriptor<any> } // 数组元素类型
    | {
        object?: { [key: string]: TypeDescriptor<any> },
        objectValue?: TypeDescriptor<any>
    } // 对象键值对类型，对象值类型
    | RevivableConstructor<T>; // 嵌套类

interface RevivableConstructor<T> {
    new(): T; // 构造函数必须无参数
    validKeysMap: { [key in keyof T]?: TypeDescriptor<T[key]> };
}

/**
 * 恢复一个对象，只恢复构造函数中定义的属性，支持嵌套属性  希望没有bug
 * @param constructor 传入构造函数，必须有 validKeys 属性
 * @param value 要恢复的对象
 * @returns 恢复后的对象
 */
export function revive<T>(constructor: RevivableConstructor<T>, value: any): T {
    function reviveItem(descriptor: any, defaultValue: any, value: any): any {
        if (descriptor === 'string') {
            if (typeof value === 'string') return value;
        } else if (descriptor === 'number') {
            if (typeof value === 'number') return value;
        } else if (descriptor === 'boolean') {
            if (typeof value === 'boolean') return value;
        } else if (Array.isArray(descriptor)) {
            if (Array.isArray(value)) return descriptor.map((d: any, i: number) => reviveItem(d, defaultValue?.[i], value?.[i]));
        } else if (typeof descriptor === 'object' && 'array' in descriptor) {
            if (Array.isArray(value)) return value.map((v: any, i: number) => reviveItem(descriptor.array, defaultValue?.[i], v));
        } else if (typeof descriptor === 'object' && ('object' in descriptor || 'objectValue' in descriptor)) {
            const ov: any = {}, o: any = {};
            if (typeof value === 'object' && value !== null) {
                if ('objectValue' in descriptor) Object.keys(value).forEach(k => ov[k] = reviveItem((descriptor as any).objectValue, defaultValue?.[k], value?.[k]));
                if ('object' in descriptor) Object.keys((descriptor as any).object || {}).forEach(k => o[k] = reviveItem((descriptor as any).object[k], defaultValue?.[k], value?.[k]));
                return { ...o, ...ov };
            }
        } else if (typeof descriptor === 'function') {
            return revive(descriptor, value);
        } else {
            return value;
        }
        return defaultValue;
    }

    const obj: any = new constructor();

    if (constructor.validKeysMap) {
        for (const k in constructor.validKeysMap) {
            const descriptor: TypeDescriptor<T[Extract<keyof T, string>]> | undefined = (constructor.validKeysMap as any)[k];
            if (Object.prototype.hasOwnProperty.call(value, k)) {
                const item = reviveItem(descriptor, obj[k], value[k]);
                if (item !== undefined) obj[k] = item;
            }
        }
    } else { // 没有定义 validKeysMap，直接赋值
        for (const k in value) {
            obj[k] = value[k];
        }
    }

    return obj;
}

export function aliasToCmd(val: string) {
    return ALIAS_MAP[val as keyof typeof ALIAS_MAP] || val;
}

// 计算余弦相似度
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        logger.error(`cosineSimilarity: 向量维度必须相同，a: ${a.length}, b: ${b.length}`);
        return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function getCommonItem(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aset = new Set(a);
    return b.filter(u => aset.has(u));
}

/** 判断字符串是否为 URI（Windows 盘符 C:\\foo 不算 URI）。 */
function hasUriScheme(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value);
}

/** 将 file:// URI 转回当前进程可使用的本地路径。 */
function fileUriToLocalPath(value: string): string {
    if (!/^file:\/\//i.test(value)) return value;

    const withoutScheme = value.replace(/^file:\/\//i, '');
    // file://server/share/file 是 UNC 路径；file:///C:/file 是 Windows 盘符路径。
    const slashValue = withoutScheme.replace(/\\/g, '/');
    try {
        const decoded = decodeURIComponent(slashValue);
        if (/^[^/]+\//.test(decoded) && !/^[a-zA-Z]:\//.test(decoded)) {
            return `\\\\${decoded.replace(/\//g, '\\')}`;
        }
        if (/^\/[a-zA-Z]:\//.test(decoded)) return decoded.slice(1).replace(/\//g, '\\');
        if (/^[a-zA-Z]:\//.test(decoded)) return decoded.replace(/\//g, '\\');
        return decoded.startsWith('/') ? decoded : `/${decoded}`;
    } catch (_e) {
        // URI 编码不合法时保留原字符串，避免发送工具因解析异常直接崩溃。
        return slashValue;
    }
}

/**
 * 规范化本地路径，但不依赖 Node 的 path/fs 模块（插件运行在海豹 JS 环境）。
 * 覆盖盘符、UNC、POSIX 绝对路径和相对 SealDice 路径，避免字符串拼接造成
 * 双分隔符、`.`/`..` 残留以及 UNC 路径被误判为相对路径。
 */
function normalizeLocalPath(value: string): string {
    const original = value;
    const slashValue = value.replace(/\\/g, '/');
    const windowsStyle = /^[a-zA-Z]:\//.test(slashValue) || slashValue.startsWith('//');
    let root = '';
    let rest = slashValue;

    const drive = slashValue.match(/^([a-zA-Z]:)\//);
    if (drive) {
        root = `${drive[1]}/`;
        rest = slashValue.slice(root.length);
    } else if (slashValue.startsWith('//')) {
        const uncParts = slashValue.slice(2).split('/').filter(Boolean);
        if (uncParts.length >= 2) {
            root = `//${uncParts[0]}/${uncParts[1]}/`;
            rest = uncParts.slice(2).join('/');
        } else {
            root = '//';
            rest = uncParts.join('/');
        }
    } else if (slashValue.startsWith('/')) {
        root = '/';
        rest = slashValue.slice(1);
    }

    const parts: string[] = [];
    for (const part of rest.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
            else if (!root) parts.push(part);
            continue;
        }
        parts.push(part);
    }

    let normalized = `${root}${parts.join('/')}`;
    if (!normalized) normalized = root || (original ? '.' : '');
    if (windowsStyle) normalized = normalized.replace(/\//g, '\\');
    return normalized;
}

/**
 * 将资源配置/工具参数中的路径解析为 SealDice 进程可使用的路径。
 * 相对路径相对 Config.base.SEALDICE_PATH；mcp://、http:// 等远端 URI 不应被
 * 拼接到 SealDice 目录，原样交给上层的资源桥处理。
 */
export function resolveLocalPath(p: string): string {
    const value = String(p || '').trim();
    if (!value) return value;
    if (/^file:\/\//i.test(value)) return normalizeLocalPath(fileUriToLocalPath(value));
    if (hasUriScheme(value)) return value;

    const normalized = normalizeLocalPath(value);
    const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(normalized);
    if (isAbsolute) return normalized;

    const { SEALDICE_PATH } = Config.base;
    if (!SEALDICE_PATH) return normalized;
    return normalizeLocalPath(`${String(SEALDICE_PATH).replace(/[\\/]$/, '')}/${normalized}`);
}
