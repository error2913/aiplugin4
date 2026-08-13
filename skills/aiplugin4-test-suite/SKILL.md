---
name: aiplugin4-test-suite
description: aiplugin4 插件综合测试与调试技能：通过 qqmcp 对测试群的 aiplugin4 机器人做全量测试（全部 .ai/.img 子指令 + 重载 JS）、单项测试（只测指定指令）、重载测试（上传 dist 插件并重载 JS，两次重载间隔≥1分钟）、调试配置（只改 aiplugin4「后端」二级页签配置并点击点我保存、改后恢复原样），指令执行异常时读取海豹日志定位。测试环境（海豹面板/WebUI、qqmcp、重载 JS 纪律）复用 sealdice-plugin-dev 技能。当用户要求测试/验证/回归 aiplugin4 指令、上传插件并重载、修改插件配置、查看海豹日志时使用。
---

# aiplugin4 综合测试与调试

## 测试环境（复用 sealdice-plugin-dev）

- 面板/WebUI（解锁、日志、JS 扩展页、上传/重载插件、截图）与 QQ 环境（qqmcp）全部复用 sealdice-plugin-dev：先按其 §4.0 确认环境（面板凭据、qqmcp 是否已配置）；面板操作见其 §4 / `references/test-environment.md`、`scripts/test-sealdice.ps1`、`scripts/screenshot.ps1`（或 Chrome DevTools MCP，见 `references/mcp-setup.md`）；qqmcp 发送→轮询→断言流程与纪律见其 §4.4 / `references/test-environment.md` §5。
- 测试纪律（群里少发、发送频率、重载 JS 间隔与批准）统一按 sealdice-plugin-dev §4 执行，不重复列举。

## 共同注意事项（必须遵守）

1. 配置修改后必须恢复原样：只修改 aiplugin4 设置中「后端」二级页签内的配置项；页面上不属于二级页签的项一律不碰；其他插件配置不乱动。
2. 指令回复出现「指令.ai执行失败」等异常时，立即按 sealdice-plugin-dev 的日志读取方式查看海豹日志，并把相关日志摘要写入报告。
3. 破坏性指令（`memo clr`/`forget`/`timer clr` 等）按用例表"清理"步骤执行，做到自清理；全局破坏性操作（`token clr`、`priv st`/`priv reset`）默认只测错误路径，完整操作需用户确认。
4. 依赖环境的指令（图片识别需视觉模型、图表需用量后端、语音需 ffmpeg 等）：无对应配置时记 `SKIP(env)` 并注明原因。

## 模式一：全量测试

1. 预检：`qq_get_bot_status` → `qq_list_groups` → `qq_get_group_members` → 发一条 `.ai status` 找到回复者（待测机器人）。
2. 只读快照：`.ai status`、`.ai model`、`.ai ctxn status`、`.ai memo status`、`.ai tool`、`.ai timer lst`、`.ai tk sum`、`.ai ign list`、`.ai role`。
3. 逐域执行用例（发送 → 轮询 → 关键字断言）：control.md / memory.md / tool.md / admin.md / image.md。
4. 有用例异常（执行失败/无回复/权限异常）：读取海豹日志，摘录相关日志到报告并给出诊断。
5. 重载 JS 测试：确认距上次重载 ≥ 1 分钟 → 上传 `dist/aiplugin4.js` 并重载 → 重载完成后等待数秒 → 查看重载日志确认无报错（日志摘要写入报告）→ 向群里发 `.ai status` 验证插件仍响应。
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
2. 按 sealdice-plugin-dev 的面板自动化方式：解锁 → 打开 `#/mod/js` → 上传插件 → **等待上传完成数秒** → 点击「重载 JS」→ 等待完成。
3. 距上次重载必须 ≥ 1 分钟；连续重载测试之间至少间隔 1 分钟。
4. 上传成功后确认目标插件"安装时间"更新（如"几秒前"）且仍启用；重载完成后**等待数秒**，读取重载日志确认无报错（日志摘要写入报告），再向群里发 `.ai status` 验证插件仍响应；异常时以日志输出定位。

## 模式四：调试配置

1. 按 sealdice-plugin-dev 方式解锁面板并进入 JS 扩展页，查看 aiplugin4 插件设置的标签页与按钮。
2. 进入 aiplugin4 插件设置：切到「插件设置」页签 → 点击折叠头 `aiplugin4`（面板条目名是 aiplugin4，不是显示名"AI骰娘4"）→ 出现配置页签（默认分组/基础/模型/后端/...）→ 点「后端」。
3. 先记录「后端」待改字段的原始值（快照）。后端页签含 5 个 URL 字段（流式输出/图片转base64/联网搜索/用量图表/论坛地址）加 2 个文本字段（论坛API Token/论坛签名密钥），字段名显示在表单内容区。网页读取（web-read）与 md/html 渲染（md-html-render）已移入「工具 → MCP服务器配置」，不在后端页签。
4. 修改目标字段 → **「点我保存」按钮只在修改字段后出现** → 点击「点我保存」→ 等待保存完成。
5. 验证保存：**新开页面**重新进入「后端」读取字段值，确认与修改值一致（不要只信当前页面的值）。
6. 恢复原样：字段改回快照值 → 点我保存 → 新开页面验证已恢复。
7. 不碰非二级页签的项，不碰其他插件配置。

## 参考文件

- 测试用例：control.md / memory.md / tool.md / admin.md / image.md。
