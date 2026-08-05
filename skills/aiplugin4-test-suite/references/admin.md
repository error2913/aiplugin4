# 管理用例（privilege/prompt/token/timer）

权限：U=任意成员；I=邀请者/管理/群主/白名单/骰主；M=骰主；S=骰主（会话权限≥1 时为邀请者）。

## privilege（全部需骰主）

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| ADM-01 | `.ai priv` | M | `帮助` | |
| ADM-02 | `.ai priv show ai-status` | M | `指令ai-status权限限制:0-0-0` | 默认值 |
| ADM-03 | `.ai priv show ai-不存在的指令` | M | `不存在` | 错误路径 |
| ADM-04 | `.ai priv ses ck now` | M | `会话权限` | 记录当前会话权限 |
| ADM-05 | `.ai priv st ai-privilege 0-0-0` | M | `你不能修改priv指令的权限` | 保护路径 |
| ADM-06 | `.ai priv st ai-status 0-0` | M | `权限值必须为3个数字` | 错误路径 |
| ADM-07 | `.ai priv st ai-status 0-0-0` | M | `权限修改完成` | 全局修改，ADM-08 恢复 |
| ADM-08 | `.ai priv reset` | M | `指令权限重置完成` | 恢复默认（全局） |
| ADM-09 | `.ai priv ses st now <快照会话权限>` | M | `权限修改完成` | 还原会话权限 |

## prompt（需骰主）

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| ADM-10 | `.ai prompt` | M | 非空长文本 | 回复长度 > 100 且不含 `指令.ai执行失败` 即 PASS；内容含角色设定等 |

## token（S）

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| ADM-11 | `.ai tk` | S | `帮助` | |
| ADM-12 | `.ai tk lst` | S | `有使用记录的模型` | |
| ADM-13 | `.ai tk sum` | S | `没有使用记录` 或 `总token` | |
| ADM-14 | `.ai tk all` | S | `没有使用记录` 或 `全部使用记录如下` | |
| ADM-15 | `.ai tk y` | S | `最近12个月使用记录如下` 或 `没有使用记录` | |
| ADM-16 | `.ai tk m` | S | `最近31天使用记录如下` 或 `没有使用记录` | |
| ADM-17 | `.ai tk 不存在的模型` | S | `没有这个模型` | 错误路径 |
| ADM-18 | `.ai tk clr 不存在的模型` | S | `没有这个模型` | 错误路径 |
| ADM-19 | `.ai tk y chart` | S | `[CQ:image` 或 `图表生成失败` | 依赖用量图表后端；无后端则 SKIP(env) |
| ADM-20 | `.ai tk clr` | S | `已清除token使用记录` | **破坏性（全局记录）**，默认跳过，需用户确认 |

## timer

| ID | 指令 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| ADM-21 | `.ai timer lst` | U | `当前对话没有定时器` 或 `定时器` | |
| ADM-22 | `.ai timer clr` | I | `所有定时器已清除` | 收尾清理 |

说明：`priv st` 与 `priv reset` 修改的是全局 `cmdPriv` 存储，执行后必须复位；`token clr` 清空全局用量记录，默认不执行。
