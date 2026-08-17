// 海豹指令工具：扩展指令本地直调 solve；核心指令由 MCP 适配器注册 run_core_command。
import Config from "../../../config/config";
import Logger from "../../../logger";
import { collectCommands, extensionNames, isAllowedExtension, ResolvedCommand, resolveEntry } from "../../command_catalog";
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
            description: `在 SealDice 本地直接调用扩展指令的 solve，不依赖核心桥/中间件，无需 MCP 与协议端。扩展分为 builtin（fun/story/coc7/deck/dnd5e/exp/log/reply）与 non_builtin（第三方扩展及本插件），无需配置内置扩展列表。action=list 可按 kind 列出指令；action=call 执行指令，并收集扩展发出的多条消息作为返回。可调用指令仍受「可调用指令白名单」约束，白名单格式为扩展名|指令名。核心指令请使用 run_core_command。`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'call'], description: 'list=列出扩展指令；call=执行扩展指令' },
                    kind: { type: 'string', enum: ['builtin', 'non_builtin', 'all'], description: 'list 时筛选扩展类型，默认 all' },
                    extension: { type: 'string', description: '扩展名；call 时可填写，核心扩展名不是这里的 core' },
                    command: { type: 'string', description: '指令名；也支持直接填写 扩展名|指令名' },
                    args: { type: 'array', items: { type: 'string' }, description: '指令参数，按顺序填写' },
                    maxMessages: { type: 'integer', minimum: 1, maximum: 50, description: '最多收集多少条回复消息' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 10000, description: '收到消息后等待多久没有新消息才结束' },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, description: '最长等待时间，单位毫秒' }
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
            return `${formatList(collectCommands(kind))}\n扩展名称（核心 .ext 可查看完整列表）：${extensionNames().join('、')}`;
        }
        if (action !== 'call') return 'action 仅支持 list 或 call';
        const extension = String(args && args.extension || '').trim();
        const command = String(args && args.command || '').trim();
        if (!command) return '调用扩展指令时 command 不能为空';
        const parsed = parseExtCommand(extension, command);
        const rc = parsed.resolved;
        if (!rc) return `无法解析扩展指令 ${parsed.requested}：请确认扩展已安装，并使用 扩展名|指令名 格式`;
        if (rc.kind === 'core') return '核心指令请使用 run_core_command，不要使用 run_ext_command';
        const requested = `${rc.extName}|${rc.cmd}`;
        if (!isAllowedExtension(rc)) return `扩展指令 ${requested} 不在可调用指令白名单内，无法调用`;
        const cmdArgs = Array.isArray(args && args.args) ? args.args.map(String) : [];
        try {
            const content = await executeExtensionLocally(ctx, msg, session, rc, cmdArgs, {
                prefix: Config.tool.COMMAND_PREFIX,
                timeoutMs: optionNumber(args && args.timeoutMs),
                settleMs: optionNumber(args && args.settleMs),
                maxMessages: optionNumber(args && args.maxMessages)
            });
            return `扩展指令 ${requested} 返回：\n${content}`;
        } catch (e) {
            Logger.warning(`[run_ext_command] 调用 ${requested} 失败:${e instanceof Error ? e.message : String(e)}`);
            return `扩展指令 ${requested} 调用失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };

    return extTool;
}
