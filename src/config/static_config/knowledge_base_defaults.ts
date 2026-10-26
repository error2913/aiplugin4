// 「知识库」配置的默认内容（每条配置项一个库）：
//  1. Core Commands —— SealDice 核心指令的调用规则与逐条帮助（run_core_command）
//  2. Extension Commands —— SealDice 内置扩展（fun/story/coc7/deck/dnd5e/log）逐扩展、逐命令帮助（run_ext_command）
//  3. ob11-api —— OB11 API 调用规范（frontmatter 限定 platform: [QQ]，仅 QQ 平台可见可检索，见 ob11_api_knowledge.ts）
//
// 注意：运行时已改为 src/config/domain/default_data.ts 里的 JSON 默认值；这里仅作为
// scripts/gen-domain-default-data.mjs 的同步源，改默认知识库后需重跑该脚本。
import { OB11_API_KB } from "./ob11_api_knowledge";

// SealDice 核心指令知识库：原默认技能「SealDice核心指令调用帮助」改写为知识库。
export const CORE_COMMAND_KB = `---
name: Core Commands
description: Call rules and per-command help for SealDice core commands (including team from the core extension); the AI executes them by injecting a fake message through run_core_command, for rolling, character cards, queries and administration
platform: []
---

# Core command call help

This library explains how to invoke SealDice core commands through run_core_command and gives per-command help. Core commands have no public JS entry point and can only be executed by injecting a fake message through run_core_command; for extension commands use run_ext_command (see the "Extension Commands" knowledge base).

## Call rules

- Single entry point: always call every core command (including team from the core extension) through run_core_command, never run_ext_command.
- Structured form: {"action":"call","command":"<command>","args":["arg1","arg2"]}. Do not prefix the command with a dot; the core|<command> form is also accepted.
- Raw-message form: {"action":"call","raw_message":"<raw command>"} injects the whole command verbatim, e.g. ".st <character name> STR=70"; raw_message cannot be combined with command/args.
- Pass args one by one in the space-separated order of the original SealDice command; when an expression, @ or text containing spaces is needed, pass it as a single string.
- To make a command trigger on behalf of another user, pass trigger (user ID string); to simulate an @ in the message, pass at (array of user ID strings). Without trigger the current conversation user is used; private chats do not support at.
- When unsure about a command's arguments, look up its help first: {"action":"call","command":"help","args":["<command>"]}; to list the currently callable core commands use action=list.
- The first line of each section lists the aliases of the same command (separated by /); all of them are whitelisted, so prefer the first main name when calling.
- For state-changing commands such as ban/black, bot, dismiss, master, set, reply and team, check the user's intent first and never pass natural-language descriptions as args directly.

## black / ban

Blacklist and punishment operations. Before sensitive actions such as banning or blocking, confirm the target user ID and arguments and obtain explicit consent.

## find / 查询 / 査詢

Look up extensions, users or related information. Pass arguments as documented by the original command help.

## help

Look up command help. Use it first when unsure about arguments, e.g. {"action":"call","command":"help","args":["roll"]}.

## bot

Enable/disable and inspect the bot. Changes the bot's running state; confirm before executing.

## dismiss

Leave/dissolve related operations. Before executing, confirm the target and impact to avoid mistakes.

## botlist

List the bots.

## master

View or manage dice-master information. For changes involving master permissions, verify the user's identity and intent first.

## roll / r / rd / rh / rhd / rdh / rx / rxh / rhx

Dice expressions; different aliases of the same implementation. Pass the expression text as args, e.g. {"action":"call","command":"roll","args":["1d100"]}; arithmetic expressions such as 2d6+3 are supported.

## ext

Show current extensions. core|ext works without being whitelisted; when unsure about an extension name, run it first and continue.

## nn

View or set the current character name. Pass arguments as documented by the original command help.

## userid

Show the current account, user and group IDs. Use it when IDs are needed for subsequent calls.

## randalgo

Inspect the random algorithm. For example {"action":"call","command":"randalgo","args":["get","100"]}; the set operation is Master-only.

## set

Set dice faces or rules, e.g. args=["coc"] or args=["100"]. Changes the semantics of later rolls; confirm the user's intent before executing.

## 角色 / ch / char / character / pc

View or set the character card. To import a card, create the character with pc new: {"action":"call","command":"pc","args":["new","<character name>"]}; to view existing characters use pc list.

## st / cst

Core character attribute import, view and modification. For card import and similar flows prefer run_core_command with st: {"action":"call","command":"st","args":["show"]} views the current character's attributes; set attributes by passing them one by one as args in core st syntax.

## reply

Enable or disable custom replies, e.g. args=["on"] or args=["off"].

## team

Team management; requires a group chat. For example args=["list"] lists teams and args=["<team name>","add"] adds a member; pass other arguments as documented by the original command help.`;

