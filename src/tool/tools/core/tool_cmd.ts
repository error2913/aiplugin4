// 海豹指令工具：扩展指令与核心指令走独立工具，并通过 OB11 核心桥注入假消息。
import Config from "../../../config/config";
import { CoreBridgeClient, formatCoreBridgeResult } from "../../../integration/core_bridge/client";
import Logger from "../../../logger";
import { collectCommands, extensionNames, isAllowedCore, isAllowedExtension, ResolvedCommand, resolveEntry, splitEntry } from "../../command_catalog";
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

function captureOptions(args: { [key: string]: any }, defaultMaxMessages: number, defaultSettleMs: number): {
    capture: { mode: 'reply_only' | 'lane'; forward: boolean; maxMessages: number; settleMs: number };
    timeoutMs?: number;
} {
    const forward = args && args.forward === true;
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

export function registerCmdTool() {
    const extTool = new Tool({
        type: 'function',
        function: {
            name: 'run_ext_command',
            description: `通过核心桥向 SealDice 注入一条假消息并执行扩展指令。扩展分为 builtin（fun/story/coc7/deck/dnd5e/exp/log/reply）与 non_builtin（第三方扩展及本插件），无需配置内置扩展列表。action=list 可按 kind 列出指令；action=call 执行指令。可调用指令仍受「可调用指令白名单」约束，白名单格式为扩展名|指令名。核心指令请使用 run_core_command。`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'call'], description: 'list=列出扩展指令；call=执行扩展指令' },
                    kind: { type: 'string', enum: ['builtin', 'non_builtin', 'all'], description: 'list 时筛选扩展类型，默认 all' },
                    extension: { type: 'string', description: '扩展名；call 时可填写，核心扩展名不是这里的 core' },
                    command: { type: 'string', description: '指令名；也支持直接填写 扩展名|指令名' },
                    args: { type: 'array', items: { type: 'string' }, description: '指令参数，按顺序填写' },
                    forward: { type: 'boolean', description: '是否把捕获到的核心发送消息继续转发给协议端，默认 false（避免重复发送）' },
                    captureMode: { type: 'string', enum: ['reply_only', 'lane'], description: '消息捕获范围；forward=true 且希望捕获协议端回复时建议使用 lane' },
                    maxMessages: { type: 'integer', minimum: 1, maximum: 50, description: '最多收集多少条消息' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 10000, description: '收到消息后等待多久没有新消息才结束' },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, description: '最长等待时间，单位毫秒' }
                },
                required: ['action']
            }
        }
    });
    extTool.sensitive = true;
    extTool.solve = async (ctx, _msg, _session, args) => {
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
        const options = captureOptions(args, 20, 400);
        try {
            const result = await CoreBridgeClient.call(ctx, rc.cmd, cmdArgs, options.capture, options.timeoutMs);
            return `扩展指令 ${requested} 返回：\n${formatCoreBridgeResult(result)}`;
        } catch (e) {
            Logger.warning(`[run_ext_command] 调用 ${requested} 失败:${e instanceof Error ? e.message : String(e)}`);
            return `扩展指令 ${requested} 调用失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };

    const coreTool = new Tool({
        type: 'function',
        function: {
            name: 'run_core_command',
            description: `通过核心桥向 SealDice 注入一条假消息并执行核心指令。白名单中的核心扩展名统一写作 core|指令名；核心 .ext 是扩展发现入口，不需要加入白名单，调用 command="ext" 即可查看核心当前全部扩展名称。默认指令前缀为 .，可在配置中修改。`,
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'call'], description: 'list=列出白名单核心指令；call=执行核心指令' },
                    command: { type: 'string', description: '核心指令名，如 ext、help；也支持 core|ext' },
                    args: { type: 'array', items: { type: 'string' }, description: '指令参数，按顺序填写' },
                    forward: { type: 'boolean', description: '是否把捕获到的核心发送消息继续转发给协议端，默认 false（避免重复发送）' },
                    captureMode: { type: 'string', enum: ['reply_only', 'lane'], description: '消息捕获范围；forward=true 且希望捕获协议端回复时建议使用 lane' },
                    maxMessages: { type: 'integer', minimum: 1, maximum: 50, description: '最多收集多少条消息' },
                    settleMs: { type: 'integer', minimum: 0, maximum: 10000, description: '收到消息后等待多久没有新消息才结束' },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, description: '最长等待时间，单位毫秒' }
                },
                required: ['action']
            }
        }
    });
    coreTool.sensitive = true;
    coreTool.solve = async (ctx, _msg, _session, args) => {
        const action = String(args && args.action || '');
        if (action === 'list') {
            const list = Config.tool.CMD_WHITELIST.map(item => splitEntry(String(item))).filter(item => item && item.extName === 'core').map(item => `core|${item!.cmd}`);
            return `可调用核心指令（共 ${list.length} 个）：\n${list.length ? list.join('\n') : '（除 .ext 外暂无白名单核心指令）'}\n核心扩展发现：使用 action=call、command=ext 查看全部扩展名称`;
        }
        if (action !== 'call') return 'action 仅支持 list 或 call';
        let command = String(args && args.command || '').trim();
        if (command.indexOf('core|') === 0) command = command.slice(5).trim();
        if (!command) return '调用核心指令时 command 不能为空';
        if (!isAllowedCore(command)) return `核心指令 core|${command} 不在可调用指令白名单内，无法调用`;
        const cmdArgs = Array.isArray(args && args.args) ? args.args.map(String) : [];
        const options = captureOptions(args, 50, 500);
        if (command === 'ext' && !(args && args.captureMode)) options.capture.mode = 'lane';
        try {
            const result = await CoreBridgeClient.call(ctx, command, cmdArgs, options.capture, options.timeoutMs, 'run_core_command');
            return `核心指令 core|${command} 返回：\n${formatCoreBridgeResult(result)}`;
        } catch (e) {
            Logger.warning(`[run_core_command] 调用 core|${command} 失败:${e instanceof Error ? e.message : String(e)}`);
            return `核心指令 core|${command} 调用失败：${e instanceof Error ? e.message : String(e)}`;
        }
    };

    return coreTool;
}
