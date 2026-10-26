// 海豹指令工具：扩展指令本地直调 solve；核心指令由 MCP 适配器注册 run_core_command。
import Config from "../../../config/config";
import Logger from "../../../logger";
import { collectCommands, extensionNames, findBuiltinCommands, isAllowedExtension, ResolvedCommand, resolveEntry } from "../../command_catalog";
import { qualifyCommandUserId, resolveCommandTarget } from "../../command_target";
import { executeExtensionLocally } from "../../extension_executor";
import Tool from "../../tool";

function commandText(item: ResolvedCommand): string {
    return `${item.extName}|${item.cmd}`;
}

function formatList(items: ResolvedCommand[]): string {
    return items.length
        ? `可调用扩展指令（共 ${items.length} 个）：\n${items.map((item, index) => `${index + 1}. ${commandText(item)}`).join('\n')}`
        : '当前没有可列举的扩展指令';
}

function parseExtCommand(extension: string, command: string): { requested: string; resolved: ResolvedCommand | null } {
    const requested = extension ? `${extension}|${command}` : command;
    return { requested, resolved: resolveEntry(requested) };
}

/** 解析可选数字参数；非法或负数视为未提供，由执行器回退到默认值。 */
function optionNumber(value: any): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function registerCmdTool(): Tool {
    const extTool = new Tool({
        type: 'function',
        function: {
            name: 'run_ext_command',
            description: `Invoke an extension command's solve locally inside SealDice; no core bridge/middleware, MCP or protocol backend required. Use trigger to set the sender and at to simulate @-mentions. Extensions are builtin (fun/story/coc7/deck/dnd5e/exp/log/reply) or non_builtin (third-party extensions and this plugin); no builtin extension list needs configuring. action=list lists commands by kind; action=call executes a command and collects the multiple messages the extension emits as the result. Callable commands are still restricted by the callable-command whitelist, whose format is extension|command/alias1/alias2 (aliases within one element are separated by /). For core commands use run_core_command instead.`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'call'], description: 'list=list extension commands; call=execute an extension command' },
                    kind: { type: 'string', enum: ['builtin', 'non_builtin', 'all'], description: 'Filter extension kind when listing; default all' },
                    extension: { type: 'string', description: 'Extension name; only needed for call. The core extension is not named core here' },
                    command: { type: 'string', description: 'Command name; you may also write extension|command directly' },
                    args: { type: 'array', items: { type: 'string' }, description: 'Command arguments, in order' },
                    trigger: { type: 'string', description: 'Optional; sender/trigger user ID for the injected command message; defaults to the current conversation user' },
                    at: { type: 'array', items: { type: 'string' }, description: 'Optional; @ these users (user IDs) from the injected command message; group chats only, not supported in private chats' },
                    maxMessages: { type: 'integer', minimum: 1, maximum: 50, description: 'Max number of reply messages to collect' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 10000, description: 'How long to wait for silence after receiving a message before finishing' },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, description: 'Max wait time in milliseconds' }
                },
                required: ['action']
            }
        }
    });
    extTool.sensitive = true;
    extTool.solve = async (ctx, msg, session, args) => {
        const action = String(args && args.action || '');
        if (action === 'list') {
            const kind = args && args.kind === 'builtin' || args && args.kind === 'non_builtin' ? args.kind : 'all';
            return `${formatList(collectCommands(kind).filter(isAllowedExtension))}\n扩展名称（核心 .ext 可查看完整列表）：${extensionNames().join('、')}`;
        }
        if (action !== 'call') return 'action 仅支持 list 或 call';
        const extension = String(args && args.extension || '').trim();
        const command = String(args && args.command || '').trim();
        if (!command) return '调用扩展指令时 command 不能为空';
        if (!extension && !command.includes('|')) {
            const matches = findBuiltinCommands(command);
            if (matches.length > 1) {
                return `指令 ${command} 在多个扩展中存在：${matches.map(m => `${m.extName}|${m.cmd}`).join('、')}，请明确指定 extension`;
            }
        }
        const parsed = parseExtCommand(extension, command);
        const rc = parsed.resolved;
        if (!rc) return `无法解析扩展指令 ${parsed.requested}：请确认扩展已安装，并使用 扩展名|指令名 格式`;
        if (rc.kind === 'core') return '核心指令请使用 run_core_command，不要使用 run_ext_command';
        const requested = `${rc.extName}|${rc.cmd}`;
        if (!isAllowedExtension(rc)) return `扩展指令 ${requested} 不在可调用指令白名单内，无法调用`;
        const cmdArgs = Array.isArray(args && args.args) ? args.args.map(String) : [];
        const target = resolveCommandTarget(ctx, args);
        if (target.at.length && ctx.isPrivate) return '私聊消息不支持 at';
        const at = target.at.map(userId => ({
            userId: qualifyCommandUserId(ctx, userId),
            isRobot: userId === String(ctx.endPoint.userId || '').replace(/^.+:/, ''),
            name: ''
        }));
        try {
            const content = await executeExtensionLocally(ctx, msg, session, rc, cmdArgs, {
                prefix: Config.tool.COMMAND_PREFIX,
                timeoutMs: optionNumber(args && args.timeoutMs),
                settleMs: optionNumber(args && args.settleMs),
                maxMessages: optionNumber(args && args.maxMessages),
                at,
                trigger: target.trigger
            });
            return `扩展指令 ${requested} 返回：\n${content}`;
        } catch (e) {
            Logger.warning(`[run_ext_command] 调用 ${requested} 失败:${e instanceof Error ? e.message : String(e)}`);
            return `扩展指令 ${requested} 调用失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };

    return extTool;
}
