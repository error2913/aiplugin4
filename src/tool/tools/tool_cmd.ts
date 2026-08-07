// 指令调用工具：读取海豹扩展 cmdMap 列出可用指令（含帮助），并调用指令获取返回
import Config from "../../config/config";
import { NAME } from "../../config/static_config";
import Logger from "../../logger";
import Tool from "../tool";

// SealDice 核心内置扩展名，用于「允许所有指令」模式下的命令列举
const BUILTIN_EXT_NAMES = ['fun', 'story', 'coc7', 'deck', 'dnd5e', 'exp', 'log', 'reply', 'template'];

interface ResolvedCmd {
    extName: string;
    cmd: string;
    help: string;
}

function getCmdHelp(ext: seal.ExtInfo, cmd: string): string {
    const item = ext.cmdMap?.[cmd];
    return item && item.help ? item.help : '';
}

/** 解析条目：支持 扩展名|指令名 或裸 指令名（优先按同名扩展解析，其次扫描内置扩展） */
function resolveEntry(entry: string): ResolvedCmd | null {
    const s = (entry || '').trim();
    if (!s) return null;
    const pipe = s.indexOf('|');
    if (pipe !== -1) {
        const extName = s.slice(0, pipe).trim();
        const cmd = s.slice(pipe + 1).trim();
        if (!extName || !cmd) return null;
        const ext = seal.ext.find(extName);
        if (ext && ext.cmdMap && Object.prototype.hasOwnProperty.call(ext.cmdMap, cmd)) {
            return { extName: ext.name || extName, cmd, help: getCmdHelp(ext, cmd) };
        }
        return null;
    }
    const byName = seal.ext.find(s);
    if (byName && byName.cmdMap && Object.prototype.hasOwnProperty.call(byName.cmdMap, s)) {
        return { extName: byName.name || s, cmd: s, help: getCmdHelp(byName, s) };
    }
    for (const extName of BUILTIN_EXT_NAMES) {
        const ext = seal.ext.find(extName);
        if (ext && ext.cmdMap && Object.prototype.hasOwnProperty.call(ext.cmdMap, s)) {
            return { extName, cmd: s, help: getCmdHelp(ext, s) };
        }
    }
    return null;
}

/** 指令是否允许调用：必须在白名单内 */
function isAllowed(command: string): boolean {
    return Config.tool.CMD_WHITELIST.some(entry => {
        const rc = resolveEntry(entry);
        return rc !== null && (rc.cmd === command || `${rc.extName}|${rc.cmd}` === command);
    });
}

/** 收集可列举指令列表 */
function collectCommands(all: boolean): ResolvedCmd[] {
    const seen: { [key: string]: boolean } = {};
    const result: ResolvedCmd[] = [];
    const push = (rc: ResolvedCmd | null) => {
        if (!rc) return;
        const key = `${rc.extName}/${rc.cmd}`;
        if (seen[key]) return;
        seen[key] = true;
        result.push(rc);
    };
    const { CMD_WHITELIST } = Config.tool;
    for (const entry of CMD_WHITELIST) push(resolveEntry(entry));
    if (all) {
        // 查看全部：核心内置扩展 + 插件自身扩展（第三方插件指令无法枚举，需加入白名单）
        for (const extName of BUILTIN_EXT_NAMES) {
            const ext = seal.ext.find(extName);
            if (ext && ext.cmdMap) {
                for (const cmd of Object.keys(ext.cmdMap)) {
                    push({ extName: ext.name || extName, cmd, help: getCmdHelp(ext, cmd) });
                }
            }
        }
        const self = seal.ext.find(NAME);
        if (self && self.cmdMap) {
            for (const cmd of Object.keys(self.cmdMap)) {
                push({ extName: self.name || NAME, cmd, help: getCmdHelp(self, cmd) });
            }
        }
    }
    return result;
}

export function registerCmdTool() {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'run_command',
            description: `读取海豹扩展指令表（cmdMap）并调用海豹指令。action=list：列出指令及其帮助，默认只列白名单内指令，all=true 时额外列出核心内置扩展与插件自身的指令（第三方插件指令无法枚举，需加入白名单才能列出）；action=call：调用 command 指定的指令并返回执行结果，仅能调用白名单内的指令。注意：调用指令需要在最近收到过一条指令消息（如 .r）后才能获取返回。`,
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'call'],
                        description: 'list=列出指令及帮助；call=调用指令'
                    },
                    command: {
                        type: 'string',
                        description: '指令名（如 今日老婆、jrrp），也支持 扩展名|指令名 格式；list 时留空表示列出全部'
                    },
                    all: {
                        type: 'boolean',
                        description: '仅 list 使用：true 时额外列出全部可解析指令（核心内置 + 插件自身），默认 false 只列白名单'
                    },
                    args: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '调用指令时传入的参数列表（按顺序）'
                    }
                },
                required: ['action']
            }
        }
    });
    tool.sensitive = true; // 调用指令可能发送消息/执行操作，调用会显著记录
    tool.solve = async (ctx, msg, session, args) => {
        const { action, command = '', args: cmdArgs = [], all = false } = args || {};
        if (action === 'list') {
            const list = collectCommands(all === true);
            if (list.length === 0) {
                return all === true
                    ? '当前没有可列举的指令'
                    : '可调用指令白名单为空：请先在「工具」配置的「可调用指令白名单」中添加指令';
            }
            return list.map((rc, i) => `${i + 1}. ${rc.cmd}（扩展：${rc.extName}）${rc.help ? '\n' + rc.help : ''}`).join('\n\n');
        }
        if (action === 'call') {
            const cmdStr = (command || '').trim();
            if (!cmdStr) return '调用指令时 command 不能为空';
            if (!isAllowed(cmdStr)) {
                return `指令 ${cmdStr} 不在可调用白名单内，无法调用`;
            }
            const rc = resolveEntry(cmdStr);
            if (!rc) {
                return `无法解析指令 ${cmdStr}：请确认插件已安装，或使用 扩展名|指令名 格式（如 fun|jrrp）`;
            }
            const [content, success] = await Tool.extensionSolve(
                ctx, msg, session.tool.listen,
                { extName: rc.extName, cmd: rc.cmd, staticArgs: [] },
                (cmdArgs || []).map(String), [], []
            );
            if (!success) {
                Logger.warning(`[run_command] 调用指令 ${rc.cmd} 失败`);
                return `指令 ${rc.cmd} 调用失败：请先让用户发送一条指令消息（如 .r）后再试`;
            }
            return `指令 ${rc.cmd} 返回：\n${content}`;
        }
        return 'action 仅支持 list 或 call';
    };
    return tool;
}
