// 核心指令工具：通过 ob11-core-bridge 的 /plugin WebSocket 注入假消息执行核心指令。
// 扩展指令仍由 run_ext_command 本地直调扩展 solve，不经过核心桥。
import Config from "../../../config/config";
import { CoreBridgeResult } from "../../../integration/core_bridge/types";
import { callCoreBridgeCommand } from "../../../integration/core_bridge/ws_client";
import Logger from "../../../logger";
import { callOb11ApiDirect } from "../../../transport/ob11/dispatcher";
import { normalizeGroupId, normalizeUserId, platformOf } from "../../../utils/target_id";
import { withTimeout } from "../../../utils/timeout";
import { isAllowedCore, splitEntry, whitelistEntries } from "../../command_catalog";
import { resolveCommandTarget } from "../../command_target";
import Tool from "../../tool";

const log = Logger.withTag('run_core_command');

/** 获取核心假消息发送者的真实平台昵称/群名片，避免把当前 AI 会话用户昵称错传给 trigger。 */
async function resolveCommandActorNickname(ctx: seal.MsgContext, userId: string): Promise<string> {
    const rawUserId = normalizeUserId(userId, platformOf(ctx)) || userId;
    const rawGroupId = ctx.group ? normalizeGroupId(ctx.group.groupId, platformOf(ctx)) : '';
    if (!rawUserId) return '';
    try {
        const action = rawGroupId ? 'get_group_member_info' : 'get_stranger_info';
        const params = rawGroupId
            ? { group_id: rawGroupId.replace(/^.+:/, ''), user_id: rawUserId.replace(/^.+:/, ''), no_cache: true }
            : { user_id: rawUserId.replace(/^.+:/, ''), no_cache: true };
        const info = await withTimeout(
            () => callOb11ApiDirect(ctx.endPoint.userId, action, params),
            3000
        );
        const name = rawGroupId ? info && (info.card || info.nickname) : info && info.nickname;
        if (typeof name === 'string' && name.trim()) return name.trim();
    } catch (e) {
        log.debug(`[run_core_command] 获取 trigger=${rawUserId} 昵称失败，使用回退值: ${e instanceof Error ? e.message : String(e)}`);
    }
    return rawUserId === normalizeUserId(ctx.player && ctx.player.userId || '', platformOf(ctx))
        ? String(ctx.player && ctx.player.name || '')
        : `用户${rawUserId}`;
}

function captureOptions(args: { [key: string]: any }, defaultMaxMessages: number, defaultSettleMs: number): {
    capture: { mode: 'reply_only' | 'lane'; forward: boolean; maxMessages: number; settleMs: number };
    timeoutMs?: number;
} {
    const forward = !(args && args.forward === false);
    const requestedMode = args && (args.captureMode === 'lane' || args.captureMode === 'reply_only') ? args.captureMode : undefined;
    const maxMessages = Number(args && args.maxMessages);
    const settleMs = Number(args && args.settleMs);
    const timeoutMs = Number(args && args.timeoutMs);
    return {
        capture: {
            mode: requestedMode || (forward ? 'lane' : 'reply_only'),
            forward,
            maxMessages: Number.isFinite(maxMessages) && maxMessages > 0 ? maxMessages : defaultMaxMessages,
            settleMs: Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : defaultSettleMs
        },
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined
    };
}

/** 从 raw_message 中提取用于白名单校验的核心命令名，尽量兼容前缀/CQ/执行次数/core| 等写法。 */
function extractAuthorizedCommand(raw: string): string {
    let s = String(raw || '').trim();
    if (s.startsWith(Config.tool.COMMAND_PREFIX)) {
        s = s.slice(Config.tool.COMMAND_PREFIX.length).trim();
    }
    s = s.replace(/^\[CQ:[^\]]+\]\s*/, '');
    s = s.replace(/^\d+#/, '');
    s = s.replace(/^core\|/i, '');
    return s.split(/\s+/, 1)[0] || '';
}

function formatCoreBridgeResult(result: CoreBridgeResult): string {
    if (!result.ok) return `中转执行失败：${result.error || '未知错误'}`;
    const texts = (result.messages || []).map(item => item.text || '').filter(Boolean);
    const body = texts.length ? texts.join('\n') : '核心未返回文本消息';
    const flags = [result.ambiguous ? '消息关联存在歧义' : '', result.completedBy ? `结束方式:${result.completedBy}` : ''].filter(Boolean);
    return `${body}${flags.length ? `\n（${flags.join('，')}）` : ''}`;
}

