---
name: aiplugin4-e2e-test
description: 对 SealDice 的 aiplugin4 插件做全量子指令端到端测试：通过 qqmcp（QQ-MCP-Server）向指定测试群里的 aiplugin4 机器人发送 .ai/.img 指令，拉取群消息核对每条子指令（status/ctxn/on/standby/off/forget/role/model/shut/memory/tool/ignore/token/timer/image/privilege/prompt）的预期回复，输出 PASS/FAIL 报告并恢复现场。当用户要求测试、验证或回归 aiplugin4 插件的指令功能，或修改插件代码后需要确认每条子指令仍然正常时使用。
---

# aiplugin4 全量 E2E 测试

## 适用场景

对 aiplugin4 的每条子指令做群聊端到端验证：发送指令 → 拉取机器人回复 → 关键字断言 → 输出报告 → 恢复现场。指令行为以 `src/cmd/sub_cmd/` 源码为准，README 可能过时。

## 前提

- Codex 已配置 `QQ-MCP-Server` MCP 服务（工具名形如 `mcp__QQ-MCP-Server__qq_send_group_message`），服务地址与令牌见 `~/.codex/config.toml` 的 `mcp_servers.QQ-MCP-Server`。
- 存在专用测试群，群内同时有：控制器机器人（qqmcp 所连的 NapCat 账号）与待测机器人（运行 aiplugin4 的海豹骰娘）。
- 控制器账号需满足被测指令的权限要求（见各用例表"权限"列）：
  - `U`=任意成员；`I`=邀请者(40)/群管理(50)/群主(60)/白名单(70)/骰主(100)；`M`/`S`=骰主（会话权限为 0 时 `S` 也仅骰主可用，见 `src/cmd/privilege.ts`）。
  - 权限不满足时机器人回复"权限不足"，用例记 `SKIP(权限)`，不算失败。

## 工作流

### 1. 确认目标

1. 调用 `qq_get_bot_status` 确认控制器在线，记录其 QQ。
2. 调用 `qq_list_groups` 找测试群（优先取 `QQ_MCP_LISTEN_GROUPS` 指定的群），记录 `group_id`。
3. 调用 `qq_get_group_members` 确认控制器在群内角色与群成员。
4. 发送一条 `.ai status`，用 `qq_get_group_messages` 找到回复者，其 QQ 即为待测机器人；若已知目标 QQ 可直接使用。
5. 不要向非测试群发送任何消息。

### 2. 预检与快照

确认 `.ai status` 有回复后，依次执行只读快照并记录结果，用于结束恢复：

`.ai status`、`.ai model`、`.ai ctxn status`、`.ai memo status`、`.ai tool`、`.ai timer lst`、`.ai tk sum`、`.ai ign list`、`.ai role`

记录会话权限值、各触发模式、待机状态、当前模型、角色名、忽略名单、定时器与 token 记录。

### 3. 执行用例

按域读取 references：`control.md`（基础控制+忽略名单）、`memory.md`、`tool.md`、`admin.md`（权限/prompt/token/定时器）、`image.md`；`qqmcp.md` 为工具用法与轮询约定。

每条用例：

1. 用 `qq_send_group_message(group_id, 指令)` 发送，记录返回 `message_id` 与时间。
2. 每 2~3 秒调用一次 `qq_get_group_messages(group_id, count=20, reverse_order=true)`，过滤 `user_id == 待测机器人QQ` 且 `time >= 发送时间-1` 的消息，取第一条为回复（NapCat 的 `message_seq` 按发送者独立计数，不能跨发送者比较）。
3. 拼接回复中的 text 段，与用例"预期关键字"做子串匹配（不要求全等）。
4. 判定：全部关键字命中 → `PASS`；回复"权限不足" → `SKIP(权限)`；超时（默认 45 秒）→ `FAIL(超时)`；其他 → `FAIL` 并记录实际文本。

用例约定：

