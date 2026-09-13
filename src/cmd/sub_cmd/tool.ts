// .ai tool：工具组概览 / 组内明细 / 工具与工具组开关 / 工具详情 / 试用
// 组维度 = 内置工具分类（category）+ MCP 服务器（group）；技能/知识库由 .ai skill / .ai kb 管理，不参与组维度。
import Config from "../../config/config";
import { logger } from "../../logger";
import { getConfiguredMCPServers, isMCPEnabled } from "../../tool/mcp";
import Tool, { ToolGroupInfo, toolMap } from "../../tool/tool";
import { formatGroupToggleReply, setToolGroupState } from "../../tool/tool_group";
import { matchesPlatform, platformOf } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

function helpText(): string {
    return `帮助:
      【.ai tool】工具组概览（组名 + 工具数 + 开关统计）
      【.ai tool <组名>】查看组内工具明细（等价写法 --group=<组名>）
      【.ai tool <函数名>】查看工具详情
      【.ai tool all】扁平列出全部工具（含技能/知识库）
      【.ai tool [on/off] [<组名|函数名>]】开启或关闭整组或单个工具；无参=全部工具（off 默认跳过核心常驻工具，加 --force 一并关闭）
      【.ai tool help <函数名>】查看工具详情
      【.ai tool call <函数名> --参数名=具体参数】试用工具函数
      说明：技能/知识库工具不参与工具组维度，请用 .ai skill / .ai kb 开关；
            组名与保留字（on/off/help/call/list/all）冲突时用 --group=<组名>`;
}

/** 读取带值的 kwarg（如 --group=记忆）；缺省/无值返回空串 */
function kwargValue(cmdArgs: seal.CmdArgs, name: string): string {
    const kwarg = cmdArgs.kwargs.find(k => k.name === name);
    if (!kwarg || !kwarg.valueExists) return '';
    return String(kwarg.value || '').trim();
}

/** 判断布尔开关 kwarg（如 --force）：出现即为真，--force=0/false 视为假 */
function hasFlag(cmdArgs: seal.CmdArgs, name: string): boolean {
    const kwarg = cmdArgs.kwargs.find(k => k.name === name);
    if (!kwarg) return false;
    if (!kwarg.valueExists) return true;
    const value = String(kwarg.value || '').trim().toLowerCase();
    return value === '' || value === '1' || value === 'true' || value === 'yes';
}

/** 工具详情文本（.ai tool <函数名> 与 .ai tool help <函数名> 共用） */
function renderToolDetail(name: string): string {
    const tool = toolMap[name];
    return `${tool.toolInfo.function.name}
      来源:${Tool.groupDisplay(tool)}
      描述:${tool.toolInfo.function.description}
      
      参数信息:
      ${JSON.stringify(tool.toolInfo.function.parameters.properties, null, 2)}
      
      必需参数:${(tool.toolInfo.function.parameters.required || []).join(',')}`;
}

/** 组概览：内置分类在前、MCP 服务器在后，只统计当前平台可用工具 */
function renderOverview(session: SubCmdContext['session'], platform: string): string {
    const groups = Tool.getToolGroups(session, platform);
    const builtin = groups.filter(g => g.kind === 'builtin');
    const mcp = groups.filter(g => g.kind === 'mcp');
    const sum = (list: ToolGroupInfo[]) => list.reduce((acc, g) => acc + g.names.length, 0);
    const lines: string[] = [
        `工具组（当前平台 ${platform || '未知'}；内置 ${sum(builtin)} 个 / ${builtin.length} 组${mcp.length > 0 ? `，MCP ${sum(mcp)} 个 / ${mcp.length} 台` : ''}）:`
    ];

    if (builtin.length > 0) {
        lines.push('[内置]');
        builtin.forEach((g, i) => lines.push(`  ${i + 1}. ${g.key}（${g.names.length}，开 ${g.on} 关 ${g.off}）`));
    }
    if (mcp.length > 0) {
        lines.push('[MCP 服务器]');
        for (const g of mcp) lines.push(`  ${g.key}（${g.names.length}，开 ${g.on} 关 ${g.off}）`);
    }
    if (builtin.length === 0 && mcp.length === 0) lines.push('  （没有可用工具）');

    // MCP 配置了但没注册到工具（服务器不可达/未同步）时给一条提示
    if (isMCPEnabled()) {
        const registered = new Set(mcp.map(g => g.key));
        const emptyServers = getConfiguredMCPServers()
            .filter(s => matchesPlatform(s.platforms, platform) && !registered.has(s.name))
            .map(s => s.name);
        if (emptyServers.length > 0) {
            lines.push(`（MCP 服务器 ${emptyServers.join('、')} 未注册到工具：不可达或未同步，可 .ai mcp refresh）`);
        }
    }

    const blocked = (Config.tool.BLOCKED || []).filter(n => String(n || '').trim() !== '');
    if (blocked.length > 0) lines.push(`（「禁止调用的函数」${blocked.length} 个不参与统计与开关）`);

    lines.push('用 .ai tool <组名> 查看组内工具，.ai tool on/off <组名> 批量开关（--group= 强制按组解析）。');
    lines.push('技能/知识库工具不在工具组范围：见 .ai skill list / .ai kb list；全部工具：.ai tool all。');
    return lines.join('\n');
}

