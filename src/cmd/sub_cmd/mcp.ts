// .ai mcp：MCP 服务器查看 / 批量开关其工具 / prompts 手动触发 / refresh 重走配置解析
import {
    getConfiguredMCPServers, getMCPServerPrompt, isMCPEnabled, listMCPServerPrompts,
    refreshMCP, renderPromptMessages,
} from "../../tool/mcp";
import type { MCPPromptDef } from "../../tool/mcp";
import { toolMap } from "../../tool/registry";
import { setToolGroupState } from "../../tool/tool_group";
import { aliasToCmd } from "../../utils/alias";
import { matchesPlatform, platformOf } from "../../utils/target_id";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 列表/描述单行化（MCP 服务器文本原样保留内容，仅去换行便于展示） */
function oneLine(text: string, max = 200): string {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** prompts/list 的用户侧目录（中文界面；文本内容本身来自服务器，不翻译） */
function renderPromptList(serverName: string, prompts: MCPPromptDef[]): string[] {
    const lines: string[] = [`MCP prompts（${serverName}）:`];
    if (prompts.length === 0) {
        lines.push('  （该服务器没有提供 prompt 模板）');
        return lines;
    }
    for (const prompt of prompts) {
        const args = Array.isArray(prompt.arguments) && prompt.arguments.length > 0
            ? `（参数：${prompt.arguments.map(arg => `${arg.name}${arg.required ? '（必填）' : ''}`).join(', ')}）`
            : '';
        const desc = prompt.description ? `：${oneLine(prompt.description)}` : '';
        lines.push(`  ${prompt.name}${desc}${args}`);
    }
    lines.push('用 .ai mcp prompt get <服务器> <名称> [--arg k=v ...] 取回内容（仅手动触发，不会自动注入提示词）。');
    return lines;
}

/** 解析 --arg k=v（可重复；k 不带 = 时按空值处理，兼容无值参数） */
function parsePromptArgs(cmdArgs: seal.CmdArgs): { args: { [key: string]: string }; errors: string[] } {
    const args: { [key: string]: string } = {};
    const errors: string[] = [];
    for (const kwarg of cmdArgs.kwargs) {
        if (kwarg.name !== 'arg' && kwarg.name !== 'a') continue;
        const raw = String(kwarg.value ?? '');
        const eq = raw.indexOf('=');
        if (eq < 0) {
            const key = raw.trim();
            if (!key) {
                errors.push('--arg 需要 k=v 形式');
                continue;
            }
            args[key] = '';
            continue;
        }
        const key = raw.slice(0, eq).trim();
        if (!key) {
            errors.push(`--arg ${raw} 缺少参数名`);
            continue;
        }
        args[key] = raw.slice(eq + 1);
    }
    return { args, errors };
}

function helpText(): string {
    return `帮助: MCP 服务器管理
  【.ai mcp list】列出当前平台可用的 MCP 服务器及其工具开关状态
  【.ai mcp on/off [<服务器>]】开启/关闭指定服务器（或缺省=全部当前平台服务器）下的全部工具
  【.ai mcp prompt list [<服务器>]】列出服务器提供的 prompt 模板（用户手动触发，不会自动注入）
  【.ai mcp prompt get <服务器> <名称> [--arg k=v ...]】取回 prompt 内容并作为普通消息展示（不写系统提示词、不触发 AI 回复）
  【.ai mcp refresh】重新解析 MCP 配置并强制同步工具列表（骰主）
  说明：服务器配置增删/平台修改后用 refresh 生效；工具开关按会话保存，禁用名单（禁止调用的函数）不受 on 影响`;
}

export function registerCmdMcp() {
    const cmd = new SubCmd('mcp');
    cmd.desc = 'MCP 服务器管理（list/on/off/prompt/refresh）';
    cmd.help = helpText();
    cmd.priv = { priv: U, args: { on: { priv: I }, off: { priv: I }, prompt: { priv: U }, refresh: { priv: M }, '*': { priv: U } } };
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
                    lines.push(`${s.name}: ${names.length} 个工具（开 ${on} / 关 ${names.length - on}）${s.description ? `；用途：${s.description}` : ''}`);
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
            case 'prompt': {
                // prompts 通道：只由用户显式触发；取回内容直接回复给用户，不写 system prompt、不触发 AI 回复
                if (!isMCPEnabled()) {
                    seal.replyToSender(ctx, msg, 'MCP 未启用（请在配置「是否启用MCP」开启后重载 JS）');
                    return ret;
                }
                const servers = platformServers();
                const sub = aliasToCmd(cmdArgs.getArgN(3));
                if (sub === 'list') {
                    const target = String(cmdArgs.getArgN(4) || '').trim();
                    let serversToUse = servers;
                    if (target) {
                        const hit = servers.find(s => s.name === target);
                        if (!hit) {
                            seal.replyToSender(ctx, msg, `MCP 服务器 ${target} 未配置或当前平台不可用；用 .ai mcp list 查看`);
                            return ret;
                        }
                        serversToUse = [hit];
                    }
                    if (serversToUse.length === 0) {
                        seal.replyToSender(ctx, msg, '当前平台没有可用的 MCP 服务器（未配置或平台不匹配）。配置修改后 .ai mcp refresh 生效。');
                        return ret;
                    }
                    const lines: string[] = [];
                    for (const server of serversToUse) {
                        try {
                            const prompts = await listMCPServerPrompts(server.name);
                            lines.push(...renderPromptList(server.name, prompts));
                        } catch (e) {
                            lines.push(`MCP prompts（${server.name}）: 获取失败——${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                    seal.replyToSender(ctx, msg, lines.join('\n'));
                    return ret;
                }
                if (sub === 'get') {
                    const serverName = String(cmdArgs.getArgN(4) || '').trim();
                    const promptName = String(cmdArgs.getArgN(5) || '').trim();
                    if (!serverName || !promptName) {
                        seal.replyToSender(ctx, msg, '用法：.ai mcp prompt get <服务器> <名称> [--arg k=v ...]；先用 .ai mcp prompt list 查看');
                        return ret;
                    }
                    if (!servers.some(s => s.name === serverName)) {
                        seal.replyToSender(ctx, msg, `MCP 服务器 ${serverName} 未配置或当前平台不可用；用 .ai mcp list 查看`);
                        return ret;
                    }
                    const parsed = parsePromptArgs(cmdArgs);
                    if (parsed.errors.length > 0) {
                        seal.replyToSender(ctx, msg, `参数格式有误：${parsed.errors.join('；')}`);
                        return ret;
                    }
                    try {
                        const result = await getMCPServerPrompt(serverName, promptName, parsed.args);
                        const body = renderPromptMessages(result.messages);
                        if (!body) {
                            seal.replyToSender(ctx, msg, `MCP prompt ${serverName}/${promptName} 没有可展示的文本消息（可能只含图片/资源内容）。`);
                            return ret;
                        }
                        const header = result.description
                            ? `MCP prompt ${serverName}/${promptName}（用户手动触发，不自动注入）\n${oneLine(result.description)}\n`
                            : `MCP prompt ${serverName}/${promptName}（用户手动触发，不自动注入）\n`;
                        seal.replyToSender(ctx, msg, `${header}${body}`);
                    } catch (e) {
                        seal.replyToSender(ctx, msg, `获取 MCP prompt 失败：${e instanceof Error ? e.message : String(e)}`);
                    }
                    return ret;
                }
                seal.replyToSender(ctx, msg, `未知操作: .ai mcp prompt ${sub || ''}\n${helpText()}`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `未知操作: ${op}\n${helpText()}`);
                return ret;
            }
        }
    };
}
