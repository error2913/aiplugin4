// SealDice 当前源码（sealdice-core，2026-08-18）内置扩展与核心命令的默认可调用清单。
// 命令别名也保留，确保 AI 传入任意 SealDice 可解析名称时都能通过白名单校验。
export const SEALDICE_COMMAND_WHITELIST = [
    // 核心命令（同一扩展元素内用 / 分隔别名，含 core 扩展中的 team）
    'core|black/ban', 'core|find/查询/査詢', 'core|help',
    'core|bot', 'core|dismiss', 'core|botlist', 'core|master',
    'core|roll/r/rd/rh/rhd/rdh/rx/rxh/rhx',
    'core|ext', 'core|nn', 'core|userid', 'core|randalgo', 'core|set',
    'core|角色/ch/char/character/pc', 'core|reply', 'core|team',

    // fun
    'fun|alias', 'fun|&/a', 'fun|ping', 'fun|send', 'fun|welcome', 'fun|gugu/咕咕',
    'fun|jrrp', 'fun|text', 'fun|rsr', 'fun|ek/ekgen', 'fun|dx',
    'fun|w/ww/dxh/wh/wwh', 'fun|jsr', 'fun|drl/drlh', 'fun|check',

    // story
    'story|name', 'story|namednd', 'story|who', 'story|cnmods/modu/魔都',

    // coc7
    'coc7|en', 'coc7|setcoc', 'coc7|ti', 'coc7|li',
    'coc7|ra/rc/rch/rah/cra/crc/crch/crah', 'coc7|rav/rcv', 'coc7|sc',
    'coc7|coc', 'coc7|st/cst',

    // deck
    'deck|draw/deck',

    // dnd5e
    'dnd5e|dnd/dndx', 'dnd5e|ri', 'dnd5e|init', 'dnd5e|st/dst',
    'dnd5e|rc/ra/rah/rch/drc', 'dnd5e|buff/dbuff',
    'dnd5e|spellslots/ss/dss/法术位', 'dnd5e|cast/dcast',
    'dnd5e|长休/longrest/dlongrest', 'dnd5e|ds/死亡豁免',

    // log
    'log|log', 'log|stat/hiy', 'log|ob', 'log|sn'
];

const COMMAND_CALL_RULES = `
调用规则：
- 扩展指令使用 run_ext_command，参数格式：{"action":"call","extension":"扩展名","command":"指令名","args":["参数1","参数2"]}；不要在 command 中带前缀点号。
- 核心指令（包括 core|team）使用 run_core_command，参数格式：{"command":"指令名","args":["参数1","参数2"]}。
- args 按 SealDice 原始指令的空格分隔顺序逐项传入；需要 @、表达式或带空格的文本时按工具 schema 传入单独字符串。
- 下方同一行中的名称是同一条指令的别名，均已加入白名单；优先使用第一个主名称。
- 参数不确定时，先调用对应的 help：核心用 run_core_command(command="help", args=["指令名"]，扩展可调用扩展的 help 参数或先查看 SealDice 指令帮助。
`;

