# 排障参考

## 连接 NapCat

- `NAPCAT_BASE_URL` 前缀决定协议：`ws://` → WebSocket Server，`http://` → HTTP Server。
- WebSocket 鉴权只支持 `Authorization: Bearer <token>` 请求头：
  - `?access_token=` 参数会被 NapCat 拒绝（retcode 1403）；
  - 同时带请求头和 query 参数会导致连接被直接关闭（close 1005）。
- 端口连不上时检查：NapCat 是否运行、监听地址是否为 `0.0.0.0`（不是 `127.0.0.1`）、
  云安全组/防火墙是否放行、Docker 是否做了 `-p` 端口映射。

## MCP 握手

- initialize 请求必须带 `Accept: application/json, text/event-stream`。
- HTTP 401 → MCP token 错误或请求头名不对（`Authorization: Bearer ...`）。
- `NAPCAT_AUTH_FAILED` → NapCat 自身 token 错误。
- `NAPCAT_REQUEST_FAILED` → NapCat 不可达 / 超时 / 连接被拒。

## 数据与消息

- `get_group_msg_history` / `get_friend_msg_history` 返回 `{"messages": [...]}` 字典，
  不是数组；工具层要取 `data["messages"]`。
- NapCat 不会把机器人自己发的消息推成 WS 事件（`message_sent` 不推送），
  所以实时监听只能收到别人发的消息。
- 历史消息为空的常见原因：接口返回字典但代码按数组解析（见上）。

## 服务与日志

- `/health` 返回 `{"ok": true, "service": "QQ-MCP-Server", "version": "0.1.0"}`。
- `messages.log` 可用 `Get-Content -Wait` 实时查看。
- 服务进程需保持运行，MCP 客户端连接的是本机 `http://127.0.0.1:8888/mcp`。
