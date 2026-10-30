// 指令别名表（叶子模块）：按**用途域**分组，避免不同命令的同名字母互相污染。
//
// 背景（作者修正）：旧实现只有一张扁平 `ALIAS_MAP`，`p` 同时被「memory private」占用，
// 导致触发域概率模式只能用双字母 `pb`。现拆成三张用途明确的表：
// - `COMMAND_ALIASES`：根命令/子命令名（`.ai priv/memo/md/...`）
// - `VERB_ALIASES`：命令参数里的通用动词（`lst/rm/clr/del/st/...`），仅作用于参数位
// - `TRIGGER_MODE_ALIASES`：触发域模式别名（`.ai trg <模式>` 的模式位），与其他用途隔离
//
// 解析规则（`resolveCmdChain`）：
// 1. 第 0 段按命令表归一；
// 2. 命令是 `trg` 时，第 1 段按触发模式表归一（`p` → `prob`）；其余命令的第 1 段按动词表；
// 3. 更深的段一律按动词表归一（`rule lst` → `rule list`）。
// 这样 `p` 在 `.ai trg p` 是 probability、在 `.ai memo p` 仍是旧的 private 语义，互不影响。

/** 根命令 / 子命令名别名 */
export const COMMAND_ALIASES: { [alias: string]: string } = {
    'AI': 'ai',
    priv: 'privilege',
    ses: 'session',
    memo: 'memory',
    img: 'image',
    md: 'media',
    mda: 'media',
    tk: 'token',
    ass: 'assistant',
};

/** 命令参数动词别名（第二段起的通用动词） */
export const VERB_ALIASES: { [alias: string]: string } = {
    st: 'set',
    ck: 'check',
    clr: 'clear',
    fgt: 'forget',
    f: 'forget',
    del: 'delete',
    ign: 'ignore',
    rm: 'remove',
    lst: 'list',
    y: 'year',
    m: 'month',
    lcl: 'local',
    ran: 'random',
    nick: 'nickname',
    g: 'group',
    p: 'private',
};

/** 触发域模式别名：单字母风格，仅在 `.ai trg <模式>` 的模式位生效（与全局动词表隔离） */
export const TRIGGER_MODE_ALIASES: { [alias: string]: string } = {
    a: 'active',
    c: 'counter',
    d: 'delay',
    e: 'event',
    j: 'judge',
    p: 'prob',
    r: 'regex',
    t: 'timer',
};

export type AliasScope = 'command' | 'verb' | 'trigger-mode';

/** 在指定用途域内解析单个别名；无别名返回原值 */
export function applyAlias(value: string, scope: AliasScope): string {
    const table = scope === 'command' ? COMMAND_ALIASES : scope === 'trigger-mode' ? TRIGGER_MODE_ALIASES : VERB_ALIASES;
    return table[value] ?? value;
}

/** 命令名兼容解析（根命令/子命令位）：先查命令表，再兼容动词表；用于 root_cmd 的单个参数解析 */
export function aliasToCmd(val: string): string {
    return COMMAND_ALIASES[val] ?? VERB_ALIASES[val] ?? val;
}

/**
 * 整条命令链按用途域归一（权限校验用）：
 * `['trg','p','on'] → ['trg','prob','on']`；`['memo','mm','lst'] → ['memory','mm','list']`。
 */
export function resolveCmdChain(parts: readonly string[]): string[] {
    if (parts.length === 0) return [];
    const head = aliasToCmd(String(parts[0]));
    const out: string[] = [head];
    for (let i = 1; i < parts.length; i++) {
        const scope: AliasScope = head === 'trg' && i === 1 ? 'trigger-mode' : 'verb';
        out.push(applyAlias(String(parts[i]), scope));
    }
    return out;
}
