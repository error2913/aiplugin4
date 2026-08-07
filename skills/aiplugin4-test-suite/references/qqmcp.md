# qqmcp（QQ-MCP-Server）速查

## 工具目录

| 工具名 | 参数 | 用途 | 本技能用法 |
|---|---|---|---|
| `qq_get_bot_status` | 无 | 控制器机器人 QQ/昵称/在线状态 | 预检 |
| `qq_list_groups` | 无 | 机器人所在群（group_id/group_name/member_count） | 找测试群 |
| `qq_get_group_members` | `group_id` | 群成员（user_id/nickname/card/role/is_robot） | 确认身份/找目标机器人 |
| `qq_get_group_messages` | `group_id, count, reverse_order, start_message_seq, parse_forward` | 拉群历史 | 验证回复 |
| `qq_get_incoming_messages` | `count` | 监听器最近收到的消息 | 备用验证 |
| `qq_send_group_message` | `group_id, message` | 发群消息（支持 CQ 码） | 发送指令 |
| `qq_send_private_message` | `user_id, message` | 私聊 | 不使用 |
| `qq_set_group_ban` / `qq_set_group_whole_ban` | - | 禁言（高风险写操作） | 不使用 |

Codex 中调用名形如 `mcp__QQ-MCP-Server__qq_send_group_message`。服务端实现见 `C:/Users/26335/Desktop/qq-mcp-server/qq_mcp_server/tools.py`。

发送/读取消息统一使用 `scripts/qqmcp.ps1`：参数经环境变量 `QQMCP_ARGS_JSON` 传入（避免命令行引号丢失），可直接传中文消息。

## 消息格式

- 纯文本指令：`{"group_id": <群号>, "message": ".ai status"}`
- @ 提醒：`[CQ:at,qq=<QQ>]`；图片：`[CQ:image,file=<url 或本地路径>]`
- 返回统一 `{"ok": true, "data": ...}` 或 `{"ok": false, "error": {"code": ..., "message": ...}}`

## 验证循环（发送 → 轮询 → 断言）

1. 发送指令，记录返回的 `message_id` 与本地时间。
2. 每 2~3 秒轮询一次 `qq_get_group_messages(group_id, count=20, reverse_order=true)`，最长 45 秒。
3. 发送节奏：相邻指令间隔 ≥ 3 秒；每 5 条暂停 10 秒；每个用例域完成后暂停 30 秒；单次运行默认上限 60 条，超限分批执行。任何情况下不得连续快速发送。
   - 群里消息以验证连通为主：可以发，但不能发一堆，验证能发就行。
   - 重载 JS 是写操作：**两次重载间隔必须 ≥ 1 分钟**（见 panel.md）。
4. 过滤待测机器人回复：`user_id == 待测机器人QQ` 且 `time >= 发送时间 - 1`。
   - NapCat 的 `message_seq` 按发送者独立计数，**不能**跨发送者比较大小。
   - `message_id` 同样按发送者计数，不能用来判断先后。
5. 拼接 `message[]` 中 `type == "text"` 的 `data.text`；图片段记作 `[CQ:image,...]`。
6. 断言：用例"预期关键字"全部命中（子串匹配）→ PASS；否则 FAIL 并记录实际文本。
7. 回复含"权限不足" → `SKIP(权限)`；含"命令不存在" → 检查插件是否加载、命令名是否写错。
8. 收到"频率过快"类提示或连续 2 条无回复时，把间隔翻倍放慢节奏。

## 故障排查

| 现象 | 处理 |
|---|---|
| `MCP_AUTH_FAILED` | 检查 `~/.codex/config.toml` 中 `mcp_servers.QQ-MCP-Server` 的 token |
| `NAPCAT_REQUEST_FAILED` | NapCat 掉线或 WS 未连接 |
| 发指令后无回复 | 插件未重载、`.ai` 未注册；AI 关闭不影响 `.ai` 指令本身 |
| 回复"权限不足" | 控制器账号权限不足，按用例权限列处理 |
| `listener_connected=false` | 改用 `qq_get_group_messages` 兜底 |
| 文本中出现 `&#91;`/`&#93;` | 仅 `raw_message` 有 HTML 转义；`message[].text` 已是明文 |

## 示例环境（本仓库开发机）

- 控制器：Fairy `3837233349`（SealDice 骰主权限，群内 admin）
- 测试群：呱呱群 `1064487252`（`QQ_MCP_LISTEN_GROUPS` 指定）
- 待测机器人：正确确 `3893625976`（`.ai status` 的回复者）
- 回复延迟约 1 秒；会话权限为 0
