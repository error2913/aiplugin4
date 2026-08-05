---
name: aiplugin4-test-suite
description: aiplugin4 插件综合测试与调试技能（整合原 aiplugin4-e2e-test / aiplugin4-single-test / sealdice-plugin-debug）：通过 qqmcp 对测试群的 aiplugin4 机器人做全量测试（全部 .ai/.img 子指令 + 重载 JS）、单项测试（只测指定指令）、重载测试（上传 dist 插件并重载 JS，两次重载间隔≥1分钟）、调试配置（只改 aiplugin4「后端」二级页签配置并点击点我保存、改后恢复原样），指令执行异常时读取海豹日志定位；并保留海豹面板解锁/日志/JS 扩展管理能力。当用户要求测试/验证/回归 aiplugin4 指令、上传插件并重载、修改插件配置、查看海豹日志、调试海豹面板时使用。
---

# aiplugin4 综合测试与调试

## 模式总览

1. 全量测试：所有子指令 + 重载 JS + 异常时读海豹日志
2. 单项测试：只测用户指定的某条指令/子命令
3. 重载测试：上传插件（dist/aiplugin4.js）→ 等待几秒 → 重载 JS
4. 调试配置：修改 aiplugin4「后端」二级页签配置 → 点我保存 → 验证 → 恢复原样
5. 面板调试：解锁面板 / 查看日志 / JS 扩展 / 插件列表 / 截图

## 环境与前提

- qqmcp：`mcp__QQ-MCP-Server__*` 工具，用法与轮询约定见 [qqmcp.md](references/qqmcp.md)。
- 海豹面板：`SEALDICE_PANEL_URL` / `SEALDICE_PANEL_PASSWORD` 从环境变量读取（本机已写入用户级环境变量；缺失时才向用户索要）。面板自动化见 [panel.md](references/panel.md) 与 [panel.mjs](scripts/panel.mjs)。
- Node：`C:\Users\26335\.codex\tools\node-v22.23.2-win-x64\node.exe`（勿用系统 Node）。
- Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
- 测试群与机器人：按模式一第 1 步预检。

## 共同注意事项（必须遵守）

1. 群里消息以验证连通为主：可以发，但不能发一堆，验证能发就行。
2. 重载 JS 是写操作且影响所有 JS 插件：**两次重载间隔必须 ≥ 1 分钟**；上传插件/重载 JS/删除插件默认需用户批准。
3. 配置修改后必须恢复原样：只修改 aiplugin4 设置中「后端」二级页签内的配置项；页面上不属于二级页签的项一律不碰；其他插件配置不乱动。
4. 发送频率控制：相邻指令 ≥ 3 秒、每发 5 条暂停 10 秒、单次运行上限、用户喊停立即停（详见 qqmcp.md）。
5. 指令回复出现「指令.ai执行失败」等异常时，立即用 `scripts/panel.mjs logs` 读取海豹日志，并把相关日志摘要写入报告。
6. 破坏性指令（`memo clr`/`forget`/`timer clr` 等）按用例表"清理"步骤执行，做到自清理；全局破坏性操作（`token clr`、`priv st`/`priv reset`）默认只测错误路径，完整操作需用户确认。
7. 依赖环境的指令（图片识别需视觉模型、图表需用量后端、语音需 ffmpeg 等）：无对应配置时记 `SKIP(env)` 并注明原因。

## 模式一：全量测试