- 破坏性指令（`memo clr`/`forget`/`timer clr` 等）按用例表"清理"步骤执行，做到自清理；对全局数据的操作（`token clr`、`priv st`/`priv reset`）默认只测错误路径，完整操作需用户确认后执行。
- 依赖环境的指令（图片识别需视觉模型、图表需用量后端、语音需 ffmpeg 等）：无对应配置时记 `SKIP(env)` 并注明原因。

### 发送频率与节奏控制（必须遵守）

测试会真实刷屏，必须控制发送节奏，避免打扰群内其他人、触发 QQ 频控：

1. 相邻两条指令至少间隔 3 秒（`qq_send_group_message` 发送后再等待 3 秒才发下一条）。
2. 每发送 5 条指令暂停 10 秒（可顺带完成上一条的轮询验证）。
3. 每个用例域（control/memory/tool/admin/image）完成后暂停 30 秒。
4. 单次运行默认最多发送 60 条指令；超出部分提示用户分批执行，不自动继续。
5. 只发送用例表必需的指令，不重复发送、不发送测试外的消息。
6. 用户随时要求停止时，立即停止后续发送，不追加收尾指令。
7. 收到机器人回复"频率过快/频控"或连续 2 条无回复时，将间隔加倍并放慢节奏。

### 4. 输出报告

在仓库 `test-reports/` 下生成 `aiplugin4-e2e-<yyyyMMdd-HHmm>.md`，结构：

1. 环境信息：群号、控制器 QQ、待测机器人 QQ、控制器权限、会话权限、执行时间。
2. 汇总表：域 / 用例 / 指令 / 权限 / 预期关键字 / 实际回复 / 结果。
3. 汇总行：PASS / FAIL / SKIP 计数。
4. 失败与跳过明细：附实际回复与排查建议。
5. 恢复现场结果：最后一条 `.ai status` 与快照的一致性核对。

### 5. 恢复现场（无论结果如何都要执行）

- 触发模式：按快照用 `.ai on --c= --t= --p=` 恢复，或 `.ai off`/`.ai sb` 还原。
- `.ai model <原模型>` 或 `clr`；`.ai ctxn mod <原值>`（默认 0）；`.ai role <原角色>`。
- 记忆/忽略名单/定时器：用例已自清理则跳过，否则 `memo p/g st clr`、`ign rm @<QQ>`、`timer clr`。
- priv 用例若执行过 `priv st`，结束时执行 `priv reset` 还原。
- 恢复后执行 `.ai status` 复查，确认与会话快照一致。

### 6. 往群里发送总结（最后一步）

全部用例执行完毕且现场恢复后，向测试群发送一条总结消息（`qq_send_group_message`）：

1. 内容包含：PASS / FAIL / SKIP 计数（按域列出更佳）、FAIL 的用例 ID 与指令、SKIP 原因（权限/环境）、测试报告文件相对路径。
2. 压缩为 1 条消息（500 字以内），不刷屏。
3. 遵守频率控制：发送总结与前一条指令间隔 ≥ 3 秒，且计入单次运行消息上限。
4. 发送后本轮结束，不再追加任何指令。

## 用例文件

- [qqmcp.md](references/qqmcp.md) — qqmcp 工具速查、轮询/断言约定、故障排查
- [control.md](references/control.md) — status/ctxn/on/standby/off/forget/role/model/shut/ignore
- [memory.md](references/memory.md) — memory 全部子命令
- [tool.md](references/tool.md) — tool 全部子命令
- [admin.md](references/admin.md) — privilege/prompt/token/timer
- [image.md](references/image.md) — image 全部子命令

只测某一条指令/功能时使用 `aiplugin4-single-test`（位于同级 `../aiplugin4-single-test/`），本技能用于全量回归。

## 注意事项

- 所有断言用关键字子串；回复行首可能有空白或包含 CQ 码。
- 流式回复可能分多条发送，取发送时间后的第一条即可。
- 命令别名（sb/fgt/memo/tk/ign/img/priv/ses/st/ck/clr/lst/del/p/g/y/m 等）由 `src/config/static_config.ts` 的 ALIAS_MAP 映射，用例按源码支持的形式编写。
