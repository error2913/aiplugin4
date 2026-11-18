# 10 - 待办与后续计划

> 记录当前已知的待办事项。条目按需实现后，请同步更新对应文档并删除本条。

## MCP：Streamable HTTP 环境适配后需要做的修改

现状（`src/tool/mcp/config.ts` + `src/tool/mcp/client.ts` + `src/tool/mcp.ts`）：MCP 客户端只实现了 Streamable HTTP（单 POST JSON-RPC），受 SealDice goja 沙箱限制，存在以下能力缺口。当运行环境具备对应能力（AbortController/流式读取、可拉起子进程，或通过 aiplugin4-backends 代理中转）后，按下表逐项落地：

| 缺口 | 现状 | 环境适配后的修改 |
| --- | --- | --- |
| 请求超时 | goja 无 AbortController，`fetch` 无法设置超时，服务器挂起会一直阻塞工具调用 | `mcpRequest` 增加超时控制（建议默认 10s、可配置），超时返回可读错误；底层请求无法取消时丢弃等待结果并提示 |
| SSE 传输 | 仅支持 Streamable HTTP POST；`type=sse` 的服务器在配置解析时跳过 | 实现 SSE 传输：GET 打开事件流、按 `endpoint` 事件取得 POST 地址、携带 `Mcp-Session-Id`、处理断线重连；或在后端代理中做 SSE→Streamable HTTP 转换 |
| stdio 服务器 | `command` 服务器需要拉起子进程，配置解析时跳过 | 通过配套后端（aiplugin4-backends）代理拉起进程：stdin/stdout 走 JSON-RPC 换行协议，管理进程生命周期与异常重启；插件侧只暴露 Streamable HTTP 地址 |
| OAuth 鉴权 | 仅支持静态 Bearer/自定义 headers | 实现 MCP OAuth 发现与授权流程（protected-resource well-known + 授权码/PKCE），或文档化手动换取 token 后填入 headers 的配置方式 |
| 协议版本协商 | `initialize` 硬编码 `protocolVersion: 2025-11-25` | 根据服务器返回的 `protocolVersion` 做能力协商与降级，支持服务器偏好版本 |
| 流式工具结果 | `tools/call` 只解析非流式 JSON / 单帧 SSE | 解析流式 SSE 返回的多个 `content` 块（文本/资源/图片），按顺序拼接；处理 `progress` 通知 |
| 无状态模式 | 会话按 AI 会话分桶、LRU/TTL 回收已实现；未支持服务器声明 `stateless` 时跳过会话头 | 支持无状态模式（服务器声明 `stateless` 时不再发送/依赖会话头） |

已实现（勿再列为待办）：工具列表 60s TTL 缓存 + refresh 强制重拉、工具下线清理、会话按 AI 会话分桶 + 空闲/上限 LRU 回收、`mcp-browser` 回收前自动 `browser_close`、配置改动后按服务器名重建会话、`resources/list` + `resources/read`（`mcp_list_resources`/`mcp_read_resource` 工具按需读取，不进 system prompt）、`prompts/list` + `prompts/get`（`.ai mcp prompt list|get` 手动触发，不自动注入）。

## 未接线的配置（已注册但无消费点）

| 配置 | 现状 | 待办 |
| --- | --- | --- |
| `心智模型定时刷新间隔` | v3 已删除该配置；auto refresh 由 `agent/memory_scheduler` 的 `mm_refresh` 任务驱动（巩固/seed/手动），并按 `心智模型刷新最小间隔`、watermark、失败冷却门控。 | 无 |

> 排查方法：`grep -rn "MEMORY_MM_TICK_INTERVAL" src/` 应无结果；旧配置键不再注册。

## 联网搜索：未实现 / 非目标

| 事项 | 说明 |
| --- | --- |
| 结果缓存/去重/二次 LLM 总结 | 本期不做；重复查询会重复计费 |
| WebUI 管理页 / `.ai web` 命令 | 本期不做；可先用 `.ai tool call web_search` 手工验证 |
| `min_interval` QPS 限速 | 未实现；DeepSeek 搜索是账号级 5 QPS，网关侧限速需自行处理 |
| 自建抓取的安全加固 | `web_fetch` 通用抓取暂未做 robots.txt / 拒绝私网 IP（SSRF）加固；接入自建抓取方言前需补 |
| 厂商托管搜索（server-side） | 属模型请求参数、不进联网 `providers`；与 `web_search` 同开有重复计费风险，应二选一 |

## 配置生成器（独立仓库 aiplugin4-config）的单一数据源问题

`vendor` 表 / 各用途请求 body / 模型命名分类白名单在插件与生成器之间仍是**两处手抄**，靠跨仓库联测的「超集不变量」守卫生效。彻底解法是把 schema/预设抽成共享数据包；在此之前，改插件侧预设或分类白名单时务必同步生成器并联测。

## 可选的进一步拆分（当前不阻塞）

