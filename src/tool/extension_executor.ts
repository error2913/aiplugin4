import Logger from "../logger";

import { ResolvedCommand } from "./command_catalog";
import { buildCommandContext, currentCommandUserId } from "./command_target";
import { registerLocalCommandCapture } from "./local_command_capture";
import { ToolListen } from "./types";

const RE_KEYWORD = /^--([^\s=]+)(?:=(\S+))?$/;

interface ListenerHost {
    tool: { listen: ToolListen };
}

/** 按海豹 ArgsParse 语义把原始参数拆成位置参数与关键字参数（--name / --name=value）。 */
function splitKwargs(plainArgs: string[]): { args: string[]; kwargs: seal.Kwarg[] } {
    const args: string[] = [];
    const kwargs: seal.Kwarg[] = [];
    for (const text of plainArgs) {
        const m = RE_KEYWORD.exec(text);
        if (m) {
            const value = m[2] || '';
            kwargs.push({
                name: m[1],
                value,
                valueExists: m[2] !== undefined,
                asBool: value !== '' && value !== '0' && value.toLowerCase() !== 'false',
            });
        } else {
            args.push(text);
        }
    }
    return { args, kwargs };
}

/**
 * 依据海豹 CmdArgs 语义构造一个全新的指令参数对象。
 * 不污染会话最近一次真实指令的参数，也不要求会话里先收到过指令。
 */
export function buildCmdArgs(ctx: seal.MsgContext, command: string, plainArgs: string[], at: seal.AtInfo[], prefix: string): seal.CmdArgs {
    const { args, kwargs } = splitKwargs(plainArgs);
    const cleanArgs = args.join(' ');
    const rawArgs = [cleanArgs, kwargs.map(item => `--${item.name}${item.valueExists ? `=${item.value}` : ''}`).join(' ')].filter(Boolean).join(' ');
    const atText = at.map(item => `[CQ:at,qq=${item.userId.replace(/^.+:/, '')}]`).join(' ');
    const rawText = [prefix + command, rawArgs, atText].filter(Boolean).join(' ').trim();
    const amIBeMentioned = at.some(item => item.userId === ctx.endPoint.userId);
    const amIBeMentionedFirst = amIBeMentioned && at[0]?.userId === ctx.endPoint.userId;

    return {
        command,
        args,
        kwargs,
        at,
        rawArgs,
        cleanArgs,
        amIBeMentioned,
        amIBeMentionedFirst,
        specialExecuteTimes: 0,
        rawText,
        getArgN: n => (n >= 1 && n <= args.length ? args[n - 1] : ''),
        getKwarg: key => kwargs.find(item => item.name === key) || null,
        getRestArgsFrom: n => {
            const list: string[] = [];
            for (let i = Math.max(1, n); i <= args.length; i++) {
                const info = args[i - 1];
                if (info) list.push(info);
                else break;
            }
            return list.join(' ');
        },
        isArgEqual: (n, ...s) => n >= 1 && n <= args.length && s.some(item => item.toLowerCase() === args[n - 1].toLowerCase()),
        eatPrefixWith: (...s) => {
            for (const item of s) {
                if (cleanArgs.length >= item.length && cleanArgs.slice(0, item.length).toLowerCase() === item.toLowerCase()) {
                    return [cleanArgs.slice(item.length).trim(), true];
                }
            }
            return ['', false];
        },
        chopPrefixToArgsWith: (...s) => {
            if (args.length === 0) return false;
            const text = args[0];
            for (const item of s) {
                if (text.length >= item.length && text.slice(0, item.length).toLowerCase() === item.toLowerCase()) {
                    const base = [item];
                    const rest = text.slice(item.length).trim();
                    if (rest) base.push(rest);
                    args.splice(0, 1, ...base);
                    return true;
                }
            }
            return false;
        }
    };
}

export interface LocalExecutionOptions {
    prefix?: string;
    timeoutMs?: number;
    settleMs?: number;
    maxMessages?: number;
    at?: seal.AtInfo[];
    /** 显式触发用户；不填写时保留原始会话 ctx/msg。 */
    trigger?: string;
}

function sessionLane(ctx: seal.MsgContext): string {
    return ctx.isPrivate ? String(ctx.player && ctx.player.userId || '') : String(ctx.group && ctx.group.groupId || '');
}

/** 本地执行一条已解析的扩展指令，并用会话监听器收集多条 bot 回复。 */
export async function executeExtensionLocally(
    ctx: seal.MsgContext,
    msg: seal.Message,
    session: ListenerHost,
    rc: ResolvedCommand,
    plainArgs: string[],
    options: LocalExecutionOptions = {}
): Promise<string> {
    const ext = seal.ext.find(rc.extName);
    if (!ext || !ext.cmdMap || !Object.prototype.hasOwnProperty.call(ext.cmdMap, rc.cmd)) {
        throw new Error(`扩展 ${rc.extName} 未找到或缺少指令 ${rc.cmd}`);
    }
    const prefix = options.prefix != null ? options.prefix : '.';
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 10000;
    const settleMs = options.settleMs != null && options.settleMs >= 0 ? options.settleMs : 400;
    const maxMessages = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : 20;
    const at = options.at || [];
    const useSyntheticContext = options.trigger !== undefined || at.length > 0;
    const targetContext = useSyntheticContext
        ? buildCommandContext(ctx, { trigger: options.trigger || currentCommandUserId(ctx), at: at.map(item => item.userId.replace(/^.+:/, '')) })
        : { ctx, msg };
    const executionCtx = targetContext.ctx;
    const executionMsg = targetContext.msg;
    const atText = at.map(item => `[CQ:at,qq=${item.userId.replace(/^.+:/, '')}]`).join(' ');
    executionMsg.message = [atText, `${prefix}${rc.cmd}`, plainArgs.join(' ')].filter(Boolean).join(' ');
    const cmdArgs = buildCmdArgs(executionCtx, rc.cmd, plainArgs, at, prefix);

    const listen = session.tool.listen;
    const responsePromise = listen.waitFor
        ? listen.waitFor(timeoutMs, settleMs, maxMessages)
        : new Promise<string[]>(resolve => {
            listen.timeoutId = setTimeout(() => resolve([]), timeoutMs);
            listen.resolve = content => {
                resolve([content]);
                listen.cleanup();
            };
        });
    const unregisterCapture = registerLocalCommandCapture(
        Array.from(new Set([sessionLane(ctx), sessionLane(executionCtx)])),
        content => (listen.push || listen.resolve)?.(content)
    );

    let solved = false;
    try {
        const result = await Promise.resolve(ext.cmdMap[rc.cmd].solve(executionCtx, executionMsg, cmdArgs)) as { solved?: boolean } | undefined;
        solved = !!(result && result.solved);
    } catch (e) {
        unregisterCapture();
        listen.cleanup();
        await responsePromise.catch(() => []);
        Logger.warning(`[run_ext_command] 本地执行 ${rc.extName}|${rc.cmd} 抛异常:${e instanceof Error ? e.message : String(e)}`);
        throw new Error(`指令执行抛异常：${e instanceof Error ? e.message : String(e)}`);
    }

    const messages = await responsePromise;
    unregisterCapture();
    if (messages.length) return messages.join('\n');
    return solved ? '海豹未返回文本消息' : '指令未响应（扩展返回 solved=false），海豹未返回文本消息';
}