/** 组内明细 */
function renderGroupDetail(group: ToolGroupInfo, session: SubCmdContext['session']): string {
    const state = session.toolState;
    const kind = group.kind === 'mcp' ? 'MCP 服务器' : '内置';
    const lines = [`工具组「${group.key}」（${kind}）：${group.names.length} 个，开 ${group.on} 关 ${group.off}`];
    group.names.forEach((name, i) => lines.push(`  ${i + 1}. ${name}[${state[name] ? '开' : '关'}]`));
    const equivalent = group.kind === 'mcp' ? `（等价 .ai mcp on/off ${group.key}）` : '';
    lines.push(`批量开关：.ai tool on/off ${group.key}${equivalent}`);
    return lines.join('\n');
}

/** 扁平全量列表（.ai tool all）：按来源/分类分组，含技能与知识库 */
function renderAllTools(session: SubCmdContext['session'], platform: string): string {
    const byGroup: { [label: string]: { name: string; status: string }[] } = {};
    for (const name of Object.keys(session.toolState)) {
        const tool = toolMap[name];
        if (!tool) continue;
        if (platform && !Tool.isAllowedPlatform(tool, platform)) continue;
        const label = Tool.groupDisplay(tool);
        (byGroup[label] = byGroup[label] || []).push({ name, status: session.toolState[name] ? '开' : '关' });
    }
    const lines = ['工具函数（当前平台，按来源/分类分组）:'];
    for (const label of Object.keys(byGroup).sort()) {
        lines.push(`${label}:`);
        for (const item of byGroup[label].sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`  ${item.name}[${item.status}]`);
        }
    }
    return lines.join('\n');
}

