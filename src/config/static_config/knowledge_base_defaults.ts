// 「知识库」配置的默认内容（每条配置项一个库）：
//  1. 核心指令 —— SealDice 核心指令的调用规则与逐条帮助（run_core_command）
//  2. 扩展指令 —— SealDice 内置扩展（fun/story/coc7/deck/dnd5e/log）逐扩展、逐命令帮助（run_ext_command）
//  3. ob11-api —— OB11 API 调用规范（frontmatter 限定 platform: [QQ]，仅 QQ 平台可见可检索，见 ob11_api_knowledge.ts）
import { OB11_API_KB } from "./ob11_api_knowledge";

// SealDice 核心指令知识库：原默认技能「SealDice核心指令调用帮助」改写为知识库。
export const CORE_COMMAND_KB = `---
name: 核心指令
description: SealDice 核心指令（含 core 扩展中的 team）的调用规则与逐条具体帮助；AI 用 run_core_command 注入假消息执行，用于掷骰、角色卡、查询与管理
platform: []
---

# 核心指令调用帮助

本库说明如何用 run_core_command 调用 SealDice 的核心指令，并逐条给出每条核心命令的具体帮助。核心指令没有公开的 JS 调用入口，只能通过 run_core_command 注入假消息执行；扩展指令请用 run_ext_command（见「扩展指令」知识库）。

## 调用规则

- 入口唯一：所有核心指令（包括 core 扩展中的 team）一律通过 run_core_command 调用，不要使用 run_ext_command。
- 结构化模式：{"action":"call","command":"指令名","args":["参数1","参数2"]}。command 不要带前缀点号，也支持 core|指令名 写法。
- 原始消息模式：{"action":"call","raw_message":"原始指令原文"}，把整条指令原样注入核心，例如 ".st 角色名 力量=70"；raw_message 与 command/args 不能同时传。
- args 按 SealDice 原始指令的空格分隔顺序逐项传入；需要表达式、@ 或带空格的文本时，作为单独一个字符串传入。
- 需要让指令替其他用户触发时传 trigger（字符串用户 ID），需要模拟消息中的 @ 时传 at（字符串用户 ID 数组）；不传 trigger 时使用当前对话用户；私聊不支持 at。
- 不确定某条指令的参数时，先查帮助：{"action":"call","command":"help","args":["指令名"]}；查看当前可调用的核心指令列表用 action=list。
- 每个小节第一行是同一条指令的别名（用 / 分隔），均已加入白名单，调用时优先使用第一个主名称。
- 涉及 ban/black、bot、dismiss、master、set、reply、team 等会改变状态的命令，先核对用户意图，不要把自然语言说明直接当作 args。

## black / ban

黑名单与处罚操作。涉及封禁、拉黑等敏感动作前，先确认目标用户 ID 与参数，得到明确同意后再执行。

## find / 查询 / 査詢

查找扩展、用户或相关信息。参数按原命令帮助传入。

## help

查询命令帮助。参数不确定时先用它确认，例如 {"action":"call","command":"help","args":["roll"]}。

## bot

机器人的开关与状态操作。会改变机器人运行状态，执行前确认。

## dismiss

退群/解散相关操作。执行前确认目标与影响，避免误操作。

## botlist

查看机器人列表。

## master

查看或管理骰主信息。涉及骰主权限的修改先确认用户身份与意图。

## roll / r / rd / rh / rhd / rdh / rx / rxh / rhx

骰点表达式，同一实现的不同别名。args 传表达式原文即可，例如 {"action":"call","command":"roll","args":["1d100"]}，支持 2d6+3 这类带运算的表达式。

## ext

查看当前扩展。core|ext 无需加入白名单也可用；不确定扩展名时先执行它再继续。

## nn

查看或设置当前角色名。参数按原命令帮助传入。

## userid

查看当前账号、用户和群组 ID。需要取得后续调用所需的 ID 时使用。

## randalgo

查看随机算法。例如 {"action":"call","command":"randalgo","args":["get","100"]}；set 操作仅限 Master。

## set

设置骰子面数或规则，例如 args=["coc"] 或 args=["100"]。会改变后续骰点语义，执行前确认用户意图。

## 角色 / ch / char / character / pc

查看或设置角色卡。录卡时用 pc new 新建角色：{"action":"call","command":"pc","args":["new","角色名"]}；查看已有角色用 pc list。

## st / cst

核心角色属性导入、查看和修改。录卡等导入流程优先用 run_core_command 执行 st：{"action":"call","command":"st","args":["show"]} 查看当前角色属性；写入属性按核心 st 语法逐项传 args。

## reply

开启或关闭自定义回复，例如 args=["on"] 或 args=["off"]。

## team

团队管理，需要群聊环境。例如 args=["list"] 查看团队、args=["团队名","add"] 添加成员，其余参数按原命令帮助传入。`;

