# 环境变量参考

所有变量通过 `.env` 或环境变量注入。`<...>` 为占位符，禁止写入真实值。

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `QQ_MCP_HOST` | 否 | `0.0.0.0` | MCP 服务监听地址 |
| `QQ_MCP_PORT` | 否 | `8888` | MCP 服务监听端口 |
| `QQ_MCP_PATH` | 否 | `/mcp` | MCP Streamable HTTP 端点路径 |
| `QQ_MCP_ACCESS_TOKEN` | 是 | - | MCP 客户端访问 token（生成随机长值） |
| `QQ_MCP_ENABLE_QUERY_TOKEN` | 否 | `true` | 是否允许 `?token=` 鉴权；公网建议 `false` |
| `NAPCAT_BASE_URL` | 是 | - | NapCat 地址；`http://` 走 HTTP、`ws://` 走 WebSocket，自动识别 |
| `NAPCAT_ACCESS_TOKEN` | 否 | 空 | NapCat OneBot 自身 token（WS 用 `Authorization: Bearer`） |
| `NAPCAT_TIMEOUT_SECONDS` | 否 | `30` | 单次 NapCat 请求超时（秒） |
| `QQ_MCP_LOG_LEVEL` | 否 | `INFO` | `DEBUG`/`INFO`/`WARNING`/`ERROR` |
| `QQ_MCP_LOG_MESSAGE_CONTENT` | 否 | `false` | 是否记录发送消息正文；生产建议 `false` |
| `QQ_MCP_MAX_MESSAGE_CHARS` | 否 | `5000` | 单条发送文本最大字符数 |
| `QQ_MCP_DEFAULT_HISTORY_COUNT` | 否 | `5` | 默认拉取历史条数 |
| `QQ_MCP_MAX_HISTORY_COUNT` | 否 | `1000` | 单次最大历史条数 |
| `QQ_MCP_LISTEN_GROUPS` | 否 | 空 | 消息监听只收指定群（逗号分隔群号）；空则监听所有群 |
| `QQ_MCP_MESSAGE_LOG_FILE` | 否 | `messages.log` | 实时收到的消息写入的 JSON 行文件（UTF-8） |

## .env 模板（占位符）

```dotenv
QQ_MCP_HOST=0.0.0.0
QQ_MCP_PORT=8888
QQ_MCP_PATH=/mcp
QQ_MCP_ACCESS_TOKEN=<MCP_ACCESS_TOKEN>
QQ_MCP_ENABLE_QUERY_TOKEN=true

# NapCat：ws:// 或 http:// 前缀决定走哪种协议
NAPCAT_BASE_URL=ws://<NAPCAT_HOST>:<NAPCAT_PORT>
NAPCAT_ACCESS_TOKEN=<NAPCAT_ACCESS_TOKEN>
NAPCAT_TIMEOUT_SECONDS=30

QQ_MCP_LOG_LEVEL=INFO
QQ_MCP_LOG_MESSAGE_CONTENT=false
QQ_MCP_MAX_MESSAGE_CHARS=5000
QQ_MCP_DEFAULT_HISTORY_COUNT=5
QQ_MCP_MAX_HISTORY_COUNT=1000

QQ_MCP_LISTEN_GROUPS=<GROUP_ID>
QQ_MCP_MESSAGE_LOG_FILE=messages.log
```

## 敏感信息规则

- 永远不要向技能文件、日志、示例或公开文档写入真实 token、真实 QQ 号、真实群号、真实服务器 IP/域名。
- 一律使用 `<MCP_ACCESS_TOKEN>`、`<NAPCAT_ACCESS_TOKEN>`、`<NAPCAT_HOST>:<NAPCAT_PORT>`、`<GROUP_ID>` 等占位符。
- 生成 `.env` 用 `scripts/init_env.py`，它会自动生成随机 `QQ_MCP_ACCESS_TOKEN`。
- `.env`、`messages.log`、`*.out.log` / `*.err.log` 不得提交到仓库。