| 项 | 说明 |
| --- | --- |
| `Image` 内存注册表 | `imageMap`/`save`/`get` 仍在 `resource/image.ts`：需构造 `Image` 且 media/task_queue、image_gc 直接增删该 map，外提会形成 `image ↔ image_registry` 构造环 |
| `memory/v2/engine.ts` 的 recall/embed 簇 | 约 730 行内仍含召回融合、向量回填、实体解析，可继续拆 `recall.ts` |
| `utils/string.ts` 868 行 | 消息段解析/格式化混合，可按「解析/格式化」再拆 |
| 依赖守卫增强 | 既有环内新增同层边、间接重连不可见（方案 §4.1 已知限制） |

## 上下文成本治理：已否决 / 明确不做（避免重复讨论）

- **学习式门禁（感知机/逻辑回归）**：用户明确不要，不排期。
- **余温预热缓存**：实现时判定无收益，不做。
- **`reply()` 每工具轮延迟写盘（B4）**：放弃——回复是关键路径，延迟写会丢 assistant 记录；且窗口移出已让 `session_<id>` 体积有上界。
- 原文库**只对「归档/窗口移出」写分片**，不做「每条消息一个 key」的全量原文库。

## 上下文成本治理：#163 已知残留（不阻塞发布，按需排期）

| 项 | 现状 | 待办 |
| --- | --- | --- |
| 同 anchor 跨轮合并改写已发送消息 | `mergeInjectionMessages`（`src/context/view/compile.ts:765`）把**同 slot** 的多个注入块合并成一条消息。若连续两轮 anchor 相同（例如"可见单元为空 ⇒ `lastSelectedSeq=0` 被夹紧到 `archivedThrough`"），第 2 轮的块会被合并进第 1 轮那条**已发送**消息 ⇒ `stats.prefixDrift` 报点、缓存前缀从该点起失效；冻结守卫按设计不覆盖增量区。不丢内容、不改语义，只损缓存命中 | 把「同 anchor 连续两轮不得合并已发送消息」写成不变量检查；或让 writer 在 `anchor <= 上次 anchor` 时按 `anchor = lastSentSeq` 单调递增 |
| `activeInjectTokens` 的单槽 memo 命中率低 | memo 键是「events 数组身份 + 水位」，但 `ContextStore.snapshot()` 每次 `events.slice()` 返回新数组 ⇒ 生产调用方（`compile.ts` / `archive_controller.ts` / `injection_writer.ts`）逐次 miss，实际只在单轮内重复问时生效 | 换成与数组身份无关的稳定键（「块数 + 最大 seq + 水位」，与 `activeIndexFor` 同款），否则这层 O(n) 重扫优化等于没做 |
| `Setting.validKeys` 是死代码 | `src/session/setting.ts` 的 `validKeys` 静态数组无人读取（revive 实际走 `validKeysMap`） | 删除或在 revive 里显式使用；改 `Setting` 字段时不要以为要同步它 |

## 发版遗留：4.31.0 的 SealRepo 发布待补（商店侧故障）

GitHub Release [v4.31.0](https://github.com/error2913/aiplugin4/releases/tag/v4.31.0) 已发布（本体 JS + 两个豹包，正文来自 `src/changelog/4.31.0.ts`），但 **SealRepo（`https://repo.sealdice.com/`）上的 `aiplugin4` / `aiplugin4-full` 4.31.0 仍未上传**。

- 现象：`release.yml` 的 `publish-sealrepo` job 在第 7 步 `Publish to SealRepo` 失败，只输出一行 `404 page not found`（两次尝试、两批 runner 都一样）。直接探测该域名：`/`、`/api/v1/user/me`、`/dice/api/store/info`、`/packages/` 全部 404 或超时，且 `npx sealpack login/whoami` 也无法认证 —— 不是 token 问题，是**商店服务整站不可用**（最近一次成功是 v4.30.1 / 2026-10-31）。
- 归因不在本仓库：URL 与 CLI 版本（`sealpack@0.1.2`，其内置默认值也是该域名）与 v4.30.1 发布时完全一致；`sealdice-core` 的 `dice/store.go` 里 `officialStoreBackendBaseURL` 至今仍写 `https://repo.sealdice.com`。
- 补发时机：商店恢复后重跑 `Actions → Build and Release → publish-sealrepo`（`github-release` 已不再依赖它，见 `AGENT.md`「发布流程」），或本地：

  ```bash
  npx sealpack token set <SEALPACK_TOKEN>
  npx sealpack publish sealpack     --create --server https://repo.sealdice.com/
  npx sealpack publish sealpack-full --create --server https://repo.sealdice.com/
  ```

  若届时该域名仍不通，先去海豹官方渠道确认新地址（`sealdice-core` 的 `officialStoreBackendBaseURL` 或海豹手册），再改 `.github/workflows/release.yml` 的 `SEALPACK_SERVER`。

