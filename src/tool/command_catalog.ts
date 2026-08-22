import Config from "../config/config";
import { NAME } from "../config/static_config";

/** SealDice 当前核心内置扩展。扩展名是稳定的产品边界，不再暴露为用户配置。 */
export const BUILTIN_EXT_NAMES = ['fun', 'story', 'coc7', 'deck', 'dnd5e', 'exp', 'log', 'reply'];

export interface ResolvedCommand {
    extName: string;
    cmd: string;
    help: string;
    kind: 'builtin' | 'non_builtin' | 'core';
}

function helpOf(ext: seal.ExtInfo, cmd: string): string {
    const item = ext.cmdMap?.[cmd];
    return item && item.help ? item.help : '';
}

function isCommand(ext: seal.ExtInfo | null, cmd: string): boolean {
    return !!ext && !!ext.cmdMap && Object.prototype.hasOwnProperty.call(ext.cmdMap, cmd);
}

function kindOf(extName: string): 'builtin' | 'non_builtin' | 'core' {
    if (extName === 'core') return 'core';
    return BUILTIN_EXT_NAMES.indexOf(extName) >= 0 ? 'builtin' : 'non_builtin';
}

export function splitEntry(entry: string): { extName: string; cmd: string } | null {
    const text = String(entry || '').trim();
    if (!text) return null;
    const index = text.indexOf('|');
    if (index < 0) return { extName: '', cmd: text };
    const extName = text.slice(0, index).trim();
    const cmd = text.slice(index + 1).trim();
    return extName && cmd ? { extName, cmd } : null;
}

/** 解析本地扩展 cmdMap；core 是虚拟扩展名，不要求 seal.ext.find('core') 存在。 */
export function resolveEntry(entry: string): ResolvedCommand | null {
    const parsed = splitEntry(entry);
    if (!parsed) return null;
    if (parsed.extName === 'core') return { extName: 'core', cmd: parsed.cmd, help: '', kind: 'core' };
    if (parsed.extName) {
        const ext = seal.ext.find(parsed.extName);
        if (isCommand(ext, parsed.cmd)) {
            return { extName: ext!.name || parsed.extName, cmd: parsed.cmd, help: helpOf(ext!, parsed.cmd), kind: kindOf(ext!.name || parsed.extName) };
        }
        const aliasTarget = getWhitelistAliasMap().get(`${parsed.extName}|${parsed.cmd}`);
        if (aliasTarget) return resolveEntry(aliasTarget);
        return null;
    }
    const sameName = seal.ext.find(parsed.cmd);
    if (isCommand(sameName, parsed.cmd)) {
        const extName = sameName!.name || parsed.cmd;
        return { extName, cmd: parsed.cmd, help: helpOf(sameName!, parsed.cmd), kind: kindOf(extName) };
    }
    for (const extName of BUILTIN_EXT_NAMES) {
        const ext = seal.ext.find(extName);
        if (isCommand(ext, parsed.cmd)) return { extName: ext!.name || extName, cmd: parsed.cmd, help: helpOf(ext!, parsed.cmd), kind: 'builtin' };
    }
    return null;
}

/** 查找某个指令在内置扩展中的所有匹配，用于处理不指定扩展名时的歧义。 */
export function findBuiltinCommands(cmd: string): ResolvedCommand[] {
    const result: ResolvedCommand[] = [];
    for (const extName of BUILTIN_EXT_NAMES) {
        const resolved = resolveEntry(`${extName}|${cmd}`);
        if (resolved) result.push(resolved);
    }
    return result;
}


/** 将同一白名单元素中的 command/alias1/alias2 展开为可解析的独立条目。 */
function expandWhitelistEntry(entry: string): string[] {
    const text = String(entry || '').trim();
    if (!text) return [];
    const index = text.indexOf('|');
    if (index < 0) return [text];
    const extName = text.slice(0, index).trim();
    const commands = text.slice(index + 1).split('/').map(item => item.trim()).filter(Boolean);
    return extName && commands.length ? commands.map(command => `${extName}|${command}`) : [];
}

