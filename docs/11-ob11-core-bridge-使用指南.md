# 11 - ob11-core-bridge 使用指南

`ob11-core-bridge` 是 aiplugin4 的配套后端（位于独立仓库 [aiplugin4-backends](https://github.com/error2913/aiplugin4-backends)），默认形态是一个**独立的 OB11 协议端**：SealDice 用一条普通的 OB11 正向 WebSocket 连上来，就得到一个稳定、持久的虚拟账号 / 群 / 用户世界。插件通过 **`/plugin` WebSocket** 发 `core_command`，桥把指令包成一条虚拟消息事件投给核心，核心执行后把回复作为 action 回给桥、由桥记账，结果回给 AI。**不需要真实的 QQ 账号**，也不需要 NapCat / go-cqhttp / 测试模拟器之类的协议端。

- **不再拦截、不再向任何真实协议端注入消息**：桥自己就是那个协议端，`send_*` 天然由桥受理、天然不落地。
- 老版本的双连接 relay 模式（1.1.x）**完整保留**：卡片里填了「协议端地址」就自动进 relay，报文与行为逐字不变。
- 扩展指令由插件本地直调扩展 `solve` 执行（`run_ext_command`），与桥无关。

## 为什么需要它

SealDice 的 JS 插件无法直接调用核心指令（`.ext`、`.help` 等）——核心指令没有公开的 JS 调用入口；扩展指令则可直接调用 `cmdMap[cmd].solve` 在插件内本地执行（`run_ext_command`）。核心执行指令的唯一入口是 `IMSession.ExecuteNew`，它需要一条消息，所以桥必须构造一条消息事件——但这条消息发在**桥自己的虚拟世界**里，外部不可见。链路：插件 `run_core_command` → 桥投影成虚拟 ID、投一条虚拟消息事件 → 核心执行 → 回复作为 `send_*_msg` action 回到桥（就地应答进账本）→ 桥把多条文本聚合回给调用方。

> 换句话说：从"往真实 QQ 里塞假人"变成"自己开一个只有自己的虚拟 QQ"。构造消息这一步仍然存在（海豹架构决定），**消失的是"注入到别人的会话"**。

## 两种模式

| | `standalone`（默认） | `relay`（1.1.x 兼容） |
| --- | --- | --- |
| 触发条件 | 未填协议端地址 | 填了 `protocol_url`，或显式 `mode=relay` |
| 出站连接 | **零** | 启动即连协议端，指数退避重连 |
| 海豹连接数 | **1 条**（第二条被 `1013` 拒绝） | 1 条（可多核心，按 `self_id` 路由） |
| OB11 action | 全部**本地应答**（23 个） | 转发给协议端，`echo` 回程路由 |
| 实时事件 | 桥侧**不产生**（只对投递的消息回 action） | 协议端事件丢弃并计数 |
| 消息 ID | 虚拟世界统一发号，账本可查 `get_msg` | 原样透传 |

模式判别顺序：`AIPLUGIN4_BRIDGE_MODE` 显式取 `relay`/`standalone` → 否则看 `AIPLUGIN4_BRIDGE_PROTOCOL_URL` 是否为空。**一般不用填 `mode`。**

## 拓扑

```text
standalone（默认）
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
| 核心端（**不占用路径**） | SealDice 核心正向 WS，海豹**主动连接** `ws://<host>:<端口>`；不带路径最省事，`/`、`/core`、`/core/ws` 或任意自定义路径都等价接受 |
| `/plugin` | 插件控制 WS：`hello` 握手 / `core_command` / `ping` |
| `/healthz` | 健康检查，16 个字段（见下） |
| 协议端（出站，**仅 relay**） | 桥作为 WS **客户端**主动连接你在配置里填写的协议端地址 |

默认监听 `0.0.0.0:46880`（`46880` 是默认端口，可在启动器里改）。standalone 下桥**不建立任何出站连接**；relay 下由桥出站连接协议端（不支持反向 WS，协议端无需也无法连入桥）。

## 部署

方式一（推荐）：`python launcher.py start ob11-core-bridge`，首次启动自动创建依赖并后台运行；也可以在启动器 WebUI（默认 `http://127.0.0.1:8910`）里安装、启动、改端口与 token。

方式二：进后端独立包目录执行 `npm install && npm start`。

### 环境变量

单机部署**不需要手工设环境变量** —— 表中的 `MODE` / `PLATFORM` / `VIRTUAL_*` / `CORE_TOKEN` / `PLUGIN_TOKEN` / `PROTOCOL_*` 共 13 项都有同名 `config` 键，直接在卡片「⚙ 配置」里填（保存后**重启该后端**生效）；端口、路径、`STATE_DIR`、`KEEPALIVE_MS` 不在这 13 项里，分别由启动器或环境变量管理。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AIPLUGIN4_BACKEND_HOST` | `0.0.0.0` | 监听地址 |
| `AIPLUGIN4_BACKEND_PORT` | `46880`（默认端口，由启动器「端口」输入框管理） | 监听端口 |
| `AIPLUGIN4_BRIDGE_MODE` | 空 | `relay` / `standalone`；留空=自动推断 |
| `AIPLUGIN4_BRIDGE_PLATFORM` | `QQ` | 桥自称的平台名（**仅桥侧展示**，见下节） |
| `AIPLUGIN4_BRIDGE_VIRTUAL_SELF_ID` | `10001` | 虚拟机器人号（可自定义） |
| `AIPLUGIN4_BRIDGE_VIRTUAL_NICKNAME` | `AI骰娘` | 虚拟机器人昵称 |
| `AIPLUGIN4_BRIDGE_VIRTUAL_SELF_ROLE` | `admin` | 机器人在虚拟群里的角色：`owner`/`admin`/`member` |
| `AIPLUGIN4_BRIDGE_VIRTUAL_GROUP_ID` | `20002` | 默认虚拟群号（未指定群时用它） |
| `AIPLUGIN4_BRIDGE_VIRTUAL_GROUP_NAME` | `AI 测试群` | 默认虚拟群名 |
| `AIPLUGIN4_BRIDGE_VIRTUAL_PEER_ID` | `30002` | 私聊默认对象号 |
| `AIPLUGIN4_BRIDGE_VIRTUAL_MAX_MEMBER_COUNT` | `200` | 虚拟群人数上限，**必须 > 0**（为 0 会被海豹判成"已退群"） |
| `AIPLUGIN4_BRIDGE_CORE_TOKEN` | 空 | 核心端（SealDice 连接）token；裸值或 `Bearer <token>` 都认 |
| `AIPLUGIN4_BRIDGE_PLUGIN_PATH` / `_PLUGIN_TOKEN` | `/plugin` / 空 | 插件控制 WS 路径与 token（插件以 `access_token` 查询参数传入） |
| `AIPLUGIN4_BRIDGE_PROTOCOL_URL` / `_TOKEN` | 空 | **仅 relay**：协议端 WS 地址与 token（token 同时以 `access_token` 查询参数与 Bearer 头发送） |
| `AIPLUGIN4_BRIDGE_STATE_DIR` | `.state` | 虚拟世界落盘目录（映射表跨重启稳定；支持绝对路径） |
| `AIPLUGIN4_BRIDGE_KEEPALIVE_MS` | `30000` | 对核心的传输层 ping 间隔，连续 2 次无 pong（≈90s）才判死 |

> 这里**没有 `CORE_URL`**，也**没有** `AIPLUGIN4_BACKEND_TOKEN` 之类的通用兜底：桥只校验 `core_token`（核心侧）与 `plugin_token`（插件侧），两者都为空即不鉴权；启动器卡片里设的通用 token **不会**被桥读取（见 [08-相关后端项目](08-相关后端项目.md)）。
>
> **配置项的默认值是"开箱即用"，不是"只能这样"**：`platform` 与三个虚拟 ID 都面向用户可填，且**空值算非法配置**（不会静默回退默认值）。启动自检不通过时后端**不会 listen**，日志逐项打印是哪一项非法（空值 / 非数字 / ≤0 / 命中 QQ 机器人号段 / 三个虚拟 ID 互撞 / 人数上限 ≤0 / 角色非法 / `mode` 非法）。改完重启即可。

## SealDice 侧配置

**你只需要记住端口（默认 `46880`，在启动器里改）；海豹面板「目标地址」填 `ws://127.0.0.1:<端口>` 就行，不用带任何路径（SealDice 的 OB11 适配器不会替你补 `ws://`）。**

1. 打开海豹 WebUI →「连接」→ 新增 **OB11 正向 WebSocket**；
2. 「目标地址」填 `ws://127.0.0.1:<端口>`（端口取启动器里的实际值，**不带路径**；桥不按路径认核心端，末尾多写 `/core` 之类也照常工作）；
3. 桥的「⚙ 配置」里填了「核心端 token」时，海豹这一格也要填同一个值；
4. 保存后海豹会以虚拟账号 `QQ:<virtual_self_id>`（默认 `10001`）上线，默认群 `20002`、默认私聊对象 `30002`；
5. **必须做一步**：把虚拟号加进 `serve.yaml` 的 `DiceMasters`，条目写 `QQ:<virtual_self_id>`（默认即 `QQ:10001`）。否则 `MasterCheck` 永不命中、`PrivilegeLevel` 上不到 100，`.master` 相关与需要 ownership 的指令会全部降级。

虚拟号的取值来源有三处、口径一致：桥启动日志的 `standalone 虚拟账号：QQ:10001`、`/healthz` 的 `virtualSelfId`、`/plugin` 的 `hello_result.virtualSelfId`。

> **不要**把端口单独填进这一格（只填 `46880` 这类默认端口值）：OB11 适配器不做 scheme 补全，会变成 `NewClient("46880")`，表现为**静默 `connect_fail`**。但**路径可以完全不写**——桥把除 `/plugin`、`/healthz` 之外的所有连接都当核心端。
>
> 端口的四条来源与优先级：`.runtime.json` 的 `config.<name>.port` → 旧版 `ports` 字段 → 注册表里的 `port`（默认 `46880`）→ 海豹面板地址里你手抄的那个端口。前三者由启动器统一管理，**第四者不会自动同步**：改端口后要重启后端，并同步改海豹面板那一格。可用 `curl http://127.0.0.1:<端口>/healthz` 的 `corePort` 核对实际生效端口。
>
> **core token 的发送方式**：海豹把 token 以 `Authorization: <裸 token>` 头发出（不带 `Bearer ` 前缀），桥对两种形式都接受；也**不存在**任何"通用 token 自动兜底"的回退——桥只认卡片里「核心端 token」这一项。

## 平台名与虚拟 ID 都能自己填

`platform` 与三个虚拟 ID（`virtual_self_id` / `virtual_group_id` / `virtual_peer_id`）都是**面向用户的可填项**，默认值只用于开箱即用。改任意一项都要**重启后端**（启动器只在启动时注入环境变量）。

**一条物理约束必须先讲清**：`platform` 只在**桥侧**生效（桥的日志、`/healthz.platform`、`hello_result.platform`，以及桥内部展示用的 `QQ:123` / `QQ-Group:456` 前缀）。海豹核心把 `QQ` 写死在适配器里（`ep.Platform == "QQ"` 才会服务），并把端点 ID 固定格式化为 `QQ:<id>`、群 ID 为 `QQ-Group:<id>` —— 所以**把 `platform` 改成非 `QQ` 不会让海豹面板变成别的平台**，面板永远显示 QQ、ID 前缀永远是 `QQ:`。想让海豹侧显示成别的平台只能改 `sealdice-core`，本期不做。桥在 `platform` 非 `QQ` 时会在启动日志里 warn 一行说明，但**不会拒绝启动**。

虚拟 ID 会被海豹当成真实账号/群号使用，因此有硬约束：必须是十进制正整数；不能落在 QQ 官方机器人号段（`3328144510`、`66600000`、`2854196301–2854216399`、`3889000000–3889999999`、`4010000000–4019999999`），否则海豹会把它判成"官方机器人自己"；三个 ID 不能互相撞号。任一项非法 → **拒绝启动并报明确原因**（不会静默回退默认值）。改虚拟机器人号等于换了张脸：海豹侧以 ID 为键的历史状态（`.master`、群配置、玩家卡、`.log`/`.pc`/`.deck`、权限）会对不上，属预期行为。

## 协议端侧配置（**仅 relay**）

standalone 下这一整节无意义：桥自己就是协议端，没有"外侧对端"可连。只有在卡片里填了**协议端 WebSocket 地址**（`protocol_url`，或显式 `mode=relay`）时才进入 relay，行为与 1.1.x 逐字一致：桥在**启动时**作为 WS 客户端主动连接 NapCat / LLOneBot / 测试模拟器等协议端的 WS 地址，并在核心与协议端之间原样转发 OB11 JSON（不支持反向 WS）。

在 aiplugin4「后端」页的 ob11-core-bridge 卡片「⚙ 配置」中填写 label 带 **【兼容】** 标记的两个键：**协议端 WebSocket 地址**（如 `ws://127.0.0.1:6700`，对应 `AIPLUGIN4_BRIDGE_PROTOCOL_URL`）与**协议端 token**（对应 `AIPLUGIN4_BRIDGE_PROTOCOL_TOKEN`）。

> 配置保存后需**重启该后端**才生效。协议端不可达时桥按指数退避（1s 起、上限 30s）重试，期间核心发来的 API 请求立即返回 `status: failed`，不会静默等待超时。**从 relay 迁到 standalone**：清空「协议端地址」并重启后端即可（`mode` 留空）。升级到 2.0.0 后卡片配置项从 3 个变成 13 个，旧的 `protocol_url` 仍然有效（自动进 relay）。

## 插件侧接入（aiplugin4）

在 aiplugin4「后端 → 后端配置」的 `backends.ob11-core-bridge` 中填写（也可直接点 aiplugin4-backends WebUI 的「📋 复制后端配置」整段粘贴）：

- **url**：默认 `ws://127.0.0.1:46880/plugin`（完整 URL；对应后端 `AIPLUGIN4_BRIDGE_PLUGIN_PATH` 与端口，按实际地址/路径填写）
- **token**（可选）：对应后端 `AIPLUGIN4_BRIDGE_PLUGIN_TOKEN`，桥要求鉴权时填写（插件以 `access_token` 查询参数传入）

> **这一格必须填完整 URL**（`ws://` 开头）。插件对 `url` 有格式校验（`/^wss?:\/\/\S+$/i`），填纯端口会让**整份后端配置**校验失败并回退出厂默认——所有后端一起失效。端口不在这里填，它在启动器的「端口」输入框里。

连上后插件先发 `hello`，桥回 `hello_result`（`mode` / `platform` / `corePort` / `virtualSelfId` / `virtualNickname` / `protocolVersion` / `capabilities` / `bridgeVersion`）。插件据此决定报文形态：`mode=standalone` 时 `core_command.payload` 额外带 `source`（**真实** ID，含 `endpointId`/`messageType`/`groupId`/`userId`/`groupName`/`userRole`），由桥投影成虚拟 ID；`mode=relay`（或 `hello` 3 秒无响应、仍是老桥）时报文与 1.1.x 完全一致。

## 工具与参数

`run_ext_command` 与 `run_core_command` 均由插件本地注册为 AI 工具（敏感工具，执行会显著记录）。`run_ext_command` 在插件内直调扩展 `solve`，不依赖桥；`run_core_command` 通过 `/plugin` WebSocket 直连 `ob11-core-bridge`，在桥的虚拟端点上产生一条指令消息并收集核心的回复，需启动 `ob11-core-bridge` 并在「后端 → 后端配置」的 `backends.ob11-core-bridge` 填地址。

**`run_ext_command`（扩展指令）**：`action=list` 按 `kind`（builtin / non_builtin / all）列出可调用扩展指令并附已知扩展名；`action=call` 执行指令，`extension` + `command` 写 `扩展名|指令名`（`command` 也可直接填 `扩展名|指令名`），`args` 按顺序传参。本地执行：直接调用扩展 `cmdMap[cmd].solve`（构造全新 `CmdArgs`，不要求会话先出现 `.r`），复用多消息收集器收集多条回复；核心内置扩展（fun / story / coc7 / deck / dnd5e / exp / log / reply，已硬编码，**无需维护内置扩展列表**）与第三方扩展均可调用，仍受「可调用指令白名单」约束。

**`run_core_command`（核心指令）**：`action=list` 列出白名单中的核心指令；`action=call` 执行指令（如 `ext`、`help`，也支持 `core|ext` 写法）。结构化模式传 `command` 和可选 `args`，插件按当前「指令前缀」组装核心原始消息；原始消息模式传 `raw_message` 原样投给核心（不能与 `command`/`args` 同时使用）。

触发对象与 @ 对象：两种工具都支持 `trigger` / `at`。前者写入指令消息的 `user_id` / `sender.user_id`（standalone 下先投影为虚拟 ID），后者写入消息的 at 段；省略前者时沿用当前对话用户。私聊传 `at` 会返回提示，不会伪造私聊 @。

| 参数 | 适用 | 说明 |
| --- | --- | --- |
| `trigger` | 两者 | 指定指令消息发送者/触发对象用户 ID；默认当前对话用户 |
| `at` | 两者 | 指定消息中 @ 的用户 ID 列表（字符串数组）；仅群聊 |
| `forward` | 仅 `run_core_command` | 是否把捕获到的消息继续转发给协议端；默认 `true`。**standalone 下收下但忽略**（没有真实协议端可转发） |
| `captureMode` | 仅 `run_core_command` | `reply_only` / `lane`；standalone 下 `lane` 是唯一可靠模式（插件默认即 `lane`） |
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
| `mode` | **新增**：`standalone` / `relay`（桥实际运行模式） |
| `deliveredCount` | **新增**：真正记账/投递给本次调用的消息数（standalone 下等于 `messages.length`） |
| `virtualTarget` | **新增**：本次调用投影出的虚拟目标 `{selfId, messageType, groupId?, userId?}` |
| `ambiguous` | 是否因无法区分并发消息而标记歧义；**standalone 下恒 `false`** |
| `forwardedCount` | 转发计数；**standalone 下恒 `0`**（"转发到协议端"这个动作已不存在） |
| `interceptedCount` | 拦截计数；**standalone 下恒 `0`**（消息由本桥全权受理，没有"从协议端手里抢下来"这回事；真实条数看 `deliveredCount`） |
| `error` | 失败原因（如核心未连接、target 缺少群/私聊 id） |

> 上表是 `run_core_command` 经核心桥 WebSocket 返回的结果结构；`run_ext_command` 不经过核心桥，本地执行直接返回收集到的消息文本，异常时返回错误说明。老字段（`ambiguous`/`forwardedCount`/`interceptedCount`）保留是为兼容旧插件，插件渲染时改用 `deliveredCount`。

## 指令白名单与指令前缀

「可调用指令白名单」每框一条，格式 `扩展名|指令名/别名1/别名2`，同一元素内的别名用 `/` 分隔：

- 内置扩展已硬编码，**无需填写扩展列表**；第三方扩展写实际扩展名；核心指令的扩展名统一写 **`core`**（如 `core|help`）
- `core|ext` 是扩展发现入口，**无需加入白名单**：`run_core_command` 执行 `command=ext`（即核心 `.ext`）即可查看核心当前全部扩展名称
- 开启「是否允许调用所有指令」后忽略扩展指令白名单（核心指令仍受 `run_core_command` 白名单约束）
- 插件默认值已按当前 SealDice 源码同步全部核心命令、内置扩展命令及别名；调用帮助由默认知识库提供（「知识库」页签：核心指令、扩展指令；OB11 依赖说明见 ob11-api 知识库，仅 QQ 平台可见）。升级 SealDice 后新增命令需手动补白名单或等插件默认值更新

「工具 → 指令前缀」配置，默认 `.`。海豹核心通常用 `.`；如果核心改成其他前缀（如 `/`），请同步修改该配置，否则投给核心的虚拟消息不会被识别为指令。

## 捕获与转发语义

standalone 下语义被大幅简化——没有真实协议端，"拦截 / 转发"这组概念本身消失：

- **`capture.forward` 收下但忽略**：不报错、插件无感，但不会再有任何"转发到协议端"的动作。
- **非 action 帧一律丢弃**：standalone 下核心发来的帧只有 `action` 有用，`notice`/`request`/`meta_event`/裸事件都被丢掉（只打 debug 日志），所以 `messages[].source` **只可能是 `action`**，`source:'event'` 不可能出现。
- **`lane` 是唯一可靠模式**：按「虚拟 `self_id` + 群/私聊 + 对方 id」捕获该会话内的消息。**`reply_only` 通常捕获为空**（依赖被捕获消息带 `reply` 段且引用本次投递的虚拟 `message_id`，而海豹默认不引用回复）；桥接受该参数，捕获不到时按 `timeout` 结束并给出提示，不报错。
- 收到第一条消息后进入 `settleMs` 空闲窗口；达到 `maxMessages` 或 `timeoutMs` 结束。
- 核心回复一律进 invocation 账本随结果返回，**不推回核心**（禁止回环）；`get_msg` / `delete_msg` 能查到、删掉本次应用发出的每一条消息。

relay 下保留 1.1.x 的完整语义：`forward=false` 拦截、`forward=true` 继续转发并按 `echo` 路由回核心、`reply_only` 精准匹配。

## 并发与消息混淆

- 同一 lane 的调用**串行**执行（队列），不同 lane **并行**，避免同一群同时投递多条指令时响应混在一起。
- standalone 下核心不会向桥推事件、桥也只有一个核心连接，**`ambiguous` 恒为 `false`**，不存在"无法区分并发消息"的问题；relay 下纯 OB11 没有标准 trace_id，极端并发可能返回 `ambiguous=true`，业务侧建议短 `settleMs` + lane 串行 + 唯一目标。

## 多核心

standalone 下**一个桥只服务一个核心**：已是 `1` 条核心连接时，第二条连接会被 `1013` 拒绝，原因文本为 `standalone 模式仅支持单个 SealDice 核心`。需要多 QQ 账号 / 多核心路由请用 relay（核心上报的 `self_id` 用于路由）。`run_ext_command` 在任何模式下都在插件内本地直调当前实例的扩展 `solve`，不涉及核心路由。

## `/healthz`

`curl http://127.0.0.1:<端口>/healthz` 返回 **16 个字段**：

| 字段 | standalone | relay |
| --- | --- | --- |
| `ok` | `true` | `true` |
| `coreConnected` / `coreClients` | 有核心连接时 `true` / `1` | 同左（可 > 1） |
| `pluginConnected` / `pluginClients` | 插件连上时 `true` / 数量 | 同左 |
| `mode` / `platform` / `corePort` | `"standalone"` / 配置的平台名 / 实际监听端口 | `"relay"` / 同左 / 同左 |
| `virtualSelfId` | 虚拟机器人号（写进 `DiceMasters` 的那个） | `null` |
| `actionCount` / `eventCount` / `ledgerSize` | 已应答 action 数 / 已投递事件数 / 账本条数（上限 2000，FIFO） | 0 / 0 / 0 |
| `legacyTarget` | 收到过不带 `source` 的老插件报文则为 `true` | `false` |
| `protocolConnected` / `protocolClients` / `droppedProtocolEvents` | **恒 `null`** | 原语义 |

> 三个 `protocol*` 字段在 standalone 下是 `null`，**不是** `false` / `0`——字段名故意保留，避免排障脚本与旧文档断链。`legacyTarget: true` 说明有老插件（4.31.0 及更早）在用真实 ID 降级运行，应升级插件。

## 排障

| 现象 | 检查 |
| --- | --- |
| 海豹面板显示端点离线 / 日志 `connect_fail` | 最常见原因：**面板「目标地址」里填的是纯端口**（如 `46880`）。必须填完整 URL `ws://127.0.0.1:<端口>`（默认端口 `46880`，在启动器里改；改了端口要同步改这一格；路径不用写）。再核对桥是否已启动、端口是否被占用 |
| `run_core_command` 不可用 / 报核心桥未连接 | `backends.ob11-core-bridge.url` 是否为**完整 URL**（默认 `ws://127.0.0.1:46880/plugin`）、`ob11-core-bridge` 是否已启动。填成纯端口会让整份后端配置校验失败回退出厂默认 |
| 海豹连上了但指令全失效 | 看 `/healthz` 的 `coreConnected`；看桥日志是否报 `standalone 模式仅支持单个 SealDice 核心`（已有别的核心在连）；确认 `virtual_max_member_count > 0`（为 0 时海豹会认为机器人已退群） |
| 管理指令（`.master` / `.send to` 等）不可用、`PrivilegeLevel` 上不到 100 | `DiceMasters` 里是否加了 `QQ:<virtualSelfId>`（默认 `QQ:10001`）；取值看启动日志的 `standalone 虚拟账号：QQ:...` 或 `/healthz.virtualSelfId` |
| `run_ext_command` 执行失败 / 无响应 | 扩展是否已安装、指令名是否正确（`扩展名|指令名`）、是否在白名单、指令本身是否抛异常；与桥无关 |
| 执行无响应 / 超时 | 核心是否已连上桥（看桥日志与 `/healthz.coreConnected`）、指令前缀是否正确、目标群/私聊 id 是否正确、指令是否在白名单 |
| 返回 `ambiguous=true` | 只可能是 relay：同 lane 并发或缺少 reply 引用；调整 `captureMode` / `settleMs`。standalone 下恒为 `false` |
| 改了虚拟号/平台名"没生效" | `mode` / `platform` / `virtual_*` 全部**只在启动时注入**，改完必须**重启该后端**；改虚拟机器人号还会让海豹侧旧状态对不上（预期行为） |
| `platform` 改了但海豹面板还是 QQ | 设计如此：`platform` 只影响桥侧日志 / `/healthz` / `hello_result`，海豹核心把 `QQ` 写死了 |
| 鉴权失败 / 连不上但无日志 | 核对 core token（海豹「连接」页）与 `core_token`、plugin token（插件「核心桥Token」）与 `plugin_token` 是否一致；桥会打印"哪个端 / token 不匹配 / 来源 IP"的 warn（不回显明文）。注意桥**不读** `AIPLUGIN4_BACKEND_TOKEN` |
| `/healthz` 里三个 `protocol*` 字段是 `null` | 正常：当前是 standalone，没有"外侧对端"。要排 relay 侧问题先确认 `mode` 为 `relay` 且填了协议端地址 |
