# 10 - 待办与后续计划

> 记录当前已知的待办事项。条目按需实现后,请同步更新对应文档并删除本条。

## MCP:Streamable HTTP 环境适配后需要做的修改

现状(`src/tool/mcp.ts`):MCP 客户端只实现了 Streamable HTTP(单 POST JSON-RPC),
受 SealDice goja 沙箱限制,存在以下能力缺口。当运行环境具备对应能力
(AbortController/流式读取、可拉起子进程,或通过 aiplugin4-backends 代理中转)后,
按下表逐项落地:

| 缺口 | 现状 | 环境适配后的修改 |
| --- | --- | --- |
| 请求超时 | goja 无 AbortController,`fetch` 无法设置超时,服务器挂起会一直阻塞工具调用 | `mcpRequest` 增加超时控制(建议默认 10s、可配置),超时返回可读错误;底层请求无法取消时丢弃等待结果并提示 |
| SSE 传输 | 仅支持 Streamable HTTP POST;`type=sse` 的服务器在配置解析时跳过 | 实现 SSE 传输:GET 打开事件流、按 `endpoint` 事件取得 POST 地址、携带 `Mcp-Session-Id`、处理断线重连;或在后端代理中做 SSE→Streamable HTTP 转换 |
| stdio 服务器 | `command` 服务器需要拉起子进程,配置解析时跳过 | 通过配套后端(aiplugin4-backends)代理拉起进程:stdin/stdout 走 JSON-RPC 换行协议,管理进程生命周期与异常重启;插件侧只暴露 Streamable HTTP 地址 |
| OAuth 鉴权 | 仅支持静态 Bearer/自定义 headers | 实现 MCP OAuth 发现与授权流程(protected-resource well-known + 授权码/PKCE),或文档化手动换取 token 后填入 headers 的配置方式 |
| 协议版本协商 | `initialize` 硬编码 `protocolVersion: 2025-11-25` | 根据服务器返回的 `protocolVersion` 做能力协商与降级,支持服务器偏好版本 |
| 流式工具结果 | `tools/call` 只解析非流式 JSON / 单帧 SSE | 解析流式 SSE 返回的多个 `content` 块(文本/资源/图片),按顺序拼接;处理 `progress` 通知 |
| 会话管理 | 每个服务器内存缓存一个 sessionId,失效时重初始化一次 | 支持无状态模式(服务器声明 `stateless` 时不再发送/依赖会话头)、session TTL 清理、插件重载后的会话回收 |
| 工具列表同步 | `tools/list` 结果缓存 60s,只注册新增、不清理已下线 | 刷新时对比新旧工具列表,移除已下线的工具注册;服务器重启后自动重新同步 |
| Resources/Prompts | 只注册 `tools/list` 返回的工具 | 按需暴露 `resources/list`、`prompts/list`,注册为只读工具或注入上下文 |
