# 客户端注册参考

## Codex（推荐直接写 ~/.codex/config.toml）

QQ-MCP-Server 使用 Streamable HTTP，对应 Codex 配置中的 `type = "http"`（不是 `sse`）。

```toml
[mcp_servers.QQ-MCP-Server]
type = "http"
url = "http://127.0.0.1:8888/mcp"
http_headers = { Authorization = "Bearer <MCP_ACCESS_TOKEN>" }
```

注意 Codex TOML 用 `http_headers`（不是 `headers`）。改完需重启 Codex 才会加载。

## Claude Code（~/.claude.json）

```json
{
  "mcpServers": {
    "QQ-MCP-Server": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8888/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

## CC Switch

CC Switch 是"前台"，最终仍写回各客户端配置文件。手动添加时：

1. 顶部导航点 MCP → 右上角 `+` → 自定义
2. 传输类型选 **http**（不要选 sse —— 本服务没有 `/sse` 端点）
3. URL 填 `http://127.0.0.1:8888/mcp`
4. Headers 填 `Authorization: Bearer <MCP_ACCESS_TOKEN>`
5. 保存后打开需要的应用开关（Codex/Claude/Gemini/OpenCode/Hermes）

深度链接一键导入（`<MCP_ACCESS_TOKEN>` 需 URL 编码）：

```text
ccswitch://v1/import?resource=mcp&apps=codex&name=QQ-MCP-Server&config=%7B%22mcpServers%22%3A%7B%22QQ-MCP-Server%22%3A%7B%22type%22%3A%22http%22%2C%22url%22%3A%22http%3A%2F%2F127.0.0.1%3A8888%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22Bearer%20<MCP_ACCESS_TOKEN>%22%7D%7D%7D%7D
```

## 通用 Streamable HTTP 配置（Cherry Studio / Cursor / Cline 等）

```json
{
  "mcpServers": {
    "QQ-MCP-Server": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8888/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

三种鉴权等价：`Authorization: Bearer`、`X-API-Key`、`?token=`（后者需
`QQ_MCP_ENABLE_QUERY_TOKEN=true`）。