export function whitelistEntries(): string[] {
    const result: string[] = [];
    Config.tool.CMD_WHITELIST.forEach(item => result.push(...expandWhitelistEntry(String(item || ''))));
    return result;
}

/** 从白名单构建“扩展名|别名 -> 扩展名|主命令名”的映射，避免依赖 cmdMap 是否暴露别名。 */
function getWhitelistAliasMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of Config.tool.CMD_WHITELIST) {
        const text = String(entry || '').trim();
        const index = text.indexOf('|');
        if (index < 0) continue;
        const extName = text.slice(0, index).trim();
        const names = text.slice(index + 1).split('/').map(item => item.trim()).filter(Boolean);
        if (!extName || names.length < 2) continue;
        const canonical = names[0];
        for (const alias of names.slice(1)) {
            map.set(`${extName}|${alias}`, `${extName}|${canonical}`);
        }
    }
    return map;
}


export function isAllowedExtension(rc: ResolvedCommand): boolean {
    if (Config.tool.ALLOW_ALL_CMDS) return true;
    const target = `${rc.extName}|${rc.cmd}`.toLowerCase();
    return whitelistEntries().some(entry => {
        const item = resolveEntry(entry);
        return !!item && item.kind !== 'core' && `${item.extName}|${item.cmd}`.toLowerCase() === target;
    });
}

export function isAllowedCore(command: string): boolean {
    const cmd = String(command || '').trim();
    // .ext 是核心提供的扩展发现入口，不应被白名单挡住。
    if (cmd.toLowerCase() === 'ext' || Config.tool.ALLOW_ALL_CMDS) return true;
    const normalized = cmd.toLowerCase();
    return whitelistEntries().some(entry => {
        const item = splitEntry(entry);
        return !!item && item.extName === 'core' && item.cmd.toLowerCase() === normalized;
    });
}

export function collectCommands(kind: 'builtin' | 'non_builtin' | 'all' = 'all'): ResolvedCommand[] {
    const seen: { [key: string]: boolean } = {};
    const result: ResolvedCommand[] = [];
    const push = (item: ResolvedCommand | null) => {
        if (!item || item.kind === 'core' || (kind !== 'all' && item.kind !== kind)) return;
        const key = `${item.extName}|${item.cmd}`;
        if (seen[key]) return;
        seen[key] = true;
        result.push(item);
    };
    for (const entry of whitelistEntries()) push(resolveEntry(entry));
    const extNames = kind === 'builtin' || kind === 'all' ? BUILTIN_EXT_NAMES : [];
    for (const extName of extNames) {
        const ext = seal.ext.find(extName);
        if (!ext || !ext.cmdMap) continue;
        for (const cmd of Object.keys(ext.cmdMap)) push({ extName: ext.name || extName, cmd, help: helpOf(ext, cmd), kind: 'builtin' });
    }
    // 非内置扩展无法通过公开 SealDice API 全量枚举；白名单条目仍可可靠解析。
    if (kind === 'non_builtin' || kind === 'all') {
        const self = seal.ext.find(NAME);
        if (self && self.cmdMap) for (const cmd of Object.keys(self.cmdMap)) push({ extName: self.name || NAME, cmd, help: helpOf(self, cmd), kind: 'non_builtin' });
    }
    return result;
}

export function extensionNames(): string[] {
    const names: { [name: string]: boolean } = { core: true };
    BUILTIN_EXT_NAMES.forEach(name => { names[name] = true; });
    whitelistEntries().forEach(entry => {
        const parsed = splitEntry(entry);
        if (parsed && parsed.extName) names[parsed.extName] = true;
    });
    const self = seal.ext.find(NAME);
    if (self && self.name) names[self.name] = true;
    return Object.keys(names).sort();
}
