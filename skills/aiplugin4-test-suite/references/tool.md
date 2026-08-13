# 工具用例（tool）

权限：U=任意成员；I=邀请者/管理/群主/白名单/骰主；M=骰主。

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| TOOL-01 | `.ai tool` | U | `工具函数如下` | 快照命令，记录各工具开关 |
| TOOL-02 | `.ai tool help set_timer` | U | `set_timer`、`必需参数` | |
| TOOL-03 | `.ai tool help 不存在的工具` | U | `没有这个工具函数` | 错误路径 |
| TOOL-04 | `.ai tool on` | I | `已开启全部工具函数` | |
| TOOL-05 | `.ai tool off` | I | `已关闭全部工具函数` | |
| TOOL-06 | `.ai tool on show_timer_list` | I | `已开启工具函数 show_timer_list` | |
| TOOL-07 | `.ai tool off show_timer_list` | I | `已关闭工具函数 show_timer_list` | |
| TOOL-08 | `.ai tool call show_timer_list` | M | `返回内容`、`定时器` | 需骰主；无副作用（无定时器时返回「当前对话没有定时器」） |
| TOOL-09 | `.ai tool call 不存在的函数` | M | `调用函数失败:未注册的函数` | 错误路径 |
| TOOL-10 | `.ai tool on <禁止调用的函数>` | I | `不被允许开启` | 仅当知道"禁止调用的函数"配置项内容时测，否则 SKIP(env) |

说明：

- `tool call` 有调用副作用（如 `ban`/`whole_ban`/`record`/`text_to_sound`），只测无副作用的 `show_timer_list` 与未注册函数错误路径。
- `tool call` 依赖 `Tool.cmdArgs`（`ExtCmdInfo.extName !== ''` 且 `Tool.cmdArgs == null` 时会要求先使用 `.r` 指令），遇此提示记 SKIP(env)。
- TOOL-04~07 结束后按 TOOL-01 快照逐工具还原（`on`/`off <工具名>`）。