1. 预检：`qq_get_bot_status` → `qq_list_groups` → `qq_get_group_members` → 发一条 `.ai status` 找到回复者（待测机器人）。
2. 只读快照：`.ai status`、`.ai model`、`.ai ctxn status`、`.ai memo status`、`.ai tool`、`.ai timer lst`、`.ai tk sum`、`.ai ign list`、`.ai role`。
3. 逐域执行用例（发送 → 轮询 → 关键字断言）：control.md / memory.md / tool.md / admin.md / image.md。
4. 有用例异常（执行失败/无回复/权限异常）：`panel.mjs logs` 读取海豹日志，摘录相关日志到报告并给出诊断。
5. 重载 JS 测试：确认距上次重载 ≥ 1 分钟 → `panel.mjs reload`（或 `upload-reload`）→ 重载完成后等待数秒 → `panel.mjs logs` 查看重载日志确认无报错（日志摘要写入报告）→ 向群里发 `.ai status` 验证插件仍响应。
6. 恢复现场（按快照还原）→ 向群里发总结（PASS/FAIL/SKIP 计数 + 失败项）→ 写 `test-reports/aiplugin4-e2e-<yyyyMMdd-HHmm>.md`。

## 模式二：单项测试

| 用户提到的指令 | 用例文件 |
|---|---|
| `status` `ctxn` `on` `off` `sb/standby` `fgt/forget` `role` `model` `shut` `ign/ignore` | [control.md](references/control.md) |
| `memo/memory` | [memory.md](references/memory.md) |
| `tool` | [tool.md](references/tool.md) |
| `priv/privilege` `prompt` `tk/token` `timer` | [admin.md](references/admin.md) |
| `img/image` | [image.md](references/image.md) |

只跑用户点名指令对应的行；快照与恢复仅限该域；执行完后群里发总结（含被测指令与 PASS/FAIL/SKIP）。

## 模式三：重载测试

1. 确认插件文件存在：`dist/aiplugin4.js`（或用户指定路径）。
2. `scripts/panel.mjs upload-reload --file <路径>`：解锁 → 打开 `#/mod/js` → 上传插件 → **等待上传完成数秒** → 点击「重载 JS」→ 等待完成。
3. 距上次重载必须 ≥ 1 分钟；连续重载测试之间至少间隔 1 分钟。
4. 上传成功后用 `plugins` 确认目标插件"安装时间"更新（如"几秒前"）且仍启用；重载完成后**等待数秒**，用 `panel.mjs logs` 查看重载日志确认无报错（日志摘要写入报告），再向群里发 `.ai status` 验证插件仍响应；异常时以 `logs` 输出定位。

## 模式四：调试配置

1. `panel.mjs unlock` + `panel.mjs open-js`；用 `panel.mjs inspect` 查看标签页与按钮。
2. 进入 aiplugin4 插件设置：切到「插件设置」页签 → 点击折叠头 `aiplugin4`（面板条目名是 aiplugin4，不是显示名"AI骰娘4"）→ 出现配置页签（默认分组/基础/模型/后端/...）→ 点「后端」。
3. 先用 `panel.mjs steps` 的 dump 记录「后端」待改字段的原始值（快照）。后端页签含 6 个 URL 字段（流式输出/图片转base64/联网搜索/网页读取/用量图表/md和html图片渲染），字段名显示在表单内容区。
4. 用 `panel.mjs steps --file steps.json`：切「插件设置」→ 点 `aiplugin4` → 点「后端」→ `set` 目标字段 → **「点我保存」按钮只在修改字段后出现** → 点击「点我保存」→ 等待保存完成 → dump。
5. 验证保存：**新开页面**重新进入「后端」读取字段值，确认与修改值一致（不要只信当前页面的值）。
6. 恢复原样：字段改回快照值 → 点我保存 → 新开页面验证已恢复。
7. 不碰非二级页签的项，不碰其他插件配置。

## 模式五：面板调试

- `unlock`：解锁面板；`logs [--limit N]`：查看海豹日志；`open-js`：打开 JS 扩展页；`plugins`：读取插件安装情况；`screenshot [--route]`：截图。

## 参考文件与脚本

- 测试用例：control.md / memory.md / tool.md / admin.md / image.md；qqmcp 用法：qqmcp.md；面板结构：panel.md。
- [panel.mjs](scripts/panel.mjs) 支持命令：`unlock|logs|open-js|plugins|screenshot|inspect|click|set-input|steps|reload|upload-reload`。
