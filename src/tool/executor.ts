// 工具统一执行器：模型 function calling（Tool.handleToolCall）、call_tool、`.ai tool call`
// 三处调用共用同一份「查找 → 开关 → 平台/会话类型 → 参数解析与校验 → 超时执行 → 审计日志 → 错误归一化」。
// 拆出前这三处各写一遍，已经出现语义分叉（`.ai tool call` 没有超时与参数类型校验）；见 .dev/refactor-plan.md 3.1。
//
// 本文件不 import Tool 类（只经 registry 取实例），避免 tool.ts ↔ executor.ts 形成新环。
import Config from "../config/config";
import Logger from "../logger";
import type { Session } from "../session/session";
import { fixJsonString } from "../utils/json";
import { matchesPlatform, platformOf } from "../utils/target_id";
import { StopError, withTimeout } from "../utils/timeout";

import { getTool, hasTool } from "./registry";
import type { ToolContentPart, ToolInfo } from "./types";

const log = Logger.withTag('tool');

export type ToolFailCode =
    | 'not_found'
    | 'not_enabled'
    | 'platform'
    | 'session_type'
    | 'bad_args'
    | 'missing_required'
    | 'invalid_arg'
    | 'failed';

export interface ToolFailure {
    code: ToolFailCode;
    /** 面向模型的简短原因；各调用点按自己的文案风格包装 */
    message: string;
    /** 缺少的参数名（missing_required） */
    param?: string;
    /** 期望 / 实际的会话类型（session_type）或平台（platform） */
    expected?: string;
    actual?: string;
}

export interface ToolExecution {
    ok: boolean;
    content?: string;
    contentParts?: ToolContentPart[];
    /** 工具是否回调智能体（Tool.callBack） */
    callBack?: boolean;
    failure?: ToolFailure;
    elapsedMs?: number;
}

export interface ExecuteToolOptions {
    /** 调用来源，仅用于日志前缀 */
    source: 'function' | 'call_tool' | 'command';
    /** 已解析参数对象，或原始 JSON 字符串 */
    args: unknown;
    /** 参数 JSON 解析失败时是否尝试 fixJsonString 修复（function calling 路径需要） */
    repairJson?: boolean;
    /** 平台守卫（默认 true；管理员命令试用传 false） */
    checkPlatform?: boolean;
    /** 会话类型守卫（默认 true；管理员命令试用传 false） */
    checkSessionType?: boolean;
    /** 会话开关守卫（默认 true；管理员命令试用传 false，允许试用未开启的工具） */
    checkEnabled?: boolean;
}

/** 轻量参数校验：按 parameters.properties 的 type 检查（原 Tool.validateArgs 的实现） */
export function validateToolArgs(tool: { toolInfo: ToolInfo }, args: any): string | null {
    const props = (tool.toolInfo.function.parameters && tool.toolInfo.function.parameters.properties) || {};
    for (const key of Object.keys(props)) {
        if (args[key] === undefined) continue;
        const expected = props[key].type;
        if (expected === 'string' && typeof args[key] !== 'string') return `参数 ${key} 应为字符串`;
        if (expected === 'number' && typeof args[key] !== 'number') return `参数 ${key} 应为数字`;
        if (expected === 'boolean' && typeof args[key] !== 'boolean') return `参数 ${key} 应为布尔值`;
        if (expected === 'array' && !Array.isArray(args[key])) return `参数 ${key} 应为数组`;
        if (expected === 'object' && (typeof args[key] !== 'object' || args[key] === null)) return `参数 ${key} 应为对象`;
    }
    return null;
}

/** 解析参数：对象原样返回；字符串走 JSON（可选修复） */
function parseArgs(name: string, source: string, raw: unknown, repair: boolean): { args?: any; failure?: ToolFailure } {
    if (typeof raw !== 'string') return { args: raw };
    try {
        return { args: JSON.parse(raw) };
    } catch (e) {
        const fixed = repair ? fixJsonString(raw) : '';
        if (!fixed) {
            log.exception(`[${source}] 调用函数 (${name}:${raw}) 失败`, e);
            return { failure: { code: 'bad_args', message: e instanceof Error ? e.message : String(e) } };
        }
        try {
            return { args: JSON.parse(fixed) };
        } catch (e2) {
            log.exception(`[${source}] 调用函数 (${name}:${raw}) 失败`, e2);
            return { failure: { code: 'bad_args', message: e2 instanceof Error ? e2.message : String(e2) } };
        }
    }
}