// SealDice 扩展指令知识库：原默认技能「SealDice xxx扩展调用帮助」改写为知识库。
// 结构：库「Extension Commands」→ 每个扩展一个 # 子条目 → 扩展下每条命令一个 ## 小节（具体帮助）。
export const EXT_COMMAND_KB = `---
name: Extension Commands
description: Call help for SealDice built-in extension commands (fun/story/coc7/deck/dnd5e/log); each extension is a sub-entry with per-command usage; the AI calls them locally through run_ext_command
platform: []
---

# Extension command call help

This library gives call help for SealDice built-in extension commands in two levels, "extension → command": each extension is a # sub-entry, and each command inside an extension is a ## section explaining its usage. Extension commands are executed locally by run_ext_command through the extension's solve inside the plugin, without the core bridge or MCP; for core commands see the "Core Commands" knowledge base (run_core_command).

## General call rules

- Single entry point: call every extension command through run_ext_command: {"action":"call","extension":"<extension>","command":"<command>","args":["arg1","arg2"]}. Do not prefix the command with a dot, and do not write core as the extension.
- command also accepts the <extension>|<command> form (e.g. fun|jrrp); when a command name exists in multiple extensions, extension must be explicit.
- Pass args one by one in the space-separated order of the original SealDice command; when an expression, @ or text containing spaces is needed, pass it as a single string.
- To make a command trigger on behalf of another user, pass trigger (user ID string); to simulate an @ in the message, pass at (array of user ID strings). Without trigger the current conversation user is used; private chats do not support at.
- Extension commands are bounded by the "callable command whitelist" (format: extension|command/alias); to list currently callable extension commands use action=list, optionally filtering with kind (builtin / non_builtin / all). Commands that are not whitelisted or do not exist return an error; never invent commands.
- The first line of each section lists the aliases of the same command (separated by /); prefer the first main name when calling, and take arguments from the corresponding section.
- The default whitelist covers the six built-in extensions fun, story, coc7, deck, dnd5e and log, described one by one below; SealDice also has other built-in extensions such as exp and reply plus third-party extensions, so what is callable depends on action=list and the whitelist.

# fun extension

extension is always "fun" when calling. This extension provides entertainment, shortcut commands, dice pools and other common features.

## alias — Shortcut command management

Create, delete or view shortcut commands. Pass args in the order of the original SealDice .alias command.

## & / a — Run a shortcut command

Run an existing shortcut command. args=["<shortcut name>","args..."]; the first argument is the shortcut name and the rest are passed in that shortcut's argument order.

## ping — Test reply

Trigger a reply, usually args=[].

## send — Leave a message for the dice master

args=["<message>"]. The content is visible to the dice master; be careful with private information.

## welcome — Group welcome

View or set group-welcome related content. Pass arguments as documented by the original command help.

## gugu / 咕咕 — Generate a "gugu" excuse

Generate a "gugu" (flaking/slacking) excuse. args may carry a source or trigger word.

## jrrp — Today's luck

Query today's luck. args may carry a user name or QQ number (the queried target); without arguments it queries the current user.

## text — Text / SealDice script

Text, SealDice script (Baoyu) and related features. Pass arguments as documented by the original command help.

## rsr — Shadowrun roll

args=["<dice count or expression>"].

## ek / ekgen — Special rule generation

Special rule or generation related features. Pass arguments as documented by the original command help.

## dx — Roll dice

Dice command, e.g. {"action":"call","extension":"fun","command":"dx","args":["3c4"]}.

## w / ww / dxh / wh / wwh — Roll / hidden roll

Roll or hidden-roll commands of the same kind; prefer the main names w or ww. Pass arguments as documented by the original command help.

## jsr — Roll without duplicates

Roll without duplicate results. For example args=["3#","10"] (several rolls that produce distinct results; exact semantics follow the original command).

## drl / drlh — Dice pool draw / management

Dice pool draw or management. For example drl without arguments views the current dice pool; pass arguments for sub-operations such as drl new as documented by the original command help.

## check — Check

Check related commands. Pass arguments as documented by the original command help.

# story extension

extension is always "story" when calling. This extension provides random names, character combinations and COC module related commands.

## name — Random name

args=["cn", "en" or "jp", "<count>", "<gender>"], passed in the original command order.

## namednd — DND race name

Generate a DND race name. args may carry a race, e.g. ["精灵"].

## who — Random person/identity

Random person/identity combinations. Pass arguments as documented by the original command help, e.g. ["a","b","c"].

## cnmods / modu / 魔都 — COC modules

COC module features. modu args=["roll"] randomly draws a module; args=["search","<keyword>"] searches by keyword.

# coc7 extension

extension is always "coc7" when calling. This extension provides COC7 character attributes, checks and madness symptom commands.

## en — COC rule/character setup

COC rule/character related setup. Pass arguments as documented by the original command help.

## setcoc — Set COC rules

Set COC rules. Pass arguments as documented by the original command help.

## ti — Temporary insanity

Draw a temporary insanity symptom, args=[].

## li — Long-term insanity

Draw a long-term insanity symptom, args=[].

## ra / rc / rch / rah / cra / crc / crch / crah — Ability/skill checks

Ability or skill checks; different aliases of the same implementation. Pass bonus/penalty dice, the check expression and the reason in order as args.

## rav / rcv — Opposed/competitive checks

Opposed/competitive checks. Pass arguments as documented by the original command help; to trigger on behalf of another user or @ a target, additionally pass trigger / at.

## sc — San check

San check. Pass bonus/penalty dice and the success/failure loss expressions in order as args, e.g. ["0/1d6"].

## coc — Generate a COC character card

Generate a COC character card. args may carry a count, e.g. ["3"].

## st / cst — COC attribute view/modification

Alias for viewing/modifying COC extension character attributes. Common args=["show","<character name or user ID>"]; the character name is an argument of the character-card command itself, so use only user IDs when targeting users. For whole-card import and similar flows prefer core run_core_command st (see the "Core Commands" knowledge base).

# deck extension

extension is always "deck" when calling. This extension provides deck draw commands.

## draw / deck — Deck draw

Draw content from a configured deck. args are usually ["<deck name>"]; to specify a draw count or other options, continue passing them in the original command order. Only use decks that are configured and allowed for the AI; never guess deck names that do not exist.

# dnd5e extension

extension is always "dnd5e" when calling. This extension provides DND5E character, initiative, check, spell-slot and combat commands.

## dnd / dndx — DND rule/character setup

DND rule or character related setup. Pass arguments as documented by the original command help.

## ri — Initiative/encounter

Initiative/encounter related operations. Pass arguments as documented by the original command help.

## init — View the initiative list

View the initiative list, args=[].

## st / dst — View character attributes

View DND character attributes. Pass arguments as documented by the original command help.

## rc / ra / rah / rch / drc — DND checks

DND checks. Pass the check expression, difficulty or reason in order as args; pick an alias by habit.

## buff / dbuff — Buff/debuff

Buff/debuff effects. Pass arguments as documented by the original command help.

## spellslots / ss / dss / 法术位 — Spell slots

View or manage spell slots. Pass arguments as documented by the original command help.

## cast / dcast — Cast a spell

Cast a spell. Pass arguments as documented by the original command help; to trigger on behalf of another user or @ a target, additionally pass trigger / at.

## 长休 / longrest / dlongrest — Long rest

Take a long rest. Pass arguments as documented by the original command help.

## ds / 死亡豁免 — Death saving throw

Death saving throw. Pass arguments as documented by the original command help; to trigger on behalf of another user or @ a target, additionally pass trigger / at.

# log extension

extension is always "log" when calling. This extension provides log, statistics and log-export commands. Log commands may read or export group history; confirm the scope before calling to avoid exposing privacy unnecessarily.

## log — Log recording/management

View, record or manage logs. Pass arguments as documented by the original command help.

## stat / hiy — Log statistics

View log statistics. Pass arguments as documented by the original command help.

## ob — Log export

Export or view log content; limit the scope when a large output is involved.

## sn — Log name/story operations

Log-related name/story operations. Pass arguments as documented by the original command help.`;

/** 「知识库」配置默认条目（顺序即默认注入顺序） */
export const KNOWLEDGE_BASE_DEFAULTS: string[] = [CORE_COMMAND_KB, EXT_COMMAND_KB, OB11_API_KB];
