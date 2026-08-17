# 11 - ob11-core-bridge 使用指南

`ob11-core-bridge` 是 aiplugin4 的配套中转后端（位于独立仓库 [aiplugin4-backends](https://github.com/error2913/aiplugin4-backends)）。SealDice 以 OB11 正向 WebSocket 客户端身份主动连到中间件，中间件再**出站主动连接** OB11 协议端，插件通过 MCP 调用中间件：**注入假消息 → 执行核心指令 → 收集 bot 响应**，并把结果回传给 AI。扩展指令由插件本地直调扩展 `solve` 执行（`run_ext_command`），不经过中间件。

## 为什么需要它

SealDice 的 JS 插件无法直接调用核心指令（`.ext`、`.help` 等）——核心指令没有公开的 JS 调用入口；扩展指令则可直接调用 `cmdMap[cmd].solve` 在插件内本地执行（`run_ext_command`）。中间件把 SealDice 当成一个普通 OB11 正向 WS 客户端接入，插件端通过 MCP 发起 `run_core_command`，中间件向核心 WS 注入一条“假消息”（`指令前缀 + 指令文本`），再监听核心为响应这条消息而发出的 `send_*_msg` Action 与消息事件，把多消息结果聚合后返回给调用方。

## 拓扑

```text
SealDice（OB11 正向 WS 客户端）  <──>  /core（或 /core/ws）
OB11 协议端 / 模拟器              <──  中间件启动时出站主动连接
aiplugin4 插件（MCP 客户端）      <──>  /mcp
```

| 端点 | 用途 |
| --- | --- |
| `/core`、`/core/ws` | SealDice 核心正向 WS，海豹**主动连接**本端点 |
| 协议端（出站） | 中间件作为 WS **客户端**，启动时主动连接你在配置里填写的协议端地址（带指数退避重连） |
| `/mcp` | Streamable HTTP MCP 端点，提供 `run_core_command`（核心指令注入）；扩展指令由插件本地执行 |
| `/healthz` | 健康检查 |

默认监听 `0.0.0.0:46880`。海豹**主动连入** `/core`；协议端由中间件**出站主动连接**（不支持反向 WS，协议端无需也无法连入中间件）。

## 部署

### 方式一：launcher 一键管理（推荐）

```bash
python launcher.py start ob11-core-bridge
```

首次启动自动创建依赖并后台运行；也可以在 WebUI（默认 `http://127.0.0.1:8910`）里安装、启动、改端口与 token。

### 方式二：手动运行

```bash
cd ob11-core-bridge   # 后端独立包目录
npm install
npm start
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AIPLUGIN4_BACKEND_HOST` | `0.0.0.0` | 监听地址 |
| `AIPLUGIN4_BACKEND_PORT` | `46880` | 监听端口 |
| `AIPLUGIN4_BRIDGE_CORE_PATH` | `/core` | 核心 WS 路径（默认同时接受 `/core/ws`） |
| `AIPLUGIN4_BRIDGE_CORE_PATHS` | `/core,/core/ws` | 核心 WS 路径集合（逗号分隔，覆盖默认） |
| `AIPLUGIN4_BRIDGE_PROTOCOL_URL` | 空 | 协议端 WS 地址（中间件启动时主动连接；WebUI「⚙ 配置」可填，重启生效） |
| `AIPLUGIN4_BRIDGE_MCP_PATH` | `/mcp` | MCP Streamable HTTP 路径 |
| `AIPLUGIN4_BRIDGE_TOKEN` | 空 | MCP 鉴权 token |
| `AIPLUGIN4_BRIDGE_CORE_TOKEN` | 跟随 `AIPLUGIN4_BRIDGE_TOKEN` | 核心端（SealDice 连接）token |
| `AIPLUGIN4_BRIDGE_PROTOCOL_TOKEN` | 空 | 协议端 token（可选；同时以 access_token 查询参数与 Bearer 头发送） |

> 注意：这里**没有 `CORE_URL`**。旧版“插件连接中间件、中间件反向连海豹”的方案已移除，现在是海豹主动连中间件。

## SealDice 侧配置

在 SealDice 面板「连接」中新增 **OB11 正向 WebSocket**，目标地址填：

```text
ws://127.0.0.1:46880/core
```

若中间件设置了 token，把 access_token 填 `AIPLUGIN4_BRIDGE_CORE_TOKEN`（未单独设置时用 `AIPLUGIN4_BRIDGE_TOKEN`）。

## 协议端侧配置

中间件在**启动时**作为 WS 客户端主动连接 OB11 协议端（NapCat / LLOneBot / 测试模拟器等）的 WS 地址，并在核心与协议端之间原样转发 OB11 JSON。协议端无需配置任何指向中间件的连接（不支持反向 WS）。

在 aiplugin4「后端」页的 ob11-core-bridge 卡片「⚙ 配置」中填写：

- **协议端 WebSocket 地址**：如 `ws://127.0.0.1:6700`（对应环境变量 `AIPLUGIN4_BRIDGE_PROTOCOL_URL`）
- **协议端 token**（可选）：会同时以 `access_token` 查询参数和 `Authorization: Bearer` 头发送（对应 `AIPLUGIN4_BRIDGE_PROTOCOL_TOKEN`）

> 配置保存后需**重启该后端**才生效。协议端未配置或不可达时，中间件会按指数退避（1s 起、上限 30s）持续重试，连上后自动恢复转发；期间核心发来的 API 请求立即返回 `status: failed`，不会静默等待超时。
>
> 协议端不是必需的：仅做“注入指令 + 收集响应”时可以不配协议端。默认 `forward=false` 会拦截核心发出的 Action，即使没有协议端也不会失败。

## 插件侧接入（aiplugin4）

1. 打开「工具 → 是否启用MCP」总开关。
2. 在「工具 → MCP服务器配置」中确认或添加 `ob11-core-bridge`（默认配置已包含）：

```json
{
  "mcpServers": {
    "ob11-core-bridge": {
      "type": "http",
      "url": "http://127.0.0.1:46880/mcp",
      "tools": {
        "run_ext_command": { "hidden": true },
        "run_core_command": {
          "exposeAs": "run_core_command",
          "adapter": "core_bridge_core"
        }
      }
    }
  }
}
```

设置 token 时补充请求头（或使用 `token` 简写字段自动生成 Bearer 头）：

```json
"ob11-core-bridge": {
  "type": "http",
  "url": "http://127.0.0.1:46880/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

3. 按需配置「可调用指令白名单」与「指令前缀」。`tools` 适配块会把远端 `run_core_command` 暴露为同名 AI 工具并套用核心桥适配器；若手写配置时省略该块，`run_core_command` 会按通用规则注册为 `ob11-core-bridge_run_core_command`。`run_ext_command` 在插件内**本地直接执行扩展指令**，无需中间件；`run_core_command` 经 MCP 调用中间件执行核心指令。

## 工具与参数

`run_ext_command` 由插件本地注册为 AI 工具（敏感工具，执行会显著记录），在插件内直调扩展 `solve`，不依赖中间件；`run_core_command` 由 MCP 同步注册（默认 `tools` 适配暴露同名工具，同样为敏感工具），经中间件 MCP 注入假消息执行核心指令，需启动 `ob11-core-bridge` 并开启「是否启用MCP」。

### run_ext_command — 扩展指令

- `action=list`：按 `kind`（builtin / non_builtin / all）列出可调用扩展指令，并附当前已知扩展名
- `action=call`：执行扩展指令
- `extension` + `command`：`扩展名|指令名`；`command` 也支持直接填 `扩展名|指令名`
- `args`：指令参数，按顺序

本地执行：直接调用扩展 `cmdMap[cmd].solve`（构造全新 `CmdArgs`，不要求会话先出现 `.r`），并复用多消息收集器收集扩展发出的多条回复。无需 MCP/中间件；核心内置扩展与第三方扩展均可调用，仍受「可调用指令白名单」约束。

扩展分为两类：
- `builtin`：fun / story / coc7 / deck / dnd5e / exp / log / reply —— 已硬编码在插件里，**无需在配置中维护内置扩展列表**
- `non_builtin`：第三方扩展及本插件

### run_core_command — 核心指令

- `action=list`：列出白名单中的核心指令
- `action=call`：执行核心指令（如 `ext`、`help`；也支持 `core|ext` 写法）

### 参数

| 参数 | 适用 | 说明 |
| --- | --- | --- |
| `forward` | 仅 `run_core_command` | 是否把捕获到的核心发送消息继续转发给协议端，默认 `false`（拦截） |
| `captureMode` | 仅 `run_core_command` | `reply_only` / `lane`；`forward=true` 且要捕获协议端产生的 bot 回复时建议用 `lane` |
| `maxMessages` | 两者 | 最多收集消息数（1–50；ext 默认 20，core 默认 50） |
| `settleMs` | 两者 | 收到消息后空闲多少毫秒无新消息即结束（0–10000；ext 默认 400，core 默认 500） |
| `timeoutMs` | 两者 | 最长等待毫秒数（100–120000，默认 10000） |

> `run_ext_command` 本地执行时直接复用会话监听器的 `waitFor(timeoutMs, settleMs, maxMessages)` 收集扩展发出的多条消息；`run_core_command` 则把这些参数传给中间件的 `capture` 策略。

### 返回结果

| 字段 | 说明 |
| --- | --- |
| `ok` | 是否成功 |
| `messages` | 收集到的消息：`messageId` / `action` / `segments` / `text` / `source`（action/event）/ `forwarded` / `intercepted` |
| `completedBy` | 结束方式：`idle`（空闲窗口）/ `max_messages`（达到上限）/ `timeout` / `disconnect` |
| `ambiguous` | 是否因无法区分并发消息而标记歧义 |
| `forwardedCount` / `interceptedCount` | 转发 / 拦截计数 |
| `error` | 失败原因（如核心未连接、target 缺少群/私聊 id） |

> 上表是 `run_core_command` 经 MCP 返回的结果结构；`run_ext_command` 本地执行直接返回收集到的消息文本，异常时返回错误说明。

## 指令白名单

「可调用指令白名单」每行一条，格式 `扩展名|指令名`：

- 内置扩展已硬编码，**无需填写扩展列表**；第三方扩展写实际扩展名
- 核心指令的扩展名统一写 **`core`**（如 `core|help`）
- `core|ext` 是扩展发现入口，**无需加入白名单**：`run_core_command` 执行 `command=ext`（即核心 `.ext`）即可查看核心当前全部扩展名称
- 开启「是否允许调用所有指令」后忽略扩展指令白名单（核心指令仍受 `run_core_command` 白名单约束）

## 指令前缀

「工具 → 指令前缀」配置，默认 `.`。海豹核心通常用 `.` 作为指令前缀；如果核心改成其他前缀（如 `/`），请同步修改该配置，否则注入的假消息不会被核心识别为指令。

## 捕获与转发语义

- `forward=false`（默认）：捕获核心发出的 `send_*_msg` Action / 消息事件后**拦截**，不送到协议端；仍向核心返回 Action 成功响应，避免核心重试或阻塞。适合“AI 内部执行指令、不打扰群聊”的场景。
- `forward=true`：捕获后**继续转发**到协议端，并把协议端 API 响应按 `echo` 路由回核心；如需收集协议端产生的 bot 消息，`captureMode` 用 `lane`。
- `reply_only`：只收集带 reply 引用（指向注入消息的虚拟 message_id）的响应，最精准；协议端不生成 reply 引用时可能收集不到，此时标记 `ambiguous=true`。
- `lane`：按 `self_id + 群/私聊 + 对方 id` 捕获该会话内的 bot 消息，适合没有 reply 引用的场景。
- 收到第一条消息后进入 `settleMs` 空闲窗口；达到 `maxMessages` 或 `timeoutMs` 结束。

## 并发与消息混淆

- 同一 lane 的调用**串行**执行（队列），不同 lane **并行**，避免同一群同时注入多条指令时响应混在一起。
- 纯 OB11 没有标准 trace_id，中间件无法从 Action 本身区分“本次命令的响应”与“外部并发发送”，极端并发下可能返回 `ambiguous=true`。业务侧建议：短 `settleMs` + lane 串行 + 唯一目标（`selfId` / `messageType` / `groupId` / `userId`）来降低混淆。

## 多核心

多个海豹核心可同时连接中间件：核心连接后上报的 `self_id` 用于路由，`run_core_command` 的调用与事件按 `self_id` 区分，插件端从当前消息上下文自动取 `selfId` 填入 `target`。`run_ext_command` 在插件内本地直调当前实例的扩展 `solve`，不涉及多核心路由。

## 排障

| 现象 | 检查 |
| --- | --- |
| `run_core_command` 不可用 / 报 MCP 服务器未配置 | 「是否启用MCP」总开关、MCP服务器配置中的服务器名与 url、`tools` 适配块是否保留了 `run_core_command` |
| `run_ext_command` 执行失败 / 无响应 | 扩展是否已安装、指令名是否正确（`扩展名|指令名`）、是否在白名单、指令本身是否抛异常；与中间件无关 |
| 执行无响应 / 超时 | SealDice 是否已连上 `/core`（看中间件日志）、指令前缀是否正确、目标群/私聊 id 是否正确、指令是否在白名单 |
| 返回 `ambiguous=true` | 同 lane 并发或缺少 reply 引用；调整 `captureMode` / `settleMs` |
| 鉴权失败 | 核对 core token / protocol token / MCP headers 与中间件 token 一致 |
| 提示核心 WS 未连接 | 检查 SealDice「连接」里的 OB11 正向 WS 是否指向 `/core` 且未报错 |