export function registerCoreCommandTool(): Tool {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'run_core_command',
            description: 'Execute a core command locally in SealDice by injecting a fake message through the ob11-core-bridge WebSocket (e.g. ext, help, roll) and collect the multiple messages the core returns. Callable commands are restricted by the callable-command whitelist, whose format is core|command/alias; action=list shows the currently callable core commands. Core commands cannot be called directly by the plugin and require the core bridge backend.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'call'], description: 'list=list callable core commands; call=execute a core command' },
                    command: { type: 'string', description: 'Core command name for structured mode, without prefix; core|command is also supported' },
                    args: { type: 'array', items: { type: 'string' }, description: 'Command arguments, in order' },
                    raw_message: { type: 'string', description: 'Raw-message mode; injected into the core as-is, cannot be combined with command/args' },
                    maxMessages: { type: 'integer', minimum: 1, maximum: 50, description: 'Max number of reply messages to collect' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 10000, description: 'How long to wait for silence after receiving a message before finishing' },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, description: 'Max wait time in milliseconds' },
                    captureMode: { type: 'string', enum: ['reply_only', 'lane'], description: 'Message capture scope' },
                    forward: { type: 'boolean', description: 'Whether to forward captured messages to the protocol side; default true' },
                    trigger: { type: 'string', description: 'Optional; sender/trigger user ID for the injected command message' },
                    at: { type: 'array', items: { type: 'string' }, description: 'Optional; @ these users (user IDs) from the injected command message (group chats only)' }
                },
                required: ['action']
            }
        }
    }, true);

    tool.solve = async (ctx, _msg, _session, args) => {
        const action = String(args && args.action || '');
        if (action === 'list') {
            const list = whitelistEntries().map(item => splitEntry(item)).filter(item => item && item.extName === 'core').map(item => `core|${item!.cmd}`);
            return `可调用核心指令（共 ${list.length} 个）：\n${list.length ? list.join('\n') : '（除 .ext 外暂无白名单核心指令）'}\n核心扩展发现：使用 action=call、command=ext 查看全部扩展名称`;
        }
        if (action !== 'call') return 'action 仅支持 list 或 call';

        const rawMessage = typeof args.raw_message === 'string' ? args.raw_message : undefined;
        const hasRawMessage = rawMessage !== undefined;
        const hasStructuredArgs = args.command !== undefined || args.args !== undefined;
        if (hasRawMessage && hasStructuredArgs) return 'raw_message 不能与 command/args 同时使用';

        let command = String(args && args.command || '').trim();
        if (command.indexOf('core|') === 0) command = command.slice(5).trim();
        if (!hasRawMessage && !command) return '调用核心指令时 command 不能为空';

        let authorizedCommand = command;
        if (hasRawMessage) {
            authorizedCommand = extractAuthorizedCommand(rawMessage!);
            if (!authorizedCommand) return '调用核心指令时 raw_message 不能为空';
        }
        if (!isAllowedCore(authorizedCommand)) return `核心指令 core|${authorizedCommand} 不在可调用指令白名单内，无法调用`;

        const cmdArgs = Array.isArray(args && args.args) ? args.args.map(String) : [];
        const commandTarget = resolveCommandTarget(ctx, args);
        if (commandTarget.at.length && ctx.isPrivate) return '私聊消息不支持 at';
        const options = captureOptions(args, 50, 500);
        if (authorizedCommand === 'ext' && !(args && args.captureMode)) options.capture.mode = 'lane';

        const target: {
            selfId: string;
            messageType: 'private' | 'group';
            userId: string;
            groupId?: string;
        } = {
            selfId: String(ctx.endPoint.userId || '').replace(/^.+:/, ''),
            messageType: ctx.isPrivate ? 'private' : 'group',
            userId: commandTarget.effectiveTrigger
        };
        if (!ctx.isPrivate) target.groupId = String(ctx.group && ctx.group.groupId || '').replace(/^.+:/, '');

        try {
            const payload: {
                target: typeof target;
                actor: { userId: string; nickname: string; role: string };
                raw_message?: string;
                command?: { raw: string; name: string; args: string[] };
                capture: typeof options.capture;
                timeoutMs?: number;
                trigger?: string;
                at?: string[];
            } = {
                target,
                actor: {
                    userId: commandTarget.effectiveTrigger || target.selfId,
                    nickname: await resolveCommandActorNickname(ctx, commandTarget.effectiveTrigger || target.selfId),
                    role: 'member'
                },
                capture: options.capture,
                timeoutMs: options.timeoutMs,
                trigger: commandTarget.effectiveTrigger,
                at: commandTarget.at
            };
            if (hasRawMessage) payload.raw_message = rawMessage;
            else {
                const prefix = Config.tool.COMMAND_PREFIX;
                const raw = `${prefix}${command}${cmdArgs.length ? ` ${cmdArgs.join(' ')}` : ''}`.trim();
                payload.command = { raw, name: command, args: cmdArgs };
            }
            const result = await callCoreBridgeCommand(payload, options.timeoutMs || 10000);
            return `核心指令 core|${authorizedCommand} 返回：\n${formatCoreBridgeResult(result)}`;
        } catch (e) {
            log.warning(`[run_core_command] 调用 core|${authorizedCommand} 失败:${e instanceof Error ? e.message : String(e)}`);
            return `核心指令 core|${authorizedCommand} 调用失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };

    return tool;
}