export function registerCmdTool() {
    const cmd = new SubCmd('tool');
    cmd.desc = '工具相关操作';
    cmd.help = helpText();
    cmd.priv = {
        priv: U, args: {
            on: { priv: I },
            off: { priv: I },
            help: { priv: U },
            call: { priv: M },
            "*": { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const platform = platformOf(ctx);
        const reply = (text: string) => seal.replyToSender(ctx, msg, text);

        /** 组开关（含 --force） */
        const toggleGroup = (group: ToolGroupInfo, enable: boolean, force: boolean) => {
            const result = setToolGroupState(session, group.names, enable, { skipBlocked: enable, skipCore: !enable && !force });
            reply(formatGroupToggleReply(`工具组「${group.key}」`, enable, result));
        };

        /** 解析组名：返回 ToolGroupInfo，或已回复过的错误 */
        const pickGroup = (arg: string, groups: ToolGroupInfo[]): ToolGroupInfo | null => {
            const resolved = Tool.resolveToolGroup(arg, groups);
            if (typeof resolved === 'string') {
                reply(resolved);
                return null;
            }
            return resolved;
        };

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'on':
            case 'off': {
                const enable = aliasToCmd(val2) === 'on';
                const force = hasFlag(cmdArgs, 'force');
                const groupArg = kwargValue(cmdArgs, 'group');
                const target = String(cmdArgs.getArgN(3) || '').trim();
                const groups = Tool.getToolGroups(session, platform);

                // 1) 显式 --group=<组名> 优先（绕开保留字与撞名）
                if (groupArg) {
                    const group = pickGroup(groupArg, groups);
                    if (group) toggleGroup(group, enable, force);
                    return ret;
                }

                // 2) 无参：全部工具（off 默认跳过核心常驻工具）
                if (!target) {
                    const names = Object.keys(session.toolState);
                    const result = setToolGroupState(session, names, enable, { skipBlocked: enable, skipCore: !enable && !force });
                    const extra = !enable && !force ? '\n（核心常驻工具默认保留，关掉后 AI 将无法发现/执行其余工具；如需一并关闭加 --force）' : '';
                    reply(formatGroupToggleReply('全部工具', enable, result) + extra);
                    return ret;
                }

                // 3) 工具名：单工具开关（行为与历史一致，不跳过核心工具）
                if (Object.prototype.hasOwnProperty.call(toolMap, target)) {
                    if (enable && Config.tool.BLOCKED.includes(target)) {
                        reply(`工具函数 ${target} 不被允许开启`);
                        return ret;
                    }
                    session.tool.state[target] = enable;
                    reply(`已${enable ? '开启' : '关闭'}工具函数 ${target}`);
                    session.save();
                    return ret;
                }

                // 4) 组名：整组开关
                const resolved = Tool.resolveToolGroup(target, groups);
                if (typeof resolved === 'string') {
                    reply(`${resolved}（若本意是开关单个工具函数，请核对函数名；.ai tool all 列出全部工具）`);
                } else {
                    toggleGroup(resolved, enable, force);
                }
                return ret;
            }
            case 'help': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    reply(helpText());
                    return ret;
                }
                if (!Object.prototype.hasOwnProperty.call(toolMap, val3)) {
                    reply('没有这个工具函数');
                    return ret;
                }
                reply(renderToolDetail(val3));
                return ret;
            }
            case 'call': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    reply(`调用函数缺少工具函数名`);
                    return ret;
                }
                if (!Object.prototype.hasOwnProperty.call(toolMap, val3)) {
                    reply(`调用函数失败:未注册的函数:${val3}`);
                    return ret;
                }
                const tool = toolMap[val3];
                try {
                    const args = cmdArgs.kwargs.reduce((acc: { [key: string]: any }, kwarg) => {
                        const valueString = kwarg.value;
                        try {
                            acc[kwarg.name] = JSON.parse(`[${valueString}]`)[0];
                        } catch (_e) {
                            acc[kwarg.name] = valueString;
                        }
                        return acc;
                    }, {} as { [key: string]: any });

                    for (const key of (tool.toolInfo.function.parameters.required || [])) {
                        if (!Object.prototype.hasOwnProperty.call(args, key)) {
                            logger.warning(`调用函数失败:缺少必需参数 ${key}`);
                            reply(`调用函数失败:缺少必需参数 ${key}`);
                            return ret;
                        }
                    }

                    const solved = await tool.solve(ctx, msg, session, args);
                    const content = typeof solved === 'string' ? solved : solved.text;
                    logger.info(`[tool] 指令调用 session=${session.sessionId} tool=${val3}`);
                    const MAX_TOOL_CALL_OUTPUT_LENGTH = 500;
                    if (content.length > MAX_TOOL_CALL_OUTPUT_LENGTH) {
                        logger.logLong(`[tool] 返回内容过长(${content.length}字符)，已仅记录日志，未发送`, content);
                        reply(`返回内容过长（${content.length} 字符），未发送，已记录到海豹日志（[tool] 指令调用 tool=${val3}）`);
                    } else {
                        reply(`返回内容:
      ${content}`);
                    }
                    return ret;
                } catch (e) {
                    reply(`调用函数 (${val3}) 失败:${e instanceof Error ? e.message : String(e)}`);
                    return ret;
                }
            }
            default: {
                // 无参或 list：组概览
                const arg = String(val2 || '').trim();
                const groupArg = kwargValue(cmdArgs, 'group');

                if (groupArg) {
                    const group = pickGroup(groupArg, Tool.getToolGroups(session, platform));
                    if (group) reply(renderGroupDetail(group, session));
                    return ret;
                }
                if (arg === '' || aliasToCmd(arg) === 'list') {
                    reply(renderOverview(session, platform));
                    return ret;
                }
                if (arg === 'all') {
                    reply(renderAllTools(session, platform));
                    return ret;
                }
                // 工具名 → 详情；组名 → 组明细
                if (Object.prototype.hasOwnProperty.call(toolMap, arg)) {
                    reply(renderToolDetail(arg));
                    return ret;
                }
                const groups = Tool.getToolGroups(session, platform);
                const group = Tool.resolveToolGroup(arg, groups);
                if (typeof group === 'string') {
                    const candidates = groups.map(g => g.key).slice(0, 12).join('、');
                    reply(`${group}\n可用组：${candidates}；全部工具：.ai tool all`);
                    return ret;
                }
                reply(renderGroupDetail(group, session));
                return ret;
            }
        }
    }
}