/** 执行一次工具调用；停止信号（StopError）继续向上抛，由调用链中止 */
export async function executeTool(
    name: string,
    ctx: seal.MsgContext,
    msg: seal.Message,
    session: Session,
    options: ExecuteToolOptions,
): Promise<ToolExecution> {
    const { source } = options;
    const tool = getTool(name);
    if (!tool || !hasTool(name)) {
        log.warning(`[${source}] 调用函数失败:未注册的函数:${name}`);
        return { ok: false, failure: { code: 'not_found', message: `未注册的函数:${name}` } };
    }
    if (options.checkEnabled !== false && !session.toolState?.[name]) {
        log.warning(`[${source}] 调用函数失败:未经许可的函数:${name}`);
        return { ok: false, failure: { code: 'not_enabled', message: `未经许可的函数:${name}` } };
    }

    const platform = platformOf(ctx);
    if (options.checkPlatform !== false && !matchesPlatform(tool.platforms, platform)) {
        log.warning(`[${source}] 调用函数失败:工具${name}在当前平台不可用:${platform}`);
        return { ok: false, failure: { code: 'platform', message: `工具 ${name} 在当前平台不可用`, actual: platform } };
    }

    const msgType = msg.messageType === 'private' ? 'user' : 'group';
    if (options.checkSessionType !== false && tool.sessionType !== 'any' && tool.sessionType !== msgType) {
        log.warning(`[${source}] 调用函数失败:函数${name}可使用的场景类型为${tool.sessionType}，当前场景类型为${msgType}`);
        return {
            ok: false,
            failure: { code: 'session_type', message: '场景类型不匹配', expected: tool.sessionType, actual: msgType },
        };
    }

    const parsed = parseArgs(name, source, options.args, options.repairJson === true);
    if (parsed.failure) return { ok: false, failure: parsed.failure };
    const args = parsed.args;
    if (args === null || typeof args !== 'object') {
        log.warning(`[${source}] 调用函数失败:arguement不是一个object`);
        return { ok: false, failure: { code: 'bad_args', message: 'arguement不是一个object' } };
    }
    for (const key of (tool.toolInfo?.function?.parameters?.required || [])) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) {
            log.warning(`[${source}] 调用函数失败:缺少必需参数 ${key}`);
            return { ok: false, failure: { code: 'missing_required', message: `缺少必需参数 ${key}`, param: String(key) } };
        }
    }
    const invalid = validateToolArgs(tool, args);
    if (invalid) {
        log.warning(`[${source}] 调用函数失败:${invalid}`);
        return { ok: false, failure: { code: 'invalid_arg', message: invalid } };
    }

    const startedAt = Date.now();
    try {
        const { TIMEOUT } = Config.base;
        const solved = await withTimeout(() => tool.solve(ctx, msg, session, args), TIMEOUT, { stopEvent: session.stopEvent });
        const content = typeof solved === 'string' ? solved : solved.text;
        const elapsedMs = Date.now() - startedAt;
        log.info(`[${source}] ${name} 执行耗时 ${elapsedMs}ms${tool.sensitive ? ' [敏感]' : ''}`);
        const out: ToolExecution = { ok: true, content, callBack: tool.callBack, elapsedMs };
        if (typeof solved !== 'string' && solved.contentParts && solved.contentParts.length > 0) {
            out.contentParts = solved.contentParts;
        }
        return out;
    } catch (e) {
        // stop 中断工具执行：向上抛出让工具链立即中止（不把 StopError 当工具失败回填给模型）
        if (e instanceof StopError) throw e;
        log.exception(`[${source}] 调用函数 (${name}) 失败`, e);
        return {
            ok: false,
            failure: { code: 'failed', message: e instanceof Error ? e.message : String(e) },
            elapsedMs: Date.now() - startedAt,
        };
    }
}