// SealDice 扩展指令知识库：原默认技能「SealDice xxx扩展调用帮助」改写为知识库。
// 结构：库「扩展指令」→ 每个扩展一个 # 子条目 → 扩展下每条命令一个 ## 小节（具体帮助）。
export const EXT_COMMAND_KB = `---
name: 扩展指令
description: SealDice 内置扩展（fun/story/coc7/deck/dnd5e/log）指令的调用帮助：每个扩展一个子条目，扩展下逐条列出各命令的具体用法；AI 用 run_ext_command 本地调用
platform: []
---

# 扩展指令调用帮助

本库按「扩展 → 命令」两级给出 SealDice 内置扩展指令的调用帮助：每个扩展用 # 作为一个子条目，扩展内每条命令用 ## 小节说明具体用法。扩展指令由 run_ext_command 在插件内本地执行扩展的 solve，不依赖核心桥与 MCP；核心指令请见「核心指令」知识库（run_core_command）。

## 通用调用规则

- 入口唯一：所有扩展指令用 run_ext_command 调用：{"action":"call","extension":"扩展名","command":"指令名","args":["参数1","参数2"]}。command 不要带前缀点号，extension 也不要写 core。
- command 也支持直接写 扩展名|指令名（如 fun|jrrp）；当指令在多个扩展中重名时，必须写清楚 extension。
- args 按 SealDice 原始指令的空格分隔顺序逐项传入；需要表达式、@ 或带空格的文本时，作为单独一个字符串传入。
- 需要让指令替其他用户触发时传 trigger（字符串用户 ID），需要模拟消息中的 @ 时传 at（字符串用户 ID 数组）；不传 trigger 时使用当前对话用户；私聊不支持 at。
- 扩展指令受「可调用指令白名单」约束（白名单格式：扩展名|指令名/别名）；查看当前可调用扩展指令用 action=list，可加 kind 过滤（builtin / non_builtin / all）。不在白名单或不存在的指令会返回错误，不要臆造命令。
- 每个小节第一行是同一条命令的别名（用 / 分隔），调用时优先使用第一个主名称；命令参数以对应小节说明为准。
- 默认白名单覆盖 fun、story、coc7、deck、dnd5e、log 六个内置扩展，下方逐一说明；SealDice 还有 exp、reply 等其它内置扩展及第三方扩展，能否调用以 action=list 与白名单为准。

# fun 扩展

调用时 extension 固定为 "fun"。该扩展提供娱乐、快捷指令、骰池等常用功能。

## alias —— 快捷指令管理

创建、删除或查看快捷指令。args 按 SealDice .alias 原始命令的顺序逐项传入。

## & / a —— 执行快捷指令

执行已有快捷指令。args=["快捷指令名","参数..."]，第一个参数是快捷指令名，其余按该快捷指令的参数顺序传入。

## ping —— 测试回复

触发一条回复，通常 args=[]。

## send —— 给骰主留言

args=["留言内容"]。内容会被骰主看到，涉及私密信息时谨慎使用。

## welcome —— 入群欢迎

查看或设置入群欢迎相关内容，参数按原命令帮助传入。

## gugu / 咕咕 —— 生成咕咕理由

生成咕咕（放鸽子/摸鱼）理由。args 可传来源或触发词。

## jrrp —— 今日人品

查询今日人品。args 可传用户名或 QQ 号（查询对象），不带参数时查询当前用户。

## text —— 文本/豹语

文本、豹语等相关功能，参数按原命令帮助传入。

## rsr —— 暗影狂奔骰点

args=["骰数或表达式"]。

## ek / ekgen —— 特殊规则生成

特殊规则或生成相关功能，参数按原命令帮助传入。

## dx —— 掷骰

掷骰命令，例如 {"action":"call","extension":"fun","command":"dx","args":["3c4"]}。

## w / ww / dxh / wh / wwh —— 掷骰/暗骰

同一类掷骰/暗骰命令，优先使用主名称 w 或 ww；参数按原命令帮助传入。

## jsr —— 不重复投掷

不重复投掷。例如 args=["3#","10"]（多次投掷得到不重复结果，具体语义以原命令为准）。

## drl / drlh —— 骰池抽取/管理

骰池抽取或管理。例如 drl 无参查看当前骰池；drl new 等子操作的参数按原命令帮助传入。

## check —— 校验

校验相关命令，参数按原命令帮助传入。

# story 扩展

调用时 extension 固定为 "story"。该扩展提供随机姓名、人物组合与 COC 模组相关命令。

## name —— 随机姓名

args=["cn"、"en" 或 "jp", "数量", "性别"]，按原命令顺序传参。

## namednd —— DND 种族姓名

生成 DND 种族姓名。args 可传种族，例如 ["精灵"]。

## who —— 随机人物/身份

随机人物/身份组合。args 按原命令帮助传入，例如 ["a","b","c"]。

## cnmods / modu / 魔都 —— COC 模组

COC 模组功能。modu args=["roll"] 随机抽取模组；args=["search","关键词"] 按关键词搜索。

# coc7 扩展

调用时 extension 固定为 "coc7"。该扩展提供 COC7 规则的角色属性、检定与疯狂症状命令。

## en —— COC 规则/角色设置

COC 规则/角色相关设置，参数按原命令帮助传入。

## setcoc —— 设置 COC 规则

设置 COC 规则，参数按原命令帮助传入。

## ti —— 临时性疯狂

抽取临时性疯狂症状，args=[]。

## li —— 总结性疯狂

抽取总结性疯狂症状，args=[]。

## ra / rc / rch / rah / cra / crc / crch / crah —— 属性/技能检定

属性或技能检定，同一实现的不同别名。args 按顺序传奖励/惩罚骰、检定表达式、原因。

## rav / rcv —— 对抗/竞争检定

对抗/竞争检定。args 按原命令帮助传入；需要替其他用户触发或 @ 对象时，额外传 trigger / at。

## sc —— San 检定

San 检定。args 按顺序传奖励/惩罚骰、成功/失败损失表达式，例如 ["0/1d6"]。

## coc —— 生成 COC 角色卡

生成 COC 角色卡。args 可传数量，例如 ["3"]。

## st / cst —— COC 属性查看/修改

COC 扩展的角色属性查看/修改别名。常用 args=["show","角色名或用户ID"]；角色名是角色卡命令自身的参数，涉及用户定位时只使用用户 ID。整卡导入等录卡流程优先使用核心 run_core_command 的 st（见「核心指令」知识库）。

# deck 扩展

调用时 extension 固定为 "deck"。该扩展提供牌堆抽取命令。

## draw / deck —— 牌堆抽取

从已配置牌堆抽取内容。args 通常为 ["牌堆名称"]，需要指定抽取次数或其他选项时按原命令顺序继续传入。只调用已配置且允许提供给 AI 的牌堆，不要猜测不存在的牌堆名称。

# dnd5e 扩展

调用时 extension 固定为 "dnd5e"。该扩展提供 DND5E 规则的角色、先攻、检定、法术位与战斗命令。

## dnd / dndx —— DND 规则/角色设置

DND 规则或角色相关设置，参数按原命令帮助传入。

## ri —— 先攻/遭遇

先攻/遭遇相关操作，参数按原命令帮助传入。

## init —— 查看先攻列表

查看先攻列表，args=[]。

## st / dst —— 查看角色属性

查看 DND 角色属性，参数按原命令帮助传入。

## rc / ra / rah / rch / drc —— DND 检定

DND 检定。args 按顺序传检定表达式、难度或原因；别名可按习惯选择。

## buff / dbuff —— 增益/减益

增益/减益效果，参数按原命令帮助传入。

## spellslots / ss / dss / 法术位 —— 法术位

查看或管理法术位，参数按原命令帮助传入。

## cast / dcast —— 施法

施法。args 按原命令帮助传入；需要替其他用户触发或 @ 对象时，额外传 trigger / at。

## 长休 / longrest / dlongrest —— 长休

执行长休，参数按原命令帮助传入。

## ds / 死亡豁免 —— 死亡豁免

死亡豁免检定。args 按原命令帮助传入；需要替其他用户触发或 @ 对象时，额外传 trigger / at。

# log 扩展

调用时 extension 固定为 "log"。该扩展提供日志、统计与日志导出命令。日志命令可能读取或导出群聊历史，调用前确认范围，避免无必要地暴露隐私。

## log —— 日志记录/管理

查看、记录或管理日志，参数按原命令帮助传入。

## stat / hiy —— 日志统计

查看日志统计，参数按原命令帮助传入。

## ob —— 日志导出

导出或查看日志内容；涉及大量输出时限制范围。

## sn —— 日志名称/故事操作

日志相关的名称/故事操作，参数按原命令帮助传入。`;

/** 「知识库」配置默认条目（顺序即默认注入顺序） */
export const KNOWLEDGE_BASE_DEFAULTS: string[] = [CORE_COMMAND_KB, EXT_COMMAND_KB, OB11_API_KB];