export const SEALDICE_COMMAND_SKILLS = [
    `---
name: 今日人品
description: 查询指定用户的今日人品值
---
使用 run_ext_command 工具执行：{"action":"call","extension":"fun","command":"jrrp","args":["用户名或QQ号"]}；fun|jrrp 已加入默认白名单。`,

    `---
name: COC模组抽取
description: 随机抽取一个 COC 模组
---
使用 run_ext_command 工具执行：{"action":"call","extension":"story","command":"modu","args":["roll"]}；story|modu 已加入默认白名单。`,

    `---
name: COC模组搜索
description: 按关键词搜索 COC 模组
---
使用 run_ext_command 工具执行：{"action":"call","extension":"story","command":"modu","args":["search","关键词"]}；story|modu 已加入默认白名单。`,

    `---
name: 属性展示
description: 展示指定玩家的 COC 全部个人属性
---
使用 run_ext_command 工具执行：{"action":"call","extension":"coc7","command":"st","args":["show","玩家名称或QQ号"]}；coc7|st 已加入默认白名单。`,

    `---
name: 属性检定
description: 对指定玩家进行一次属性或技能检定（ra）
---
使用 run_ext_command 工具执行：{"action":"call","extension":"coc7","command":"ra","args":["奖励/惩罚骰（可选，如 b、p3）","检定表达式或属性名","检定原因（可选）"]}；coc7|ra 已加入默认白名单。args 按 SealDice 原始指令顺序传入；普通属性名若属性值为 0，按原扩展规则补 50。`,

    `---
name: san检定
description: 对指定玩家进行 San check（sc）
---
使用 run_ext_command 工具执行：{"action":"call","extension":"coc7","command":"sc","args":["奖励/惩罚骰（可选，如 b、p2）","成功损失/失败损失表达式（如 0/1d6、0/1）"]}；coc7|sc 已加入默认白名单。`,

    `---
name: SealDice核心指令调用帮助
description: 调用 SealDice 核心命令与 core 扩展命令，包含命令别名、参数传递方式和安全提示
---
${COMMAND_CALL_RULES}
核心命令清单（主名称 / 别名）：
- black / ban：黑名单与处罚操作，涉及封禁、拉黑等敏感动作前确认目标和参数。
- find / 查询 / 査詢：查找扩展、用户或相关信息。
- help：查询命令帮助，例如 command="help"、args=["roll"]。
- bot：机器人开关与状态操作。
- dismiss：退群/解散相关操作，执行前确认。
- botlist：查看机器人列表。
- master：查看或管理骰主信息。
- roll / r / rd / rh / rhd / rdh / rx / rxh / rhx：骰点表达式，例如 command="roll"、args=["1d100"]。
- ext：查看当前扩展；core|ext 无需加入白名单也可用，但默认仍列出。
- nn：查看或设置当前角色名。
- userid：查看当前帐号、用户和群组 ID。
- randalgo：查看随机算法，或 args=["get","100"]；set 仅限 Master。
- set：设置骰子面数或规则，例如 args=["coc"]、args=["100"]。
- 角色 / ch / char / character / pc：查看或设置角色卡。
- reply：开启或关闭自定义回复，例如 args=["on"] 或 args=["off"]。
- team：团队管理，例如 args=["list"] 或 args=["团队名","add"]；需要群聊环境。

安全：涉及 ban/black、bot、dismiss、master、set、reply、team 等会改变状态的命令，先核对用户意图；不要把自然语言说明当作 args。`,

    `---
name: SealDice fun扩展调用帮助
description: 调用 fun 内置扩展的娱乐、快捷指令、骰池和功能命令
---
${COMMAND_CALL_RULES}
调用时 extension 固定为 "fun"。
- alias：创建、删除或查看快捷指令；args 按 SealDice .alias 的原始顺序传入。
- & / a：执行已有快捷指令；args=["快捷指令名", "参数..."]。
- ping：触发一条回复；通常 args=[]。
- send：向骰主留言；args=["留言内容"]，涉及私密信息时谨慎使用。
- welcome：查看或设置入群欢迎相关内容；参数按原命令帮助传入。
- gugu / 咕咕：生成咕咕理由；args 可传来源。
- jrrp：查询今日人品；args 可传用户名或 QQ 号。
- text：文本/豹语相关功能；参数按原命令帮助传入。
- rsr：暗影狂奔骰点；args=["骰数或表达式"]。
- ek / ekgen：特殊规则或生成相关功能；参数按原命令帮助传入。
- dx：掷骰，例如 args=["3c4"]。
- w / ww / dxh / wh / wwh：同一类掷骰/暗骰命令，优先使用主名称 w 或 ww，参数按原命令帮助传入。
- jsr：不重复投掷，例如 args=["3#","10"]。
- drl / drlh：骰池抽取或管理；例如 drl args=[]，drl new 的参数按原命令帮助传入。
- check：校验相关命令，参数按原命令帮助传入。`,

    `---
name: SealDice story扩展调用帮助
description: 调用 story 内置扩展的随机姓名、人物和 COC 模组命令
---
${COMMAND_CALL_RULES}
调用时 extension 固定为 "story"。
- name：随机姓名；args=["cn"、"en" 或 "jp", "数量", "性别"]。
- namednd：生成 DND 种族姓名；args 可传种族，例如 ["精灵"]。
- who：随机人物/身份组合；args 按原命令帮助传入，例如 ["a","b","c"]。
- cnmods / modu / 魔都：COC 模组功能；modu args=["roll"] 随机抽取，args=["search","关键词"] 按关键词搜索。`,

    `---
name: SealDice coc7扩展调用帮助
description: 调用 COC7 内置扩展的角色卡、属性、检定和疯狂症状命令
---
${COMMAND_CALL_RULES}
调用时 extension 固定为 "coc7"。
- en：COC 规则/角色相关设置；参数按原命令帮助传入。
- setcoc：设置 COC 规则；参数按原命令帮助传入。
- ti：抽取临时性疯狂症状；args=[]。
- li：抽取总结性疯狂症状；args=[]。
- ra / rc / rch / rah / cra / crc / crch / crah：属性或技能检定，同一实现的不同别名；args 按顺序传奖励/惩罚骰、检定表达式、原因。
- rav / rcv：对抗/竞争检定；args 按原命令帮助传入。
- sc：San 检定；args 按顺序传奖励/惩罚骰、成功/失败损失表达式，例如 ["0/1d6"]。
- coc：生成 COC 角色卡；args 可传数量，例如 ["3"]。
- st / cst：查看或管理 COC 角色属性；常用 args=["show","玩家名称或QQ号"]。`,

    `---
name: SealDice deck扩展调用帮助
description: 调用 SealDice 牌堆抽取命令
---
${COMMAND_CALL_RULES}
调用时 extension 固定为 "deck"。
- draw / deck：从已配置牌堆抽取内容；args 通常为["牌堆名称"]，需要指定抽取次数或其他选项时继续按原命令顺序传入。
- 仅调用已配置且允许提供给 AI 的牌堆；不要猜测不存在的牌堆名称。`,

    `---
name: SealDice dnd5e扩展调用帮助
description: 调用 DND5E 内置扩展的角色、先攻、检定、法术位和战斗命令
---
${COMMAND_CALL_RULES}
调用时 extension 固定为 "dnd5e"。
- dnd / dndx：DND 规则或角色相关设置。
- ri：先攻/遭遇相关操作；参数按原命令帮助传入。
- init：查看先攻列表；args=[]。
- st / dst：查看角色属性。
- rc / ra / rah / rch / drc：DND 检定；args 按顺序传检定表达式、难度或原因，别名可按习惯选择。
- buff / dbuff：增益/减益效果；参数按原命令帮助传入。
- spellslots / ss / dss / 法术位：查看或管理法术位。
- cast / dcast：施法；args 按原命令帮助传入。
- 长休 / longrest / dlongrest：执行长休。
- ds / 死亡豁免：死亡豁免检定；args 按原命令帮助传入。`,

    `---
name: SealDice log扩展调用帮助
description: 调用 SealDice 日志、统计和日志导出命令
---
${COMMAND_CALL_RULES}
调用时 extension 固定为 "log"。
- log：查看、记录或管理日志；参数按原命令帮助传入。
- stat / hiy：查看日志统计。
- ob：导出或查看日志内容；涉及大量输出时限制范围。
- sn：日志相关的名称/故事操作；参数按原命令帮助传入。

日志命令可能读取或导出群聊历史，调用前确认范围，避免无必要地暴露隐私。`
];


