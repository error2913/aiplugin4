---
name: aiplugin4-single-test
description: 只针对 aiplugin4 插件某一条具体指令/功能做定向端到端验证（例如只测 .ai memo、只测 .ai tool、只测 .ai status）：通过 qqmcp（QQ-MCP-Server）向指定测试群的 aiplugin4 机器人发送该指令及其子命令，拉取群消息核对预期关键字，输出 PASS/FAIL 报告并恢复现场。当用户要求"只测某个功能/某条命令""单独验证某条子指令"时使用；全量回归请用 aiplugin4-e2e-test。
---

# aiplugin4 单功能定向测试

## 适用场景

用户只想验证一条或一组相关指令（如只测记忆、只测工具、只测 token），不跑全量。用例表与 qqmcp 用法复用 `../aiplugin4-e2e-test/references/` 下的文件，不重复维护；全量回归用 `aiplugin4-e2e-test`。

## 工作流

### 1. 确定被测目标

从用户请求中提取指令名或别名；含糊时给出候选：`status/ctxn/on/off/sb/fgt/role/model/shut/ign/memo/tool/priv/prompt/tk/timer/img`。按以下映射读取对应用例文件：

| 用户提到的指令 | 域 | 用例文件 |
|---|---|---|
| `status` `ctxn` `on` `off` `sb/standby` `fgt/forget` `role` `model` `shut` `ign/ignore` | 基础控制+忽略名单 | `../aiplugin4-e2e-test/references/control.md` |
| `memo/memory` | 记忆 | `../aiplugin4-e2e-test/references/memory.md` |
| `tool` | 工具 | `../aiplugin4-e2e-test/references/tool.md` |
| `priv/privilege` `prompt` `tk/token` `timer` | 管理 | `../aiplugin4-e2e-test/references/admin.md` |
| `img/image` | 图片 | `../aiplugin4-e2e-test/references/image.md` |

只选取表中与被测指令相关的行；若用户点名具体子命令（如"只测 memo short"、"只测 tool help"），再缩小到对应行。

### 2. 环境与目标

读 `../aiplugin4-e2e-test/references/qqmcp.md` 获取工具用法、轮询与故障排查。确认控制器在线、测试群、待测机器人（与全量技能步骤一致）。

### 3. 快照（只快照与被测指令相关的状态）

- 控制类：`.ai status`、`.ai ctxn status`、`.ai model`、`.ai role`
- 记忆类：`.ai memo status`
- 工具类：`.ai tool`
- 管理类：`.ai priv ses ck now`、`.ai tk sum`、`.ai timer lst`
- 图片类：`.ai img stl`、`.ai img list stl`

记录恢复所需值（触发模式、模型、角色、忽略名单、定时器、token 等）。

### 4. 执行

按对应用例文件逐条执行：`qq_send_group_message` 发送 → 轮询 `qq_get_group_messages` → 关键字断言。判定规则同全量技能：命中 PASS；"权限不足"记 SKIP(权限)；超时记 FAIL(超时)；环境不满足记 SKIP(env)。只跑选定用例，不执行其他域。

### 5. 发送频率控制（必须遵守）

- 相邻指令间隔 ≥ 3 秒；每发 5 条暂停 10 秒。
- 单次运行默认最多发 30 条指令，超出提示分批。
- 用户要求停止时立即停，不追加收尾指令。
- 收到"频率过快"提示或连续 2 条无回复时，间隔翻倍放慢。

### 6. 报告

在仓库 `test-reports/` 生成 `aiplugin4-single-<yyyyMMdd-HHmm>.md`，结构：环境信息 → 用例明细（域/用例/指令/权限/预期/实际/结果）→ PASS/FAIL/SKIP 汇总 → 失败明细 → 恢复结果。

### 7. 恢复现场

只恢复本次实际改动过的状态（按第 3 步快照）：触发模式、模型、角色、ctxn 值、记忆、忽略名单、定时器、会话权限等。通用恢复命令见 `../aiplugin4-e2e-test/SKILL.md` 第 5 节。

### 8. 往群里发送总结（最后一步）

用例执行完毕且现场恢复后，向测试群发送一条总结消息（`qq_send_group_message`）：

1. 内容包含：被测指令、PASS / FAIL / SKIP 计数、FAIL 的用例 ID 与指令、SKIP 原因（权限/环境）。
2. 压缩为 1 条消息（500 字以内），不刷屏。
3. 遵守频率控制：发送总结与前一条指令间隔 ≥ 3 秒，且计入单次运行消息上限。
4. 发送后本轮结束，不再追加任何指令。

## 注意事项

- 不执行全局破坏性操作（`token clr`、`priv st`/`priv reset`），除非用户明确要求。
- 依赖环境的用例（图片识别、图表、语音等）记 SKIP(env)。
- 向群内发送前先说明将要发送哪些指令；测试群以外的群一律不发。
