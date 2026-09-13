// .ai mcp：MCP 服务器查看 / 批量开关其工具 / refresh 重走配置解析
import { getConfiguredMCPServers, isMCPEnabled, refreshMCP } from "../../tool/mcp";
import { toolMap } from "../../tool/tool";
import { setToolGroupState } from "../../tool/tool_group";
import { matchesPlatform, platformOf } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

function helpText(): string {
    return `帮助: MCP 服务器管理
  【.ai mcp list】列出当前平台可用的 MCP 服务器及其工具开关状态
  【.ai mcp on/off [<服务器>]】开启/关闭指定服务器（或缺省=全部当前平台服务器）下的全部工具
  【.ai mcp refresh】重新解析 MCP 配置并强制同步工具列表（骰主）
  说明：服务器配置增删/平台修改后用 refresh 生效；工具开关按会话保存，禁用名单（禁止调用的函数）不受 on 影响`;
}

export function registerCmdMcp() {
    const cmd = new SubCmd('mcp');
    cmd.desc = 'MCP 服务器管理（list/on/off/refresh）';
    cmd.help = helpText();
    cmd.priv = { priv: U, args: { on: { priv: I }, off: { priv: I }, refresh: { priv: M }, '*': { priv: U } } };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const platform = platformOf(ctx);
        const op = aliasToCmd(cmdArgs.getArgN(2));

        /** 当前平台匹配的服务器 */
        const platformServers = () => getConfiguredMCPServers().filter(s => matchesPlatform(s.platforms, platform));

        switch (op) {
            case '': {
                seal.replyToSender(ctx, msg, helpText());
                return ret;
            }
            case 'list': {
                if (!isMCPEnabled()) {
                    seal.replyToSender(ctx, msg, 'MCP 未启用（请在配置「是否启用MCP」开启后重载 JS，或先 .ai mcp refresh 无法生效——需先开启）');
                    return ret;
                }
                const servers = platformServers();
                if (servers.length === 0) {
                    seal.replyToSender(ctx, msg, '当前平台没有可用的 MCP 服务器（未配置或平台不匹配）。配置修改后 .ai mcp refresh 生效。');
                    return ret;
                }
                const lines: string[] = ['MCP 服务器（当前平台）:'];
                for (const s of servers) {
                    const names = Object.keys(toolMap).filter(k => toolMap[k].group === s.name).sort();
                    const on = names.filter(k => session.toolState[k]).length;
                    lines.push(`${s.name}: ${names.length} 个工具（开 ${on} / 关 ${names.length - on}）`);
                    for (const n of names) {
                        lines.push(`  ${n}[${session.toolState[n] ? '开' : '关'}]`);
                    }
                    if (names.length === 0) lines.push('  （工具未注册，服务器不可达或未同步，可 .ai mcp refresh）');
                }
                lines.push('工具开关按会话保存；.ai mcp on/off <服务器> 可批量切换（等价 .ai tool on/off <服务器>）。');
                seal.replyToSender(ctx, msg, lines.join('\n'));
                return ret;
            }
            case 'on':
            case 'off': {
                const val3 = cmdArgs.getArgN(3);
                const target = String(val3 || '').trim();
                const servers = platformServers();
                if (servers.length === 0) {
                    seal.replyToSender(ctx, msg, '当前平台没有可用的 MCP 服务器（未配置或平台不匹配）');
                    return ret;
                }
                const enable = op === 'on';
                let serversToUse = servers;
                if (target) {
                    const hit = servers.find(s => s.name === target);
                    if (!hit) {
                        seal.replyToSender(ctx, msg, `MCP 服务器 ${target} 未配置或当前平台不可用；用 .ai mcp list 查看`);
                        return ret;
                    }
                    serversToUse = [hit];
                }
                let changed = 0;
                let skipped = 0;
                for (const s of serversToUse) {
                    const names = Object.keys(toolMap).filter(k => toolMap[k].group === s.name);
                    // 与 .ai tool on/off <组名> 共用批量开关实现（MCP 工具不涉及核心常驻工具）
                    const result = setToolGroupState(session, names, enable, { skipBlocked: enable });
                    changed += result.changed + result.unchanged;
                    skipped += result.skippedBlocked;
                }
                const scope = target ? `服务器 ${target}` : '全部当前平台服务器';
                if (changed === 0) {
                    seal.replyToSender(ctx, msg, `${scope}下没有可切换的工具（工具未注册或${enable ? '全部被禁用名单拦截' : ''}，可 .ai mcp refresh）`);
                } else {
                    seal.replyToSender(ctx, msg, `已${enable ? '开启' : '关闭'} ${scope} 的 ${changed} 个工具${skipped > 0 ? `（跳过禁用名单 ${skipped} 个）` : ''}`);
                }
                session.save();
                return ret;
            }
            case 'refresh': {
                const result = await refreshMCP();
                seal.replyToSender(ctx, msg, `MCP 配置已重新解析：${result.servers} 台服务器，清理移除 ${result.removed} 台；工具列表已强制重同步。`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `未知操作: ${op}\n${helpText()}`);
                return ret;
            }
        }
    };
}
