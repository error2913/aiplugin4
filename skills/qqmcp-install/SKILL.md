---
name: qqmcp-install
description: 安装、配置、注册并验证 QQ-MCP-Server（qqmcp，基于 NapCatQQ OneBot 的 MCP Streamable HTTP 服务）。当用户要求安装/配置/部署 QQ-MCP-Server、把 QQ 机器人接入 Codex/Claude/Cherry Studio/Cursor 等 MCP 客户端、处理 NAPCAT_BASE_URL/.env/token 配置、注册 MCP 到 Codex config.toml 或 CC Switch、验证服务健康或消息收发时使用。所有示例使用占位符，禁止写入真实凭据。
---

# QQ-MCP-Server 安装与配置

QQ-MCP-Server 是轻量 Python 服务：对外提供 MCP Streamable HTTP 接口（`/mcp`），
对内调用已部署的 NapCatQQ OneBot API（HTTP 或 WebSocket），让 MCP 客户端读取机器人
状态、群/好友、聊天记录，并发送消息、群禁言等。它不负责安装/登录 NapCat。

架构：`MCP 客户端 -> QQ-MCP-Server (:8888/mcp) -> NapCat OneBot (HTTP/WS) -> QQ`

## 前置条件

- Python 3.10+、Git
- NapCatQQ 已登录并启用 OneBot Server（HTTP 或 WebSocket，消息格式建议 Array）
- 目标机器能访问 NapCat 地址与端口

## 工作流

### 1. 获取源码

官方仓库 `print-yuhuan/QQ-MCP-Server` 可能不可公开访问（404/私有）。先尝试
`git clone https://github.com/print-yuhuan/QQ-MCP-Server.git`；若失败，使用本机已有的
接口兼容实现（`qq_mcp_server/` 包 + `pyproject.toml`，包含 11 个读/写工具、消息监听、
WebSocket 客户端），并向用户说明这不是官方源码。

### 2. 安装

```powershell
cd <PROJECT_DIR>
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

依赖会自动安装（`mcp`、`httpx`、`uvicorn`、`websockets`、`python-dotenv`）。

### 3. 配置 .env

项目自带 `.env.example`。生成随机 token 并创建 `.env`：

```powershell
python scripts\init_env.py <PROJECT_DIR>
```

或手动填写（见 references/env-vars.md）：

```dotenv
QQ_MCP_ACCESS_TOKEN=<MCP_ACCESS_TOKEN>
NAPCAT_BASE_URL=ws://<NAPCAT_HOST>:<NAPCAT_PORT>
NAPCAT_ACCESS_TOKEN=<NAPCAT_ACCESS_TOKEN>
QQ_MCP_LISTEN_GROUPS=<GROUP_ID>
```

必填项只有 `QQ_MCP_ACCESS_TOKEN` 和 `NAPCAT_BASE_URL`。协议按 URL 前缀自动识别：
`ws://` 走 WebSocket、`http://` 走 HTTP。

本技能与 aiplugin4-test-suite 统一：凭据另存一份在技能目录 `skills/qqmcp-install/.env`
（已被 `.gitignore` 的 `skills/**/.env` 覆盖，不会提交），`scripts/verify.py` 会自动从
技能目录 `.env` 读取凭据；服务端运行配置仍在服务项目目录的 `.env`。

### 4. 启动

```powershell
.\.venv\Scripts\python.exe -m qq_mcp_server
```

端点：`http://<HOST>:8888/mcp`，健康检查：`http://<HOST>:8888/health`。

### 5. 验证

```powershell
python scripts\verify.py http://127.0.0.1:8888 <MCP_ACCESS_TOKEN>
```

预期：`/health` 返回 `{"ok": true, ...}`，initialize 返回 HTTP 200。
若返回 401 检查 MCP token；若工具调用报 `NAPCAT_REQUEST_FAILED` 检查 NapCat 连通性
（见 references/troubleshooting.md）。

### 6. 注册到客户端

- Codex：直接写 `~/.codex/config.toml`（`type = "http"`，用 `http_headers`），改完重启 Codex；
- 其他客户端 / CC Switch：见 references/client-configs.md。

### 7. 消息监听（可选）

服务启动时自动开第二条 WebSocket 连接，实时接收群聊/私聊消息：

- 写入 `QQ_MCP_MESSAGE_LOG_FILE`（默认 `messages.log`，UTF-8 JSON 行）；
- 工具 `qq_get_incoming_messages` 拉取内存缓冲（最近 200 条）；
- `QQ_MCP_LISTEN_GROUPS` 限制只监听指定群（逗号分隔），空则监听所有群。

注意：监听只"收"不"回"。需要自动回复时在 `qq_mcp_server/listener.py` 的
`_should_capture` / 事件处理处扩展。

## 工具清单

读：`qq_get_bot_status`、`qq_list_groups`、`qq_list_friends`、`qq_get_group_members`、
`qq_get_group_messages`、`qq_get_private_messages`、`qq_get_incoming_messages`

写：`qq_send_group_message`（支持 CQ 码/消息段数组/@）、`qq_send_private_message`、
`qq_set_group_ban`、`qq_set_group_whole_ban`（后两个需管理员权限，高风险）

统一返回 `{"ok": true, "data": ...}` 或 `{"ok": false, "error": {"code", "message"}}`。

## 敏感信息

- 所有示例与输出一律使用占位符，禁止写入真实 token / QQ 号 / 群号 / IP；
- 不要把 `.env`、`messages.log`、运行日志提交或外发；
- 技能目录 `.env`（`skills/qqmcp-install/.env`）与 aiplugin4-test-suite 同款 gitignore 保护；
- `QQ_MCP_LOG_MESSAGE_CONTENT` 保持 `false`。
