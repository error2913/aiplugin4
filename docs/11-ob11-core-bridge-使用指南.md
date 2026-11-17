# 11 - ob11-core-bridge 使用指南

`ob11-core-bridge` 是 aiplugin4 的配套后端（位于独立仓库 [aiplugin4-backends](https://github.com/error2913/aiplugin4-backends)），是一个**独立的 OB11 协议端**：SealDice 用一条普通的 OB11 正向 WebSocket 连上来，就得到一个稳定、持久的虚拟账号世界。插件通过 **`/plugin` WebSocket** 发 `core_command`，桥把指令包成一条虚拟消息事件投给核心，核心执行后把回复作为 action 回给桥、由桥记账，结果回给 AI。**不需要真实的 QQ 账号**，也不需要 NapCat / go-cqhttp / 测试模拟器之类的协议端。

- **不拦截、不注入、不出站**：桥自己就是那个协议端，`send_*` 天然由桥受理、天然不落地。
- **没有 relay 模式**：桥不做任何中转，也没有"协议端地址"这类配置。
- 扩展指令由插件本地直调扩展 `solve` 执行（`run_ext_command`），与桥无关。

## 为什么需要它

SealDice 的 JS 插件无法直接调用核心指令（`.ext`、`.help` 等）——核心指令没有公开的 JS 调用入口；扩展指令则可直接调用 `cmdMap[cmd].solve` 在插件内本地执行（`run_ext_command`）。核心执行指令的唯一入口是 `IMSession.ExecuteNew`，它需要一条消息，所以桥必须构造一条消息事件——但这条消息发在**桥自己的虚拟世界**里，外部不可见。链路：插件 `run_core_command` → 桥投影成虚拟 ID、投一条虚拟消息事件 → 核心执行 → 回复作为 `send_*_msg` action 回到桥（就地应答进账本）→ 桥把多条文本聚合回给调用方。

> 换句话说：构造消息这一步仍然存在（海豹架构决定），**消失的是"注入到别人的会话"**。

## 拓扑

```text
  SealDice  ──正向 WS──>  ws://<host>:<端口>   （任意路径，通常不带路径）
      │                        │
      │  action(get_login_info / send_group_msg / ...)
      │                        ▼
      │                  responder 就地应答 + 记账
      └── 收到虚拟消息事件 ──────┘

  aiplugin4 插件  ──正向 WS──>  /plugin   （hello / core_command / ping）
```

| 端点 | 用途 |
| --- | --- |
| 核心端（**不占用路径**） | SealDice 核心正向 WS，海豹**主动连接** `ws://<host>:<端口>`；不带路径最省事，`/`、`/core` 或任意自定义路径都等价接受 |
| `/plugin` | 插件控制 WS：`hello` 握手 / `core_command` / `ping` |
| `/healthz` | 健康检查，15 个字段（见下） |

默认监听 `0.0.0.0:46880`（可在启动器里改）。桥**不建立任何出站连接**——只有海豹与插件两个方向连进来。

## 部署

方式一（推荐）：`python launcher.py start ob11-core-bridge`，首次启动自动创建依赖并后台运行；也可以在启动器 WebUI（默认 `http://127.0.0.1:8910`）里安装、启动、改端口与 token。

方式二：进后端独立包目录执行 `npm install && npm start`。

## 配置项：只有三个

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `platform` | `QQ` | 桥自称的平台名（**仅桥侧展示**，见下节） |
| `virtual_self_id` | `10001` | 机器人号（可自定义） |
| `virtual_nickname` | `AI骰娘` | 机器人昵称 |

就这三项。**没有**「运行模式」、**没有**「协议端地址」、**没有**「默认虚拟群 / 默认私聊对象」、**没有**「机器人角色 / 群人数上限」——群与私聊对象是**惰性生成**的（第一次见到才分号），角色与人数上限是协议侧常量（`admin` / `200`）。

### 环境变量

单机部署**不需要手工设环境变量** —— 三个配置键都能在卡片「⚙ 配置」里填（保存后**重启该后端**生效）；端口、路径、`STATE_DIR`、`KEEPALIVE_MS` 由启动器或环境变量管理。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AIPLUGIN4_BACKEND_HOST` | `0.0.0.0` | 监听地址 |
| `AIPLUGIN4_BACKEND_PORT` | `46880` | 监听端口（由启动器「端口」输入框管理） |
| `AIPLUGIN4_BACKEND_TOKEN` | 空 | **核心端与插件端共用这一个 token**（启动器统一生成/注入）。留空=不校验 |
| `AIPLUGIN4_BRIDGE_PLATFORM` | `QQ` | 桥自称的平台名（**仅桥侧展示**） |
| `AIPLUGIN4_BRIDGE_VIRTUAL_SELF_ID` | `10001` | 机器人号（可自定义） |
| `AIPLUGIN4_BRIDGE_VIRTUAL_NICKNAME` | `AI骰娘` | 机器人昵称 |
| `AIPLUGIN4_BRIDGE_PLUGIN_PATH` | `/plugin` | 插件控制 WS 路径 |
| `AIPLUGIN4_BRIDGE_STATE_DIR` | `.state` | 虚拟世界落盘目录（映射表跨重启稳定；支持绝对路径） |
| `AIPLUGIN4_BRIDGE_KEEPALIVE_MS` | `30000` | 对核心的传输层 ping 间隔，连续 2 次无 pong（≈90s）才判死 |

> **token 只有一个**：`AIPLUGIN4_BACKEND_TOKEN` 就是启动器里那个后端 token（其他后端也用同一个变量）。海豹「连接」页与插件「核心桥Token」填同一个值即可。桥对 `Authorization: <裸 token>`（海豹的写法）与 `Authorization: Bearer <token>`、`?access_token=` 两种来源、两种形式都认；任一来源匹配即通过。
>
> **配置项的默认值是"开箱即用"，不是"只能这样"**：`platform` / 机器人号 / 昵称都面向用户可填，且机器人号**空值算非法配置**（不会静默回退默认值）。启动自检不通过时后端**不会 listen**，日志会指出是哪一类非法（空值 / 非数字 / ≤0 / 命中 QQ 机器人号段）。改完重启即可。
>
> 群和用户**没有**默认对象，所以 `send_group_msg` 不带 `group_id`、`send_private_msg` 不带 `user_id` 一律回 `1400`——不存在可以兜底的凭空群号。

## SealDice 侧配置

**你只需要记住端口（默认 `46880`，在启动器里改）；海豹面板「目标地址」填 `ws://127.0.0.1:<端口>` 就行，不用带任何路径（SealDice 的 OB11 适配器不会替你补 `ws://`）。**

1. 打开海豹 WebUI →「连接」→ 新增 **OB11 正向 WebSocket**；
2. 「目标地址」填 `ws://127.0.0.1:<端口>`（端口取启动器里的实际值，**不带路径**；桥不按路径认核心端，末尾多写 `/core` 之类也照常工作）；
3. 启动器里这个后端配了 token 时，海豹「Token」这一格填同一个值（裸值即可）；
4. 保存后海豹会以虚拟账号 `QQ:<virtual_self_id>`（默认 `10001`）上线。**群和私聊对象不需要预置**：海豹遇到哪个群、哪个人，桥就按需分配一个稳定号；
5. **必须做一步**：把虚拟号加进 `serve.yaml` 的 `DiceMasters`，条目写 `QQ:<virtual_self_id>`（默认即 `QQ:10001`）。否则 `MasterCheck` 永不命中、`PrivilegeLevel` 上不到 100，`.master` 相关与需要 ownership 的指令会全部降级。

虚拟号的取值来源有三处、口径一致：桥启动日志的 `QQ:10001（AI骰娘）已就绪`、`/healthz` 的 `virtualSelfId`、`/plugin` 的 `hello_result.virtualSelfId`。

> **不要**把端口单独填进这一格（只填 `46880` 这类默认端口值）：OB11 适配器不做 scheme 补全，会变成 `NewClient("46880")`，表现为**静默 `connect_fail`**。但**路径可以完全不写**——桥把除 `/plugin`、`/healthz` 之外的所有连接都当核心端。
>
> 端口的四条来源与优先级：`.runtime.json` 的 `config.<name>.port` → 旧版 `ports` 字段 → 注册表里的 `port`（默认 `46880`）→ 海豹面板地址里你手抄的那个端口。前三者由启动器统一管理，**第四者不会自动同步**：改端口后要重启后端，并同步改海豹面板那一格。可用 `curl http://127.0.0.1:<端口>/healthz` 的 `corePort` 核对实际生效端口。

## 平台名、机器人号与昵称

三项都面向用户可填，默认值只用于开箱即用。改任意一项都要**重启后端**（启动器只在启动时注入环境变量）。

**一条物理约束必须先讲清**：`platform` 只在**桥侧**生效（桥的日志、`/healthz.platform`、`hello_result.platform`，以及桥内部展示用的 `QQ:123` / `QQ-Group:456` 前缀）。海豹核心把 `QQ` 写死在适配器里（`ep.Platform == "QQ"` 才会服务），并把端点 ID 固定格式化为 `QQ:<id>`、群 ID 为 `QQ-Group:<id>` —— 所以**把 `platform` 改成非 `QQ` 不会让海豹面板变成别的平台**，面板永远显示 QQ、ID 前缀永远是 `QQ:`。想让海豹侧显示成别的平台只能改 `sealdice-core`，本期不做。桥在 `platform` 非 `QQ` 时会在启动日志里 warn 一行说明，但**不会拒绝启动**。

机器人号会被海豹当成真实账号使用，因此有硬约束：必须是十进制正整数；不能落在 QQ 官方机器人号段（`3328144510`、`66600000`、`2854196301–2854216399`、`3889000000–3889999999`、`4010000000–4019999999`），否则海豹会把它判成"官方机器人自己"。非法 → **拒绝启动并报明确原因**（不会静默回退默认值）。改机器人号等于换了张脸：海豹侧以 ID 为键的历史状态（`.master`、群配置、玩家卡、`.log`/`.pc`/`.deck`、权限）会对不上，属预期行为。

## 插件侧接入（aiplugin4）

在 aiplugin4「后端 → 后端配置」的 `backends.ob11-core-bridge` 中填写（也可直接点 aiplugin4-backends WebUI 的「📋 复制后端配置」整段粘贴）：

- **url**：默认 `ws://127.0.0.1:46880/plugin`（完整 URL；对应后端端口与 `/plugin` 路径，按实际地址填写）
- **token**（可选）：与后端那个 `AIPLUGIN4_BACKEND_TOKEN` 同一个值（插件以 `access_token` 查询参数传入）

> **这一格必须填完整 URL**（`ws://` 开头）。插件对 `url` 有格式校验（`/^wss?:\/\/\S+$/i`），填纯端口会让**整份后端配置**校验失败并回退出厂默认——所有后端一起失效。端口不在这里填，它在启动器的「端口」输入框里。

连上后插件先发 `hello`，桥回 `hello_result`（`mode` / `platform` / `corePort` / `virtualSelfId` / `virtualNickname` / `protocolVersion` / `capabilities` / `bridgeVersion`）。插件据此决定报文形态：`mode=standalone` 时 `core_command.payload` 额外带 `source`（**真实** ID，含 `endpointId`/`messageType`/`groupId`/`userId`/`groupName`/`userRole`），由桥投影成虚拟 ID；`hello` 3 秒无响应的老桥则按老语义发真实 `target`。

## 工具与参数

`run_ext_command` 与 `run_core_command` 均由插件本地注册为 AI 工具（敏感工具，执行会显著记录）。`run_ext_command` 在插件内直调扩展 `solve`，不依赖桥；`run_core_command` 通过 `/plugin` WebSocket 直连 `ob11-core-bridge`，在桥的虚拟端点上产生一条指令消息并收集核心的回复，需启动 `ob11-core-bridge` 并在「后端 → 后端配置」的 `backends.ob11-core-bridge` 填地址。

**`run_ext_command`（扩展指令）**：`action=list` 按 `kind`（builtin / non_builtin / all）列出可调用扩展指令并附已知扩展名；`action=call` 执行指令，`extension` + `command` 写 `扩展名|指令名`（`command` 也可直接填 `扩展名|指令名`），`args` 按顺序传参。本地执行：直接调用扩展 `cmdMap[cmd].solve`（构造全新 `CmdArgs`，不要求会话先出现 `.r`），复用多消息收集器收集多条回复；核心内置扩展（fun / story / coc7 / deck / dnd5e / exp / log / reply，已硬编码，**无需维护内置扩展列表**）与第三方扩展均可调用，仍受「可调用指令白名单」约束。

**`run_core_command`（核心指令）**：`action=list` 列出白名单中的核心指令；`action=call` 执行指令（如 `ext`、`help`，也支持 `core|ext` 写法）。结构化模式传 `command` 和可选 `args`，插件按当前「指令前缀」组装核心原始消息；原始消息模式传 `raw_message` 原样投给核心（不能与 `command`/`args` 同时使用）。

触发对象与 @ 对象：两种工具都支持 `trigger` / `at`。前者写入指令消息的 `user_id` / `sender.user_id`（先投影为虚拟 ID），后者写入消息的 at 段；省略前者时沿用当前对话用户。私聊传 `at` 会返回提示，不会伪造私聊 @。

| 参数 | 适用 | 说明 |
| --- | --- | --- |
| `trigger` | 两者 | 指定指令消息发送者/触发对象用户 ID；默认当前对话用户 |
| `at` | 两者 | 指定消息中 @ 的用户 ID 列表（字符串数组）；仅群聊 |
| `forward` | 仅 `run_core_command` | 收下但忽略（没有真实协议端可转发） |
| `captureMode` | 仅 `run_core_command` | `reply_only` / `lane`；`lane` 是唯一可靠模式（插件默认即 `lane`） |
| `maxMessages` | 两者 | 最多收集消息数（1–50；ext 默认 20，core 默认 50） |
| `settleMs` | 两者 | 收到消息后空闲多少毫秒无新消息即结束（0–10000；ext 默认 400，core 默认 500） |
| `timeoutMs` | 两者 | 最长等待毫秒数（100–120000，默认 10000） |

> `run_ext_command` 本地执行时直接复用会话监听器的 `waitFor(timeoutMs, settleMs, maxMessages)` 收集扩展发出的多条消息；`run_core_command` 则把这些参数传给桥的 `capture` 策略。

### 返回结果

| 字段 | 说明 |
| --- | --- |
| `ok` | 是否成功 |
| `messages` | 收集到的消息：`messageId` / `action` / `segments` / `text` / `source` / `forwarded` / `intercepted` |
| `completedBy` | 结束方式：`idle`（空闲窗口）/ `max_messages`（达到上限）/ `timeout` / `disconnect` |
| `mode` | `standalone`（桥的模式常量，用于插件判断报文形态） |
| `deliveredCount` | 真正记账/投递给本次调用的消息数（等于 `messages.length`） |
| `virtualTarget` | 本次调用投影出的虚拟目标 `{selfId, messageType, groupId?, userId?}` |
| `ambiguous` | 恒 `false`（只有一个消息来源，不可能歧义） |
| `forwardedCount` | 恒 `0`（"转发到协议端"这个动作不存在） |
| `interceptedCount` | 恒 `0`（消息由桥全权受理，没有"从协议端手里抢下来"这回事；真实条数看 `deliveredCount`） |
| `error` | 失败原因（如核心未连接、target 缺少群/私聊 id） |

> 上表是 `run_core_command` 经核心桥 WebSocket 返回的结果结构；`run_ext_command` 不经过核心桥，本地执行直接返回收集到的消息文本，异常时返回错误说明。老字段（`ambiguous`/`forwardedCount`/`interceptedCount`）保留是为兼容旧插件，插件渲染时改用 `deliveredCount`。

## 指令白名单与指令前缀

「可调用指令白名单」每框一条，格式 `扩展名|指令名/别名1/别名2`，同一元素内的别名用 `/` 分隔：

- 内置扩展已硬编码，**无需填写扩展列表**；第三方扩展写实际扩展名；核心指令的扩展名统一写 **`core`**（如 `core|help`）
- `core|ext` 是扩展发现入口，**无需加入白名单**：`run_core_command` 执行 `command=ext`（即核心 `.ext`）即可查看核心当前全部扩展名称
- 开启「是否允许调用所有指令」后忽略扩展指令白名单（核心指令仍受 `run_core_command` 白名单约束）
- 插件默认值已按当前 SealDice 源码同步全部核心命令、内置扩展命令及别名；调用帮助由默认知识库提供（「知识库」页签：核心指令、扩展指令；OB11 依赖说明见 ob11-api 知识库，仅 QQ 平台可见）。升级 SealDice 后新增命令需手动补白名单或等插件默认值更新

「工具 → 指令前缀」配置，默认 `.`。海豹核心通常用 `.`；如果核心改成其他前缀（如 `/`），请同步修改该配置，否则投给核心的虚拟消息不会被识别为指令。

## 捕获语义

没有真实协议端，"拦截 / 转发"这组概念本身消失：

- **`capture.forward` 收下但忽略**：不报错、插件无感，但不会有任何"转发到协议端"的动作。
- **非 action 帧一律丢弃**：核心发来的帧只有 `action` 有用，`notice`/`request`/`meta_event`/裸事件都被丢掉（只打 debug 日志），所以 `messages[].source` **只可能是 `action`**，`source:'event'` 不可能出现。
- **`lane` 是唯一可靠模式**：按「虚拟 `self_id` + 群/私聊 + 对方 id」捕获该会话内的消息。**`reply_only` 通常捕获为空**（依赖被捕获消息带 `reply` 段且引用本次投递的虚拟 `message_id`，而海豹默认不引用回复）；桥接受该参数，捕获不到时按 `timeout` 结束并给出提示，不报错。
- 收到第一条消息后进入 `settleMs` 空闲窗口；达到 `maxMessages` 或 `timeoutMs` 结束。
- 核心回复一律进 invocation 账本随结果返回，**不推回核心**（禁止回环）；`get_msg` / `delete_msg` 能查到、删掉本次应用发出的每一条消息。

## 并发与消息混淆

- 同一 lane 的调用**串行**执行（队列），不同 lane **并行**，避免同一群同时投递多条指令时响应混在一起。
- 核心不会向桥推事件、桥也只有一个核心连接，**`ambiguous` 恒为 `false`**，不存在"无法区分并发消息"的问题。

## 多核心

**一个桥只服务一个核心**：已是 `1` 条核心连接时，第二条连接会被 `1013` 拒绝，原因文本为 `仅支持单个 SealDice 核心`。需要多个账号请启动多个桥实例（各占一个端口）。`run_ext_command` 在插件内本地直调当前实例的扩展 `solve`，不涉及核心路由。

## `/healthz`

`curl http://127.0.0.1:<端口>/healthz` 返回 **15 个字段**：

| 字段 | 说明 |
| --- | --- |
| `ok` | 恒 `true` |
| `coreConnected` / `coreClients` | 有核心连接时 `true` / `1` |
| `pluginConnected` / `pluginClients` | 插件连上时 `true` / 数量 |
| `mode` | 恒 `"standalone"`（对插件报文的兼容常量） |
| `platform` | 配置的平台名 |
| `corePort` | 实际监听端口 |
| `virtualSelfId` | 机器人号（写进 `DiceMasters` 的那个） |
| `virtualNickname` | 机器人昵称 |
| `actionCount` / `eventCount` / `ledgerSize` | 已应答 action 数 / 已投递事件数 / 账本条数（上限 2000，FIFO） |
| `legacyTarget` | 收到过不带 `source` 的老插件报文则为 `true` |
| `tokenRequired` | 是否启用了 token 校验 |

> `legacyTarget: true` 说明有老插件（4.30.1 及更早，未实现 `hello`/`source` 投影）在用真实 ID 降级运行，应升级插件。

## 排障

| 现象 | 检查 |
| --- | --- |
| 海豹面板显示端点离线 / 日志 `connect_fail` | 最常见原因：**面板「目标地址」里填的是纯端口**（如 `46880`）。必须填完整 URL `ws://127.0.0.1:<端口>`（默认端口 `46880`，在启动器里改；改了端口要同步改这一格；路径不用写）。再核对桥是否已启动、端口是否被占用 |
| `run_core_command` 不可用 / 报核心桥未连接 | `backends.ob11-core-bridge.url` 是否为**完整 URL**（默认 `ws://127.0.0.1:46880/plugin`）、`ob11-core-bridge` 是否已启动。填成纯端口会让整份后端配置校验失败回退出厂默认 |
| 海豹连上了但指令全失效 | 看 `/healthz` 的 `coreConnected`；看桥日志是否报 `仅支持单个 SealDice 核心`（已有别的核心在连） |
| 管理指令（`.master` / `.send to` 等）不可用、`PrivilegeLevel` 上不到 100 | `DiceMasters` 里是否加了 `QQ:<virtualSelfId>`（默认 `QQ:10001`）；取值看启动日志的 `QQ:...（...）已就绪` 或 `/healthz.virtualSelfId` |
| `run_ext_command` 执行失败 / 无响应 | 扩展是否已安装、指令名是否正确（`扩展名|指令名`）、是否在白名单、指令本身是否抛异常；与桥无关 |
| 执行无响应 / 超时 | 核心是否已连上桥（看桥日志与 `/healthz.coreConnected`）、指令前缀是否正确、目标群/私聊 id 是否正确、指令是否在白名单 |
| 改了机器人号/平台名"没生效" | `platform` / `virtual_self_id` / `virtual_nickname` 全部**只在启动时注入**，改完必须**重启该后端**；改机器人号还会让海豹侧旧状态对不上（预期行为） |
| `platform` 改了但海豹面板还是 QQ | 设计如此：`platform` 只影响桥侧日志 / `/healthz` / `hello_result`，海豹核心把 `QQ` 写死了 |
| 鉴权失败 / 连不上但无日志 | 核对海豹「连接」页的 token、插件「核心桥Token」、启动器里该后端的 token 三者是否一致（只有一个 token，不是两个）。桥会打印"哪个端 / token 不匹配 / 来源 IP"的 warn（不回显明文） |
| `send_group_msg` 报 `1400` | 群号/用户号是必填的：虚拟世界里没有默认群、没有默认私聊对象，缺号就是残缺调用 |
