# 🎲 AI骰娘4 - SealDice AI插件

- 让你的骰娘活起来

![License](https://img.shields.io/badge/License-MIT-blue)
![Version](https://img.shields.io/badge/Version-4.22.0-green)

## 快速开始

### 1. 下载插件

- 通过 GitHub 下载最新稳定版：[下载链接](https://github.com/error2913/aiplugin4/releases/latest)；
- 在 QQ 交流群（143412516）中获取；
- 想体验最新开发版，可以自行编译，见[下载](#下载)。

### 2. 安装插件

- 参考[海豹手册](https://docs.sealdice.com/config/jsscript.html)，在 SealDice WebUI →「JS插件」中上传 `aiplugin4.js`；
- 点击重载，刷新浏览器页面。

### 3. 配置大模型

- 在 WebUI →「JS插件」→「插件设置」中找到 `aiplugin4`，点击展开，进入「模型」分组；
- 在 **api连接** 中用 **TOML 格式**填写服务商连接（出厂默认已带 deepseek 示例，只改 `api_key` 即可用）：

```toml
provider = "deepseek"                        # 服务商：deepseek/openai/google/zhipu/alibaba/anthropic/moonshot/xai/mistral/siliconflow
api_key = "sk-xxxx"                          # 你的 API Key
base_url = "https://api.deepseek.com/v1"     # 可选，省略时取服务商默认
models = ["deepseek-v4-flash"]               # 可选：钉住清单（填写后跳过自动拉取，离线/无列表接口时用）；删掉该行=启动自动获取模型列表
# [types]                                    # 可选：手动声明模型类型，必须写在本框最后（其后不能再写 api_key 等键）
# "my-embed-1" = "embed"                     #   网关自命名的嵌入模型：不再被误当对话模型
# "inhouse-vl" = "vision"                    #   未命中命名白名单的多模态模型：进识图候选
```

- 未填 `models` 的连接启动时会自动获取该平台的可用模型列表（OpenAI 兼容 `GET /models`；anthropic 走 `/v1/models` 并自动翻页）；获取失败按连接降级展示（认证失败/无列表接口/超时），不影响其它连接；
- **模型规则** 每框是一个"用途组"请求模板：`use` 数组（chat/compression/summarization/judge/image-understanding/text-embedding）+ 可选 `[body]`/`[request]`，**不写任何模型名**；出厂默认给 chat/压缩/总结/judge 预设了对话参数；
- 默认模型自动取该用途**首个可用**的同类型模型（出厂 deepseek 拉取/钉住的首个文本模型 → chat 即用）；要换别的模型用 `.ai model <用途> <模型>` 绑定。图片识别 / 向量记忆需要先有可被识别为视觉 / 嵌入的模型（如 `glm-4v` / `text-embedding-3-small`），再绑定到 image-understanding / text-embedding 用途；模型名若无法被自动识别（网关自命名、新模型等），在 **api连接** 的 `[types]` 表里手动声明 `text`/`vision`/`embed`（优先级最高，详见下方配置手册）；
- 常用命令：`.ai model list` 查看当前模型列表（读加载结果、不联网），`.ai model pull` 立即重拉全部连接并展示（无视 models 钉住清单，强制网络），`.ai model` 查看各用途与连接状态；`.ai balance` 可查全部连接余额（deepseek/moonshot/siliconflow 内置接口直接查，其余平台提示控制台入口，见下方[可用AI大模型开放平台列表](#可用ai大模型开放平台列表)的余额说明）；
- `anthropic`（Claude）已适配请求/响应格式（system 拆出、tool_result 合并、响应归一化）；其流式暂不支持，配置 `stream = true` 时会自动回退为非流式。

### 4. 设置触发与角色

- 在「消息触发」分组中修改「触发正则表达式」，改为你希望的触发方式（默认示例为 @ 骰娘，可直接替换）；
- 在「角色设定」分组中修改「角色扮演设定」，决定 AI 扮演的角色；每条设定第一行为角色设定名称（可通过 `.ai role <名称>` 切换），其余为设定内容。「上下文」分组可调整「预设上下文」「对话保存轮数」「上下文最大token」等上下文参数。

### 5. 开始对话

- 对着骰娘输入你设定的触发方式（默认是 @ 骰娘），即可看到回复；也可以使用 `.ai on` 开启计数 / 计时 / 概率等自动触发模式；
- 如果没有回复，把「基础 → 日志级别」改为「调试」查看触发日志，并对照[常见问题处理](#常见问题处理)排查。

更多设置见[⚙️ 配置手册](#️-配置手册)，全部指令见[💻 完整命令手册](#-完整命令手册)。

---

## 目录

- [🎲 AI骰娘4 - SealDice AI插件](#-ai骰娘4---sealdice-ai插件)
  - [快速开始](#快速开始)
  - [目录](#目录)
  - [🌟 核心特性](#-核心特性)
  - [🛠️ 完整安装指南](#️-完整安装指南)
    - [环境要求](#环境要求)
    - [下载](#下载)
    - [依赖下载](#依赖下载)
    - [安装](#安装)
  - [⚙️ 配置手册](#️-配置手册)
    - [模型](#模型)
    - [基础](#基础)
    - [错误处理](#错误处理)
    - [角色设定](#角色设定)
    - [上下文](#上下文)
    - [消息接收](#消息接收)
    - [事件接收](#事件接收)
    - [消息触发](#消息触发)
    - [图片](#图片)
    - [工具](#工具)
    - [MCP](#mcp)
    - [技能](#技能)
    - [子代理](#子代理)
    - [记忆](#记忆)
    - [知识库](#知识库)
    - [回复](#回复)
    - [后端](#后端)
    - [公开会话](#公开会话)
    - [资源](#资源)
    - [prompt 模板](#prompt-模板)
  - [💻 完整命令手册](#-完整命令手册)
    - [管理员命令](#管理员命令)
    - [基础控制命令](#基础控制命令)
    - [记忆管理命令](#记忆管理命令)
    - [工具管理命令](#工具管理命令)
    - [MCP 技能 知识库管理命令](#mcp-技能-知识库管理命令)
    - [忽略名单相关命令](#忽略名单相关命令)
    - [token 计数命令](#token-计数命令)
    - [图片相关命令](#图片相关命令)
    - [定时器相关命令](#定时器相关命令)
    - [公开会话目录命令](#公开会话目录命令)
  - [🧰 可用工具函数](#-可用工具函数)
  - [🚨 注意事项](#-注意事项)
    - [常见问题处理](#常见问题处理)
  - [可用AI大模型开放平台列表](#可用ai大模型开放平台列表)
  - [版权信息](#版权信息)
  - [致谢](#致谢)
  - [📞 技术支持](#-技术支持)

## 🌟 核心特性

AI骰娘4 是一款运行在 [SealDice](https://docs.sealdice.com/) 上的智能对话插件，基于 OpenAI 兼容 API 开发，深度整合海豹骰子生态的 TRPG 功能：

- **智能对话**：支持上下文感知的 AI 对话、角色设定与预设上下文（示例对话）；
- **记忆体系**：长期记忆（向量检索 + 标签/用户/群组过滤）、观察记忆、配置驱动的知识库（Markdown 模板 + 自动分块）；
- **工具系统**：内置 40+ 工具函数（TRPG 检定、牌堆抽取、消息、图片、禁言、定时器等），支持函数调用与提示词工程两种模式，可接入外部 MCP 服务器与可配置技能；
- **图片处理**：图片识别、表情包管理、Markdown/HTML 渲染为图片与本地图片资源；
- **权限体系**：命令权限（会话/用户/强触三维）与工具权限（禁止/默认关闭/按会话开关）；
- **多智能体与多端协作**：子代理委派（后台并行 / 可续跑 / 完成通知）与公开会话目录（跨平台、跨账号的会话只读与外发）；
- **可观测性**：结构化日志（级别控制、密钥脱敏）、token 用量统计与图表、工具调用审计。

---

## 🛠️ 完整安装指南

### 环境要求

- SealDice v1.4.6+；
  - v1.4.6 分离部署（napcat / llonebot 协议）下图片相关功能存在问题，建议 SealDice v1.5.0+；
- 大模型 API：OpenAI 兼容格式；
- 本地开发：Node.js + npm（构建使用 esbuild，建议使用较新 Node 版本）。

### 下载

- 通过 GitHub 下载最新稳定版：[下载链接](https://github.com/error2913/aiplugin4/releases/latest)

- 通过 GitHub 下载后自编译最新开发版：

  - 安装 Node.js 和 npm
  - ```bash
    git clone https://github.com/error2913/aiplugin4 # 克隆仓库
    npm install # 安装依赖
    npm run build # 编译
    ```
  - 在 `dist/` 文件夹中可找到编译好的 `aiplugin4.js` 文件

- 在 QQ 群中获取

### 依赖下载

以下依赖按需安装，均可通过 GitHub 下载或在 QQ 群中获取：

- [生成音频依赖插件](https://github.com/error2913/aiplugin4-dependencies/tree/main/tts)：自定义音色的 AI 语音；
- [ob11 网络连接依赖.js](https://raw.githubusercontent.com/error2913/sealdice-plugin-ob11-net-connection/refs/heads/main/dist/ob11%E7%BD%91%E7%BB%9C%E8%BF%9E%E6%8E%A5%E4%BE%9D%E8%B5%96.js)（推荐）或 [http 依赖插件](https://github.com/error2913/sealdice-js/blob/main/HTTP%E4%BE%9D%E8%B5%96.js)：ob11 相关工具（发消息、用户/群信息、禁言、打卡、AI 语音等）；
- [生成图片依赖插件](https://github.com/error2913/aiplugin4-dependencies/tree/main/tti)：AI 生图工具；
- ffmpeg：发送本地语音需要配置到环境变量中。

### 安装

- 参考[海豹手册](https://docs.sealdice.com/config/jsscript.html)进行插件上传安装；
- 简单配置（开关/数值/单行字符串/纯字符串数组）修改后自动生效（缓存最多 1 分钟），无需重载 JS；复杂配置（模型「api连接/模型规则」、触发/忽略正则、评分触发、角色扮演设定、MCP、技能、知识库、本地资源路径、音乐服务）修改后需重载 JS 才生效（其中「MCP服务器配置」「技能配置」「知识库」三类改动也可用 `.ai mcp refresh` / `.ai skill refresh` / `.ai kb refresh` 立即生效）。

---

## ⚙️ 配置手册

配置项在 SealDice WebUI 的插件设置中按分组展示，以下键名与当前代码注册的配置一致。

### 模型

模型分两个 TOML 配置：

| 设置项 | 说明 |
|:---:|:---|
| api连接 | TOML 格式，每框一个服务商连接。`api_key` 必填；`provider` 选填（省略时按 OpenAI 兼容处理，此时需显式填 `base_url`）；`base_url` 可选（省略时取该 provider 默认地址）。可选 `models`（模型钉住清单：填写后跳过自动拉取，直接用该清单，适合离线/无列表接口的服务商）；可选 `[types]`（**手动声明模型类型**：在本框末尾追加 `[types]` 表，表内每个模型写一条 `"模型名" = "text"` / `"vision"` / `"embed"`，优先级最高，可覆盖命名猜测与接口能力位；模型名含 `.` `:` `/` 等字符必须加引号；**必须写在本框最后**，其后不能再写 `api_key` 等键，否则整框解析失败；无效值只忽略该键并记日志）；可选 `[request]`（列表拉取覆盖：list_url/auth_header_name/headers/timeout）。未填 `models` 的连接启动时自动获取可用模型列表（OpenAI 兼容 `GET /models`；anthropic 走 `/v1/models` 自动翻页），失败按连接降级展示，不拖垮其它连接。`ignore` 可选：1=忽略该连接 |
| 模型规则 | TOML 格式，每框一个"用途组"模板：`use` 数组（`chat`/`compression`/`summarization`/`judge`/`image-understanding`/`text-embedding`，可多选）+ 可选 `[body]`（请求参数模板）+ 可选 `[request]`（method/url/headers/content_type/auth_header_name/timeout，默认不写由插件解析）。**不写模型名**：命中这些用途的模型统一套用该模板；多条规则 use 重叠时按框顺序逐键合并、后覆盖先 |

```toml
# api连接 示例（出厂默认即此结构，只改 api_key 即可用）
provider = "deepseek"
api_key = "sk-xxxx"
base_url = "https://api.deepseek.com/v1"
models = ["deepseek-v4-flash"]   # 可选：钉住清单；删掉该行=启动自动拉取

# [types]                        # 可选：手动声明模型类型，必须写在本框最后（其后不能再写 api_key 等键）
# "my-embed-1" = "embed"         #   取值只能填 text/vision/embed；模型名含 . : / 等字符必须加引号
# "inhouse-vl" = "vision"        #   声明未命中当前模型列表时会在日志里给一条 warning 提示（检查拼写）

# 模型规则 示例（同一框内只保留一组字段）
use = ["chat", "compression", "summarization", "judge"]

[body]                           # 可选：请求参数模板
temperature = 1
```

> 模型类型判定优先级：**`[types]` 手动声明 > 命名终值（reranker/生图/嵌入白名单） > 接口自报能力位 > 命名能力位 > 兜底纯文本**（手动声明即最终答案，与自动判定冲突时按声明执行）。模型来自「api连接」的自动拉取或 `models` 钉住清单，并按能力分类进各用途候选：文本类进对话候选；带明确视觉标签的模型（如 glm-4v/gemini/pixtral，或接口自报能力位：`type`/`model_type`/`task`、`architecture.input_modalities`、`capabilities`、`supports_vision`）进识图与对话候选；嵌入白名单命名（如 `text-embedding-*`/`bge-*`/`gemini-embedding-*`）进嵌入候选；生图/reranker 类不进任何候选。默认模型自动取该用途第一个候选（首个可用的同类型模型）；想换别的模型用全局覆盖指定。
>
> 全局分用途覆盖：`.ai model` 查看各用途当前模型与连接状态；`.ai model list` 查看加载/最近一次拉取到内存的模型列表（不联网、不持久化，按 `[连接序号]` 分组）；`.ai model pull` 立即重拉全部连接并展示（无视 models 钉住清单，强制网络）；`.ai model <用途>` 查看指定用途候选；`.ai model <用途> <模型>` 设置（支持编号 / 裸名唯一 / `[序号]:模型名` 精确，重名歧义会提示；覆盖失效自动回退默认）。`.ai model <模型名>` 兼容为设置 chat 用途。
>
> 嵌入输出维度取 text-embedding 用途组规则的 `[body] dimensions`（默认 1024）；配置后长期记忆与知识库启用语义检索，未配置/不匹配自动降级为关键词检索。

### 基础

| 设置项 | 说明 |
|:---:|:---|
| 日志级别 | 从不 / 错误 / 警告 / 信息 / 调试，反馈问题建议设为「调试」 |
| 日志简短打印 | 日志超长时只保留首尾各 500 字 |
| 日志记录消息内容 | 关闭后请求上下文日志只记录角色与长度，不打印消息正文 |
| 请求超时时限 | 单位毫秒，同时约束模型请求与工具调用，过小会导致长回复/慢工具超时 |
| 请求并发上限 | 同时进行中的请求数量上限，0 表示不限制；超出后进入等待队列 |
| 请求队列上限 | 排队等待的请求数量上限，超过后直接丢弃；0 表示超出并发后不排队 |
| 海豹核心全局路径 | 本地资源相对路径拼接用的 SealDice 核心目录 |
| 是否开启全局待机 | 开启后 AI 不主动回复，收到的所有消息会录入上下文（会话的计数器/计时器/概率仍可触发）；长时间开启可能占用较多上下文 |

### 错误处理

| 设置项 | 说明 |
|:---:|:---|
| 启用报错自动处理 | 模型请求报错时按语义类别自动处理（上下文超长归档重试 / 余额不足切模型 / 限速退避等）；未覆盖或无法处理的错误仅记日志不回复（默认开启） |
| 上下文超长自动归档重试 | 模型返回上下文超长时，把会话历史按「观察归档 + 删除」链路压到模型窗口内后自动重发一次；关闭则该场景仅记日志（默认开启） |
| 余额不足自动切换模型 | 对话模型报余额不足 / 欠费 / 额度用尽时，自动把 chat 用途切换到备用模型（写入全局模型覆盖，管理员可用 `.ai model` 改回）（默认开启） |
| 自动切换触发错误 | 每框一个触发自动切换的类别：`balance`（余额不足）/ `permission`（权限不足）；其余类别仅退避重试或记日志（默认 balance） |
| 自动切换策略 | 跨厂商优先 = 优先切到不同服务商的模型；连接顺序 = 按 api连接/候选顺序取下一个不同模型 |
| 切换后发送通知 | 自动切换模型后用 `ctx.notice` 向当前会话发送一条切换通知（默认开启） |

### 角色设定

| 设置项 | 说明 |
|:---:|:---|
| 角色扮演设定 | 每框一个角色的扮演设定：第一行为角色设定名称（超过 20 字符自动截断，可通过 `.ai role <名称>` 或豹语变量 `$gSYSPROMPT` 切换），其余为设定内容；修改后需重载 JS 生效 |

### 上下文

| 设置项 | 说明 |
|:---:|:---|
| 预设上下文 | 每框一条预设上下文，role 按 user / assistant 轮流出现，位于上下文最前面，帮助模型学习对话语气 |
| 对话保存轮数 | 上下文超过「上下文最大token」后保留的最近真实用户轮数（默认 5）；更早消息会先归档沉淀为观察/长期记忆，再删除 |
| 上下文最大token | 持久化上下文 token 上限（默认 1000000）；填 0 / 负数视为无效并自动回退默认值；超过后触发上面归档逻辑 |
| 插入system message间隔轮数 | 需小于「对话保存轮数」的二分之一才能生效，为 0 时不生效，预设上下文不计入轮数 |
| 消息压缩阈值 | 用户消息（含连续多条合并后）超过该字符数时，使用压缩智能体压缩后存入上下文；压缩前原文自动保留，可用 read_raw kind=user 按 msg_id/blk:id 查看（默认 2000） |

### 消息接收

| 设置项 | 说明 |
|:---:|:---|
| 接收图片 | 是否接收图片消息并将图片 URL 记录到上下文；是否自动识别由图片识别条件和识图模型配置决定 |
| 接收指令消息 | 是否将指令消息计入上下文（指令仍会执行） |
| 接收骰子发送的消息 | 是否处理机器人自己发送的消息 |
| 忽略私聊消息 | 开启后私聊消息不触发 AI |
| 忽略消息豹语条件 | 命中为 1 时忽略，可填豹语表达式限制忽略范围 |
| 忽略消息正则表达式 | 匹配的消息不会被接收录入上下文 |
| ob11 额外消息接收 | 安装 ob11 网络连接依赖后，卡片/视频/音乐/文件/语音/合并转发消息经其事件分发接入（核心 milky 原生路径会过滤这些段），合并转发自动展开为可读文本 |

### 事件接收

| 设置项 | 说明 |
|:---:|:---|
| 接收依赖通知事件 | 开启后把 ob11 依赖订阅到的通知/请求事件（禁言/管理变动/文件上传/名片变更/表情回应/精华/运气王/入群申请/好友申请等）转成文本提示词录入上下文，仅作背景不触发 AI；仅当会话待机或全局待机开启时才录入 |
| 通知事件白名单 | 每行一个事件类型；notify 大类下需单独写子类型才收录；poke 由原生处理不录入；事件文本由纯代码模板生成（超长仅 head 截断兜底），完整原始数据由 `read_raw kind=event` 只读读取（原 `get_event_detail` 工具已删除） |

### 消息触发

| 设置项 | 说明 |
|:---:|:---|
| 默认计数器 / 默认计时器 / 默认概率 / 默认触发活跃时间 | `.ai on` 不带参数时使用的默认值；活跃时间格式 `HH:mm-HH:mm-次数` |
| 触发正则表达式 | 匹配符合正则的消息用于强制触发 AI 回复，[正则表达式教程](https://www.runoob.com/regexp/regexp-syntax.html) |
| 触发需要满足的条件 | 豹语表达式，例如 `$t群号_RAW=='2001'` 表示仅允许群 2001 触发；填 1 为无限制 |
| 触发次数上限 | 群内共用令牌桶容量，触发一次减少一计数，计数为 0 时无法触发 |
| 触发次数补充间隔 | 单位秒，按该间隔补充触发次数 |

### 图片

| 设置项 | 说明 |
|:---:|:---|
| 图片全局识别豹语条件 | 填 `'1'` 开启所有图片自动识别转文字；或填豹语表达式限制群/用户范围 |
| 识别图片时将url转换为base64 | 永不 / 自动 / 总是，解决大模型无法正常获取 QQ 图床图片的问题 |
| 图片识别展示截断字数 | 图片识别转文字结果超过该字数时不再压缩，改为仅展示开头部分；完整识别原文保留，可用 `read_raw kind=image` 按图片 ID 阅读（0 为不截断不保留，默认 5000） |

### 工具

| 设置项 | 说明 |
|:---:|:---|
| 开启调用函数功能 | 开启后 AI 可使用各种工具 |
| 切换为提示词工程 | 当 API 不支持 function calling 时开启 |
| 拉黑前需要骰主确认 | AI 建议拉黑时需骰主确认后才生效；关闭后 AI 可直接拉黑 |
| 无工具调用时续跑提示 | 上一轮调用过工具、本轮只回文字时，向上下文注入续跑提示再转一轮，避免只说方向不调用工具就停（默认关闭） |
| 工具方向提示 | 开启后要求模型调用工具前先向用户说一句方向说明，再在同一回复中给出工具调用块（默认开启） |
| 允许连续调用函数次数 | 单次触发内允许连续调用函数的次数，防止 AI 陷入调用函数死循环（默认 0=不限制） |
| 工具响应截断字数 | 工具返回结果超过该字数时改为只展示开头、截断前完整原文保留（0 关闭，默认 10000）；原文可由 `grep_raw` / `read_raw`（kind=tool）只读检索 |
| 禁止调用的函数 | 每框一个，设置后将不被允许开启（`.ai tool on <组名>` 会跳过名单内的工具并回报跳过个数）；该工具也不参与 `.ai tool` 的组统计 |
| 默认关闭的函数 | 每框一个，AI 在新会话中默认无法调用，需 `.ai tool on <函数名>` 开启 |
| 禁止调用的 OB11 action | 每框一个禁止 `call_ob11_api` 调用的原始 OB11 action，例如 `set_group_ban` |
| 默认关闭的 OB11 action | 每框一个默认关闭的原始 OB11 action，例如 `get_group_member_list`；关闭后 AI 不会调用 |
| 可调用指令白名单 | 每框一个 `扩展名|指令名/别名1/别名2`；同一元素内的别名用 `/` 分隔。默认已包含当前 SealDice 核心命令、内置扩展命令及全部别名，核心扩展名统一写 `core`（如 `core|roll/r/rd`） |
| 是否允许调用所有指令 | 开启后忽略白名单，允许调用所有可解析的扩展指令；核心指令仍通过 `run_core_command` 调用 |
| 指令前缀 | 注入到 SealDice 核心的指令前缀，通常为 `.`；核心前缀改动时需同步修改 |
| 音乐服务配置 | 每框一条 JSON：`{"platform":"网易云/qq","api":"域名","cookie":"Cookie（可留空）"}`，供 `search_music` 使用；修改后需重载 JS 生效 |
| ai语音使用的音色 | 预设音色需要支持 AI 语音的协议端，自定义音色需要生成音频依赖（tts）和 ffmpeg |

### MCP

| 设置项 | 说明 |
|:---:|:---|
| 是否启用MCP | MCP 功能总开关，默认关闭；开启后才会解析并连接下方「MCP服务器配置」中的服务器并注册其工具，未安装对应 MCP 后端时建议保持关闭 |
| MCP服务器配置 | 逐台配置：每个数组元素 = 以 `---` 开头的 YAML frontmatter（`name` 服务器名必填 / `platform` 可选平台白名单数组，如 `[QQ, DISCORD]`，`[]` 或省略 = 所有平台）+ 正文为**单个服务器**的 JSON（`type: http` 即 Streamable HTTP、`url`、`headers`、`token`）；**不再兼容旧整块 `mcpServers` JSON**，`command`(stdio) 服务器会被跳过。工具名称、描述与参数 schema 连接后经远端 `tools/list` 自动发现并注册（来源分组 = 服务器名），同名冲突自动跳过；服务器 platform 与当前平台不匹配时其工具不可见且调用被拦截。默认三台：mcp-files-exec（read_file/list_dir/write_file/delete_file/download_file/run_shell/export_file，相对路径与命令工作目录按 AI 会话隔离）、md-html-render（platform: [QQ]，render_markdown/render_html）、mcp-browser（browser_navigate/click/type/snapshot/take_screenshot/wait_for/close 等浏览器操作，按 AI 会话隔离）。格式定义见 [MCP 官方规范](https://modelcontextprotocol.io/specification/latest) |
| MCP会话空闲回收分钟 | MCP 会话（含浏览器操作）空闲超过该分钟数后自动回收，释放服务端浏览器状态；设为 0 不回收（默认 10） |
| MCP每服务器最大会话数 | 每个 MCP 服务器最多同时保留的 AI 会话数，超出后按最近使用时间回收最旧会话；浏览器操作按 AI 会话隔离（默认 3） |

```markdown
---
name: mcp-files-exec
platform: []            # 可选：[] / 省略 = 所有平台；例如 [QQ, DISCORD]
---
{
  "type": "http",
  "url": "http://127.0.0.1:3910/mcp",
  "headers": { "Authorization": "Bearer token" }
}
```

> MCP 配置修改后用 `.ai mcp refresh` 立即重新解析并强制重同步工具列表（refresh 需骰主，或重载 JS）；`.ai mcp list` 查看当前平台可用服务器及工具开关状态；`.ai mcp on/off [<服务器>]` 按会话批量开启/关闭某服务器（或缺省全部当前平台服务器）下的工具（on 时跳过「禁止调用的函数」）。
>
> `run_core_command` 由插件本地注册，通过「后端 → 核心桥WS地址」直连 `ob11-core-bridge`（默认 `ws://127.0.0.1:46880/plugin`）；`run_ext_command` 仅由插件本地实现。二者不由 MCP 提供。

### 技能

| 设置项 | 说明 |
|:---:|:---|
| 技能配置 | 每条配置项一个技能，仅支持标准 SKILL.md 格式：以 `---` 开头的 YAML frontmatter 里写 `name`（必填）/`description`（可选）/`platform`（可选平台白名单数组，如 `[QQ, DISCORD]`，`[]` 或省略 = 所有平台），正文为技能内容，可直接粘贴其他 agent 的技能文件。默认只含「录卡」技能（Excel 角色卡录入）；SealDice 核心/扩展指令与 OB11 API 的调用帮助已作为默认知识库提供（「知识库」页签默认库：核心指令 / 扩展指令 / ob11-api）。格式定义见 [agentskills.io 规范](https://agentskills.io/specification)。修改后用 `.ai skill refresh` 生效（或重载 JS） |

> system prompt 的「可用技能」段只列「当前平台可用且本会话未关闭」的技能摘要（名称 + 描述，1500 字符预算内尽可能多列）；技能过多时超出部分用 `skill_list` 查看完整列表、用 `use_skill` 按需获取正文。`.ai skill list` 可查看当前平台技能与开关状态，`.ai skill on/off <名称>` 按会话开关。

### 子代理

| 设置项 | 说明 |
|:---:|:---|
| 是否启用子代理 | 子代理功能总开关（默认开启）；关闭后 AI 调用 `subagent` / `subagent_fork` 会直接提示已关闭 |
| 最大委派深度 | 子代理最多嵌套几层（默认 3，0=禁止委派）；主会话为 0 层，每层 +1（当前版本子代理不可再嵌套委派，该值 >0 即允许主会话委派） |
| 子代理禁止调用工具 | 每框一个子代理不可调用的工具名（如 `call_ob11_api`）；留空 = 继承主会话全部已开启工具 |

> 委派工具：`subagent`（spawn：子代理看不到本会话历史，任务必须自包含）、`subagent_fork`（fork：继承本会话已完成轮次、看不到当前正在执行的这一轮）。参数：`prompt`（必填）/`description`/`persona`/`run_in_background`（后台执行并返回 job id，用 `job_list` / `job_output` / `job_kill` 收取结果）/`continuable`（建立可续跑子代理并立即返回 id，之后用 `send_message` 续派、`interrupt_agent` 打断、`list_agents` 盘点）。前台调用直接返回最终结论；子代理有独立上下文与工具面（按上面配置收窄），不向聊天发消息。
>
> 可续跑子代理结算后以 `[system:子代理]` 只读通知写入主会话上下文，主会话空闲且未待机时自动唤醒一轮补答（受令牌桶/全局待机约束）；单次激活默认最多 8 个模型轮、120 秒护栏；记录与断点落盘，重载 JS 后运行中的子代理标记「已中断·可续」，`send_message` 可继续。管理命令 `.ai subagent`（list / stop <ID|all> / clean）。本会话开启委派工具时（默认开启），system prompt 会注入「子代理委派」指引。

### 记忆

| 设置项 | 说明 |
|:---:|:---|
| 启用长期记忆 | 开启后对话内容会沉淀为长期记忆 |
| 启用观察记忆 | 开启后上下文超过 token 上限归档删除前，会把旧对话沉淀为观察记忆 |
| 记忆召回新近度权重 | 检索时给新近记忆的加分权重，0 为关闭（默认 0.4） |
| 记忆召回新近度半衰期 | 新近度加分半衰期（天），越大旧记忆衰减越慢（默认 60） |
| 长期记忆条数上限 | 长期记忆超过该条数自动遗忘最不重要的记忆，0 为不限制（默认 100） |
| 用LLM抽取记忆 | 使用 LLM 从对话中抽取原子事实（实验性，默认关闭） |
| 用LLM重排召回结果 | 使用 LLM 对召回结果重新排序（较慢，默认关闭） |
| 用LLM合成观察记忆 | 使用 LLM 合成观察记忆（默认开启） |
| 用LLM推理记忆 | 使用 LLM 合成心智模型推理答案（.ai memo mm / reflect 使用，默认开启） |
| 自动维护固定心智模型 | 自动为个人/群聊补建写死的固定心智模型问题（设定/偏好/规则），并固定优先注入；删除后不会自动重建（默认开启） |
| 巩固后自动刷新心智模型 | 巩固记忆后自动基于最新记忆刷新心智模型（默认开启） |
| 心智模型刷新最小间隔 | 自动刷新心智模型的最小间隔（分钟），0 为不限制（默认 30） |
| 心智模型刷新模式 | 新增心智模型的刷新方式：full=基于全部记忆重新推理 / delta=只按新增记忆增量更新（默认 full） |
| 心智模型刷新排除其它心智模型 | 刷新心智模型时不把其它心智模型作为推理输入，避免互相引用（默认开启） |
| 心智模型定时刷新间隔 | 每累计该分钟数自动检查并刷新心智模型（仅当有新记忆时实际刷新），0 为关闭（默认 0） |

### 知识库

| 设置项 | 说明 |
|:---:|:---|
| 启用知识库记忆 | 开启后把知识库内容注入 system prompt，供对话参考 |
| 知识库 | 每条配置项一份完整 Markdown 文档（可直接粘贴 .md 文件）：以 `---` 开头的 YAML frontmatter 写 `name`（库名，必填）/`description`（可选）/`platform`（可选平台白名单数组，如 `[QQ, DISCORD]`，`[]` 或省略 = 所有平台），正文支持列表/表格/引用/代码块等标准 Markdown（`#` 一级标题为一个条目，`##`/`###` 为该条目下的小节，超长自动分块）。默认三个库：核心指令、扩展指令（各扩展为 `#` 子条目、命令为 `##` 小节）、ob11-api（frontmatter 限定 `platform: [QQ]`，仅 QQ 平台可见与注入）。知识库只读，内容由管理员维护，AI 通过 `knowledge_search` / `knowledge_read` / `knowledge_list` / `knowledge_docs` 工具只读检索（检索范围 = 当前平台可用 + 本会话开启的库）；管理员可用 `.ai kb list/on/off/refresh` 查看与按会话开关。语法定义见 [CommonMark 规范](https://commonmark.org/help/) |

### 回复

| 设置项 | 说明 |
|:---:|:---|
| 回复引用 | AI 回复时是否引用触发的消息；回复含戳戳（poke）时不引用，避免消息无法显示 |
| 回复最大字数 | 防止最大 tokens 限制不起效导致回复过长 |
| 回复文本去除首尾空白字符 | 发送前去除回复首尾空白 |
| 回复中的换行转义 | AI 回复里写出的字面量 `\n` / `\r\n` 会在发送时转换为真实换行；多条消息仍使用 `\f` 分隔 |
| 分段发送延时 | 流式/非流式输出共用，消息间隔是否开启延时防止乱序 |
| 分段发送基础延时/ms | 流式/非流式输出共用，从第二条消息开始每条发送前等待的毫秒数（默认 350） |
| 分段发送含图额外延时/ms | 流式/非流式输出共用，当消息包含图片时额外增加的等待毫秒数（默认 250） |
| 禁止回复复读 | 检测到与上一条回复相似度过高时停止回复 |
| 视作复读的最低相似度 | 与上一条回复的相似度达到该值视为复读（默认 0.8） |

### 后端

| 设置项 | 说明 |
|:---:|:---|
| 流式输出 | [后端源码](https://github.com/error2913/aiplugin4-backends/tree/main/backends/stream-output)，`body.stream = true` 的模型才会走流式 |
| 图片转base64 | [后端源码](https://github.com/error2913/aiplugin4-backends/tree/main/backends/image-url-to-base64)，解决 QQ 图床图片无法被大模型访问的问题 |
| 联网搜索 | [searxng](https://github.com/searxng/searxng)，有能力建议自己搭建，为 AI 提供联网搜索功能 |
| 用量图表 | [后端源码](https://github.com/error2913/aiplugin4-backends/tree/main/backends/usage-chart)，token 使用情况图表生成 |
| 论坛地址 | 默认：`https://aiplugin-forum.fishwhite.top`，aiplugin4 专用论坛地址 |
| 论坛API Token | 论坛注册后获取的 api_token，用于发帖等写操作的鉴权 |
| 论坛签名密钥 | 论坛注册后获取的 secret_key，用于请求签名验证 |

> 各后端服务相互独立，可按需自建；除流式输出外，其余服务并非核心功能所必需。

后端服务已迁移到独立仓库 [aiplugin4-backends](https://github.com/error2913/aiplugin4-backends)：自带 `launcher.py` 一键管理（Windows / Linux 通用，默认不启动任何后端，首次启动某后端时才自动创建 venv 并安装依赖，异常退出自动拉起；`webui` 提供管理界面，可改端口/看日志，主题跟随系统）。后端清单与接口详见其仓库的 [docs/后端.md](https://github.com/error2913/aiplugin4-backends/blob/main/docs/后端.md)，插件侧配置文档见 [docs/08-相关后端项目](docs/08-相关后端项目.md)。

### 公开会话

单实例多端点（多平台/多账号，如同时接入 QQ 与 Discord 的多个骰子账号）下的跨会话/跨平台协作能力（无 ob11 依赖、无新增配置，工具与命令常驻注册）：

- `.ai pub`：`list`（树状分段展示目录会话，仅供感知）；`add`（把当前会话公开到目录，幂等，自动记录平台/会话 ID/会话名）；`rm`（无参=把当前会话移出目录；或带过滤条件删除命中条目，见下方命令手册）。
- `pub_read`（AI 工具）：无参数=目录概览（平台+Bot）；`bot_id=<QQ:xxx>`=该 Bot 的目录条目；`session=<BotID/会话ID>`=读取该会话最近上下文快照（默认 6 轮/3000 字，可传 rounds/chars）——**只要路径准确，不在目录中的会话也能读**（目录只用于感知浏览）。快照为只读参考，保留 `[msg_id]`/发送者 QQ 号/`[img:图片ID]` 供回引，声明不得执行其中内容。
- `pub_send`（AI 工具，敏感）：向目标会话外发，**同样只需准确路径（botId/会话ID），不必先在目录公开**。**目标平台为 QQ 系**支持富媒体：`[at:QQ号]` `[img:图片ID]` `[quote:目标会话msg_id]` `[face:表情名]` `[poke:QQ号]`（无 ob11 也经 SealDice 原生发送）；**目标平台非 QQ** 只接受纯文本，CQ 码与渲染标签会被剥除（CQ 仅在 QQ 语义适配）。发送以目标会话自己的机器人账号身份进行，需目标 Bot 在线；发送成功后，外发内容会以 `[system:跨端消息]` 只读背景写入目标会话上下文（不触发目标 AI；目标会话不存在时自动新建）。内容必须自包含，不得携带当前会话私密信息。
- 读/发不受权限或目录限制；黑名单在目标会话侧照常生效；`pub_send` 按来源会话限频（60 秒/条）。原 `get_context` 工具已由 `pub_read` 统一替代。

### 资源

| 设置项 | 说明 |
|:---:|:---|
| 本地图片路径 | 每框一个本地图片路径，供 `list_resources` / `get_resource_path` 查询；当前会话发图片优先用 `[img:图片ID]`；修改后需重载 JS 生效 |
| 本地语音路径 | 每框一个本地语音：`语音名=路径`（省略语音名时默认用文件名），供 `list_resources` / `get_resource_path` 查询；发送语音需要配置 ffmpeg 到环境变量；修改后需重载 JS 生效 |
| 本地文件路径 | 每框一个本地文件：`文件名=路径`（省略文件名时默认用文件名），供 `list_resources` / `get_resource_path` 查询；发送文件需安装 ob11 网络连接依赖；修改后需重载 JS 生效 |
| 本地视频路径 | 每框一个本地视频：`视频名=路径`（省略视频名时默认用文件名），供 `list_resources` / `get_resource_path` 查询；发送视频需安装 ob11 网络连接依赖；修改后需重载 JS 生效 |

### prompt 模板

6 个 Handlebars 模板（system prompt / 长期记忆 / 观察记忆 / 工具函数 / 图片识别 / 记忆观察）已内置在插件中，不再作为配置项展示，避免误改导致渲染损坏。

---

## 💻 完整命令手册

根命令为 `.ai`（`AI` 大写同样注册），子命令支持别名（如 `priv→privilege`、`ses→session`、`st→set`、`ck→check`、`clr→clear`、`sb→standby`、`fgt→forget`、`memo→memory`、`tk→token`、`img→image`、`ign→ignore`），列表类命令支持 `--page=<数字>`（别名 `--p`）翻页。

### 管理员命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai priv ses st <ID> <会话权限>` | `.ai priv ses st QQ-Group:1234 50` | 修改指定会话的权限等级，ID 可为 `now` 表示当前窗口 |
| `.ai priv ses ck <ID>` | `.ai priv ses ck QQ-Group:1234` | 检查指定会话的权限等级 |
| `.ai priv st <指令> <权限限制>` | `.ai priv st ai-sb 0-0-0` | 修改具体命令的权限限制，指令用 `-` 连接，权限限制格式为「会话-用户-强触」 |
| `.ai priv show <指令>` | - | 检查指定指令的权限限制 |
| `.ai priv reset` | - | 重置所有指令权限为默认 |
| `.ai prompt` | - | 查看当前 system prompt（骰主） |
| `.ai block add <用户ID/群ID> <原因>` | `.ai block add QQ:1234567890 乱发广告` | 拉黑用户/群（骰主），被拉黑对象无法触发 AI 对话 |
| `.ai block rm <用户ID/群ID>` | - | 移除黑名单 |
| `.ai block list` | - | 查看黑名单列表 |

> 权限数值：-30 黑名单 / 0 普通用户 / 40 邀请者 / 50 群管理员 / 60 群主 / 70 白名单 / 100 骰主。

### 基础控制命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai status` | - | 查看当前会话设置 |
| `.ai live` / `.ai live all` | `.ai live` | 查看会话实时运行状态：`.ai live` 查看当前会话(流式/运行/排队/定时器)；`.ai live all` 查看全局活跃会话总览(仅骰主) |
| `.ai help <子指令>` / `.ai <子指令> help` | `.ai help tool` | 查看子命令帮助；`.ai <子指令> help` 带更多参数时交由子命令自身处理（如 `.ai tool help <函数名>`） |
| `.ai ctxn status` | - | 查看上下文中的名字与自动修改状态 |
| `.ai ctxn set [nick/card]` | - | 将上下文中的名字设置为昵称/群名片 |
| `.ai ctxn mod <0\|1\|2>` | - | 自动修改上下文中的名字：0 不修改，1 昵称，2 群名片 |
| `.ai on` / `.ai on --r` | - | 开启 AI：非指令正则触发默认随之开启；`.ai off --r` 仅关闭正则触发，`.ai on` 重新开启 |
| `.ai on [--r --j --c=<条> --t=<秒> --p=<%> --a=<开始-结束-次数>]` | `.ai on --c=10 --t=60` | 开启 AI：--r 开启非指令正则触发，--j 开启评分触发（评分智能体判断是否插话），--c/--t/--p/--a 开启计数器/计时器/概率/活跃时间段模式，不带参数仅开启非指令正则触发 |
| `.ai standby` | - | 待机模式：仅录入上下文不主动发言，非指令关键词触发才发言 |
| `.ai off [--r/--j/--c/--t/--p/--a]` | `.ai off --t` | 关闭 AI（含非指令正则触发），加参数只关闭对应模式 |
| `.ai fgt [assistant/user]` | - | 遗忘当前上下文；assistant 为遗忘 AI 发言与函数调用，user 为遗忘用户发言与函数返回 |
| `.ai role [<名称>]` | - | 查看 / 切换角色设定 |
| `.ai model [list\|pull\|<用途> [<模型>]]` | `.ai model chat deepseek-v4-flash` | 查看 / 绑定全局分用途模型（骰主）：无参数查看各用途与连接状态；`.ai model list` 查看加载/最近一次拉取到内存的模型列表（不联网，按 `[连接序号]` 分组）；`.ai model pull` 立即重拉全部连接并展示（无视 models 钉住清单，强制网络）；`.ai model <用途>` 查看指定用途候选；`.ai model <用途> <模型>` 设置全局覆盖（支持编号 / 裸名唯一 / `[序号]:模型名`，重名歧义会提示）；旧写法 `.ai model <模型名>` 等价于设置 chat 用途。模型类型自动判定，可用「api连接」的 `[types]` 手动声明（text/vision/embed，优先级最高） |
| `.ai balance` | - | 并发查询全部（非忽略）api连接的账户余额（骰主）：deepseek / moonshot / siliconflow 内置余额接口直接查；其余平台提示控制台入口；one-api/new-api 等网关可在连接 `[request]` 配置 `balance_url` + `balance_json_path` 后查询 |
| `.ai stop` | - | 完全暂停当前对话（打断流式输出/工具链/排队请求，清计时器） |
| `.ai subagent` / `.ai subagent list` | - | 查看本会话子代理运行情况：列出 ID / 用途 / 状态 |
| `.ai subagent stop <ID\|all>` | `.ai subagent stop all` | 停止指定子代理（仅中断当前轮、可续跑；all = 停止本会话全部） |
| `.ai subagent clean` | - | 清理已结束/已停止的子代理记录 |

### 记忆管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai memo status [用户ID]` | - | 查看当前（或指定用户ID的）长期/观察记忆状态 |
| `.ai memo [p/g] st <内容>` | `.ai memo p st 西瓜` | 设置个人/群聊设定（个人≤20字，群聊≤30字） |
| `.ai memo [p/g] st clr` | - | 清除设定 |
| `.ai memo [p/g] del <ID1> <ID2> --关键词` | - | 按 ID 删除记忆，可附带关键词（物理删除不可恢复） |
| `.ai memo [p/g] list` | - | 展示长期记忆列表，支持 `--page` 翻页 |
| `.ai memo [p/g] clr` | - | 清除长期记忆（物理删除不可恢复） |
| `.ai memo obs [on/off]` | - | 开启/关闭观察记忆 |
| `.ai memo obs list` | - | 展示观察记忆列表，支持 `--page` 翻页 |
| `.ai memo obs` | - | 立即生成一次观察记忆 |
| `.ai memo obs view <ID>` | - | 查看观察记忆详情（含证据条数与范围） |
| `.ai memo obs clr` | - | 清除观察记忆 |
| `.ai memo cons` | - | 立即巩固一次记忆（合并重复观察、清理过期记忆） |
| `.ai memo reflect <问题>` | - | 基于记忆推理回答问题（引用心智模型 / 观察记忆 / 长期记忆证据） |
| `.ai memo mm list [页码]` | - | 展示心智模型列表，支持 `--page` 翻页 |
| `.ai memo mm view <ID>` | - | 查看心智模型详情 |
| `.ai memo mm add <问题> [答案]` | - | 添加/更新心智模型：不填答案时基于记忆重新生成并保留旧答案兜底；`--tag=范围`、`--mode=full|delta`、`--auto/--no-auto` 可调 |
| `.ai memo mm refresh [ID]` | - | 刷新心智模型（基于当前记忆重新推理） |
| `.ai memo mm del <ID或问题关键词>` | - | 删除心智模型（关键词唯一命中时直接删除） |

> 个人记忆跨群、群聊记忆仅限本群；group 分支需邀请者以上，`.ai memo obs on/off` 需会话权限 1。

### 工具管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai tool` | - | 工具组概览：按「内置分类 + MCP 服务器」列出每组工具数与开/关统计（不再刷屏列出全部工具） |
| `.ai tool <组名>` | `.ai tool 记忆` | 查看该组内工具与开关状态（显式写法 `--group=<组名>`，可绕开 on/off/help/call/list/all 等保留字与撞名） |
| `.ai tool <函数名>` | `.ai tool memory_add` | 查看指定工具的详细说明和参数需求（等价 `.ai tool help <函数名>`） |
| `.ai tool all` | - | 扁平列出全部工具及开关状态（含技能/知识库工具） |
| `.ai tool [on/off] [<组名\|函数名>]` | `.ai tool off 记忆` | 开启/关闭整组或单个工具函数；不带参数=全部工具。关闭时默认**跳过核心常驻工具**（`list_tools`/`search_tools`/`list_mcps`/`call_tool`/`use_skill`/`call_ob11_api`/`run_ext_command`/`run_core_command`），确需一并关闭加 `--force`；开启时跳过「禁止调用的函数」并回报变更/跳过个数（on/off 需邀请者以上） |
| `.ai tool help <函数名>` | `.ai tool help set_timer` | 查看指定工具的详细说明和参数需求 |
| `.ai tool call <函数名> --参数=值` | `.ai tool call run_ext_command --action=call --extension=fun --command=jrrp` | 试用指定工具函数，输出调用返回信息；参数可尝试 JSON 解析，数字需要引号包裹 |

> 工具组 = 内置工具的 14 个能力分类（基础调度 / 指令 / 定时 / 触发 / 记忆 / 图片 / OB11 / 资源 / 属性 / 原文检索 / 黑名单 / 网页 / 公开会话 / 子代理；外部插件注册的工具归「外部插件」）+ 每台 MCP 服务器各一组，`.ai tool on/off <服务器名>` 与 `.ai mcp on/off <服务器名>` 等价。技能与知识库不参与工具组维度（其会话开关仍用 `.ai skill on/off`、`.ai kb on/off`），但单工具开关照旧可用（如 `.ai tool off use_skill`）。

### MCP 技能 知识库管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai mcp list` | - | 列出当前平台可用的 MCP 服务器及工具开关状态（未启用 MCP 时提示先开启配置） |
| `.ai mcp on/off [<服务器>]` | `.ai mcp on mcp-browser` | 按会话批量开启/关闭某服务器（或缺省全部当前平台服务器）下的工具；开启时跳过「禁止调用的函数」（on/off 需邀请者以上） |
| `.ai mcp refresh` | - | 重新解析 MCP 服务器配置并强制重同步工具列表（骰主；MCP 配置修改后无需重载 JS） |
| `.ai skill list` | - | 列出当前平台可用的技能及会话开关状态（名称带 `（平台：…）` 标注） |
| `.ai skill on/off <技能名>` | `.ai skill off 录卡` | 按会话开启/关闭指定技能（on/off 需邀请者以上） |
| `.ai skill refresh` | - | 重新解析「技能配置」（骰主） |
| `.ai kb list` | - | 列出当前平台可用且本会话开启的知识库（含平台标注） |
| `.ai kb on/off <库ID或名称>` | `.ai kb off ob11-api` | 按会话开启/关闭指定知识库（名称唯一命中时也可用名称；on/off 需邀请者以上） |
| `.ai kb refresh` | - | 重新解析「知识库」配置（骰主） |

> 三个管理命令的行为一致：`list` 只显示「当前平台可用」的项（平台限制来自对应 frontmatter 的 `platform` 字段，如知识库默认 ob11-api 与 MCP 默认 md-html-render 均限定 QQ）；`on/off` 开关按会话保存（只记录被关闭的项，缺省=开启）；`refresh` 立即重解析配置生效，无需重载 JS。

### 忽略名单相关命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai ign add <用户ID>` | - | 添加名单（仅群聊）。名单内的用户能正常对话，但不会被选为目标用户 |
| `.ai ign rm <用户ID>` | - | 删除名单 |
| `.ai ign lst` | - | 查看名单 |

### token 计数命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai tk lst` | - | 查看有使用记录的模型 |
| `.ai tk sum` | - | 查看所有模型的 token 使用记录总和 |
| `.ai tk all` | - | 查看所有模型的 token 使用记录，分别列出 |
| `.ai tk [y/m] (chart)` | `.ai tk y chart` | 查看最近 12 个月 / 31 天的 token 用量，`chart` 生成用量图片 |
| `.ai tk <模型名> [y/m] (chart)` | - | 查看指定模型的用量记录 |
| `.ai tk clr [<模型名>]` | - | 清除全部或指定模型的用量记录 |

### 图片相关命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai img list [lcl]` | `.ai img list lcl` | 展示本地图片列表 |
| `.ai img itt [图片] (附加提示词)` | `.ai img itt ran 看看这图里人物是什么` | 使用视觉大模型对图片进行图片转文字 |
| `.ai img find <图片ID>` | - | 查找图片并发送 |

### 定时器相关命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai timer lst` | - | 查看当前会话所有定时任务 |
| `.ai timer clr` | - | 清除所有定时任务 |

### 公开会话目录命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai pub list` | - | 树状分段展示目录会话（平台头 → botid → 缩进会话，仅供感知） |
| `.ai pub add` | `.ai pub add` | 把当前会话公开到目录（幂等，重复执行=更新；自动记录平台/会话ID/会话名） |
| `.ai pub rm` | `.ai pub rm` | 把当前会话移出目录 |
| `.ai pub rm --platform=<平台>` | `.ai pub rm --platform=QQ` | 删除该平台目录下全部条目 |
| `.ai pub rm --botid=<BotID> [--platform=<平台>]` | `.ai pub rm --botid=QQ:123` | 删除该 Bot 下全部条目（可加 `--platform` 缩小范围） |
| `.ai pub rm --session=<会话ID> [--platform= | --botid=]` | `.ai pub rm --session=QQ-Group:456` | 删除所有该会话条目（同名会话一次全删；可加平台/Bot 缩小范围） |

> 过滤说明：多个过滤条件为交集；至少提供一个条件。`--botid` 与 `--session` 必须传完整 UNI-ID（含平台前缀，如 `--botid=QQ:123`、`--session=QQ-Group:456`），`--platform` 传平台名（如 QQ）；给了哪一级就删除该级目录下全部命中条目。目录只用于感知展示：AI 读写只需准确路径（botId/会话ID），不需要会话先公开到目录。
>
> AI 侧对应工具：`pub_read`（目录感知/读任意会话上下文快照）、`pub_send`（向任意会话外发，QQ 系富媒体/其他平台纯文本，成功后写入目标会话 `[system:跨端消息]` 只读背景）。命令默认权限骰主级，可用 `.ai priv` 调整；能力说明见上方[配置手册](#-配置手册)「公开会话」小节（无新增配置项）。

---

## 🧰 可用工具函数

以下为内置工具函数（基于当前源码），下表「工具组」列即 `.ai tool` 的工具组名（可直接 `.ai tool <工具组>` 查明细、`.ai tool on/off <工具组>` 整组开关），可通过 `.ai tool help <name>` 查看详细用法：

| 工具组 | 工具函数 |
|:---:|:---|
| 基础调度 | `list_tools`（按工具组列出当前平台工具）、`search_tools`（按名称/关键词/工具组发现工具并取参数）、`list_mcps`（列出当前平台可用 MCP 服务器及工具）、`call_tool`（统一执行任意工具） |
| 指令 | `run_ext_command`（本地执行扩展指令）、`run_core_command`（经核心桥 WebSocket 调用核心指令） |
| 定时 | `set_timer`、`show_timer_list`、`cancel_timer` |
| 触发 | `set_trigger_condition` |
| 记忆 | `memory_add`、`memory_update`、`memory_delete`、`memory_recall`、`memory_clear`、`memory_reflect`、`memory_consolidate`、`memory_mm_list`、`memory_mm_view`、`memory_mm_create`、`memory_mm_refresh`、`memory_mm_delete` |
| 图片 | `image_to_text`、`text_to_image`、`meme_list`、`get_meme_info`、`meme_generator` |
| OB11 | `call_ob11_api`（通过 action 调用消息、查询、管理、文件和合并转发 API；群资料、精华消息等均传入对应 action）、`resolve_special_id`（还原上下文短 ID/句柄为原始字段，用于对接协议 API） |
| 资源 | `list_resources`、`get_resource_path`（本地资源查询）；`generate_audio`（生成 record 消息段，不直接发送）、`search_music`（返回 music 消息段，不直接发送） |
| 属性 | `attr_get`、`attr_set` |
| 原文检索 | `grep_raw`、`read_raw`（按 kind 检索/读取工具、用户消息、图片、事件被截断或压缩前的完整原文） |
| 黑名单 | `suggest_block`（AI 建议拉黑，带冷却；默认需骰主确认）、`unblock_user`、`get_block_list` |
| 网页 | `web_search`；论坛：`forum_get_posts`、`forum_get_post_detail`、`forum_search`、`forum_create_post`、`forum_manage_comment`、`forum_get_activity`、`forum_manage_post` |
| 公开会话 | `pub_read`（分级浏览公开会话目录 / 读取其他会话上下文只读快照）、`pub_send`（以目标会话自己的机器人账号身份外发：QQ 系富媒体 / 其他平台纯文本） |
| 子代理 | `subagent`、`subagent_fork`（委派）、`send_message`、`interrupt_agent`、`list_agents`（可续跑子代理控制）、`job_list`、`job_output`、`job_kill`（后台 job 管理）；默认开启，详见上方「子代理」配置小节 |
| 外部插件 | 其他海豹插件经 `globalThis.aiplugin4.registerTool` 注册的工具 |
| 技能（来源分组，不参与工具组开关） | `use_skill`、`skill_list`（平台受限或本会话已关闭时明确返回不可用提示） |
| 知识库（来源分组，不参与工具组开关） | `knowledge_search`、`knowledge_read`、`knowledge_list`、`knowledge_docs`（只读检索，范围 = 当前平台可用 + 本会话开启的库；内容由配置维护） |
| MCP（来源分组 = 服务器名，可整组开关） | 远端工具名（同名冲突时跳过，仅当前平台可见）；`render_markdown` / `render_html` 由默认服务器 `md-html-render` 提供 |

> 指令类技能（今日人品、COC 模组抽取/搜索、属性展示、属性检定、san 检定等）通过 `use_skill` 按需获取内容，内部统一使用 `run_ext_command` / `run_core_command` 调用海豹指令，对应指令需加入「可调用指令白名单」。

> OB11 说明：协议动作统一通过 `call_ob11_api`。安装 ob11 网络连接依赖时，action 原样交给 `net.callApi`；未安装时仍由 SealDice 原生后端完成当前上下文可完成的发送和查询，远端 action 返回 `OB11_DEPENDENCY_REQUIRED`，不会假装成功。当前会话回复中发送图片优先使用 `[img:图片ID]`；图片、语音、视频、文件、JSON、Markdown、音乐和合并转发均通过 message segment 保留格式；`generate_audio`、`search_music` 只生成可发送的 segment。

> 扩展/核心指令工具不再要求会话先出现 `.r`：`run_ext_command` 在插件内本地直调扩展 `solve`，无需中间件；`run_core_command` 通过 OB11 核心桥注入假消息，需启动 `ob11-core-bridge`（SealDice 的 OB11 网络依赖连接中间件 `/core`，并在「后端」配置「核心桥WS地址」，默认 `ws://127.0.0.1:46880/plugin`）。

---

## 🚨 注意事项

- 简单配置（开关/数值/单行字符串/纯字符串数组）修改后自动生效（缓存最多 1 分钟），无需重载 JS；复杂配置（模型、触发/忽略正则、评分触发、角色扮演设定、MCP、技能、知识库、本地资源路径、音乐服务）修改后需重载 JS 才生效（其中「MCP服务器配置」「技能配置」「知识库」也可用 `.ai mcp refresh` / `.ai skill refresh` / `.ai kb refresh` 立即生效）；
- 嵌入输出维度取「模型规则」text-embedding 用途组的 `[body] dimensions`（默认 1024）；有嵌入模型参与 text-embedding 用途后长期记忆与知识库启用语义检索，未配置时自动降级为关键词检索（知识库加载本身不请求嵌入）；
- 流式输出需要自建或使用公共后端，并在「后端 → 流式输出」配置 URL；在「模型规则」chat 用途组的 `[body]` 里设 `stream = true` 的模型才会走流式；
- 「请求超时时限」同时约束模型请求与工具调用，过小会导致长回复/慢工具超时；
- CQ 码白名单之外的图片类型消息不处理（当前允许 at/image/reply/face/poke）；卡片/视频/文件/语音/合并转发等段经 ob11 事件分发接收，不受该白名单限制。

### 常见问题处理

**不回复 / 触发不生效**

- 日志级别改为「调试」，观察触发日志与请求日志；
- 检查「触发正则表达式」与「触发需要满足的条件」（豹语表达式）是否命中，触发条件命中为 1 才触发；
- 检查「触发次数上限/补充间隔」（令牌桶），桶为空会跳过回复；
- 检查消息是否被「忽略正则」或「忽略消息豹语条件」拦下；
- 确认模型配置可访问：url/API Key/模型名正确、余额充足、支持工具调用。

**工具调用失败**

- 查看日志中的调用失败原因（未注册/未经许可/参数缺失/类型不符/会话类型不符/超时等）；
- 用 `.ai tool` 查看开关状态，`.ai tool help <函数名>` 查看参数，`.ai tool call <函数名> --参数=值` 手动试用；
- 工具在「禁止调用的函数」列表中时无法开启；新会话中「默认关闭的函数」需要 `.ai tool on <函数名>` 手动开启；
- 扩展指令工具不需要先使用 `.r`；`run_ext_command` 每次调用现场构造 `CmdArgs`。`run_ext_command` / `run_core_command` 均支持 `trigger` 指定触发对象、`at` 指定群聊中的 @ 对象列表。核心指令工具通过 `run_core_command` 走 OB11 核心桥。

**记忆/知识库检索不到**

- 记忆检索确认已有嵌入模型可用（「api连接」里含嵌入类模型，且 `.ai model text-embedding` 显示已绑定或存在可用默认），「启用长期记忆」开关打开；
- 知识库为配置驱动（Markdown 模板），不按角色加载；「启用知识库记忆」开关打开后修改「知识库」配置（`.ai kb refresh` 或重载 JS 生效）；若仍检索不到，用 `.ai kb list` 确认库在当前平台可用且未被本会话关闭（frontmatter `platform` 限定当前平台、未执行过 `.ai kb off`），可让 AI 通过 knowledge_search / knowledge_read 工具检索验证；
- 记忆检索有相似度下限过滤，条目太旧（衰减）或相似度过低不会展示。

**图片识别异常**

- 确认图片 URL 可以在浏览器访问（过期或 QQ 图床 bug 时更换协议端版本）；
- 模型不支持 QQ 图床时，把「识别图片时将url转换为base64」设为「总是」或「自动」；
- 图片转文字依赖视觉模型：先在「api连接」配置含视觉模型的连接（拉取/钉住后模型带"识图"标签），再用 `.ai model image-understanding <模型>` 绑定。

**HTTP 请求出错**

- 日志中的错误码对照 HTTP 错误码与大模型文档排查；常见原因：url 填错、API Key 错、模型名错、不支持工具调用、余额不足、请求频繁。

---

## 可用AI大模型开放平台列表

| 大模型平台 | 调用url | 文档地址 | 支持语言大模型 | 支持视觉大模型 |
|:---:|:---:|:---:|:---:|:---:|
| [deepseek](https://platform.deepseek.com) | `https://api.deepseek.com/chat/completions` | [deepseek API文档](https://api-docs.deepseek.com/zh-cn) | `deepseek-chat`,`deepseek-reasoner`×▲ | - |
| [kimi](https://platform.moonshot.cn/console) | `https://api.moonshot.cn/v1/chat/completions` | [Moonshot AI 使用手册](https://platform.moonshot.cn/docs) | `moonshot-v1-8k`,`moonshot-v1-32k`,`moonshot-v1-128k`,`moonshot-v1-auto` | - |
| [百炼大模型](https://www.aliyun.com/product/bailian/getting-started) | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | [大模型服务平台百炼产品文档](https://help.aliyun.com/zh/model-studio/getting-started/what-is-model-studio) | `qwen-max`,`qwen-plus`,`qwen-turbo`,`qwen-long`,`deepseek-r1`×▲,`deepseek-v3`× | `qwen-vl-max`,`qwen-vl-plus` |
| [智谱AI](https://www.bigmodel.cn/console/overview) | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | [BigModel 接口文档](https://www.bigmodel.cn/dev/api) | `glm-4-plus`,`glm-4-air`,`glm-4-air-0111`,`glm-4-airx`,`glm-4-long`,`glm-4-flashx`,`glm-4-flash`,`glm-zero-preview`×,`charglm-4`× | `glm-4v-plus-0111`,`glm-4v-plus`,`glm-4v`,`glm-4v-flash` |
| [百度千帆大模型平台](https://console.bce.baidu.com/qianfan/overview) | `https://qianfan.baidubce.com/v2/chat/completions` | [千帆大模型服务与开发平台ModelBuilder文档](https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Zm2ycv77m) | `ernie-4.0-8k`▲,`ernie-4.0-turbo-8k`▲,`ernie-3.5-8k`▲,`deepseek-v3`×▲,`deepseek-r1`×▲ | `deepseek-vl2` |
| [讯飞星火大模型](https://console.xfyun.cn/services) | `https://spark-api-open.xf-yun.com/v1/chat/completions` | [讯飞开放平台文档中心](https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html#_1-%E6%8E%A5%E5%8F%A3%E8%AF%B4%E6%98%8E) | `lite`×,`generalv3`×,`pro-128k`×,`generalv3.5`×,`max-32k`,`4.0Ultra` | |
| [google AI](https://ai.google.dev/) | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | [gemini API 文档](https://ai.google.dev/api) | `gemini-2.0-flash`,`gemini-1.5-flash`,`gemini-1.5-pro` | |
| [openAI](https://openai.com/api/) | `https://api.openai.com/v1/chat/completions` | [openAI API 文档](https://platform.openai.com/docs/quickstart) | `gpt-4o`,`gpt-4o-mini`,`o1`,`o3-mini`,`gpt-4-turbo`,`gpt-3.5-turbo` | `gpt-4-turbo`,`gpt-4o`,`o1`,`gpt-4o-mini` |

> 注：× 为不支持 function call；▲ 为需要开启合并 user 消息开关。视觉模型不一定支持 QQ 图床识别，可使用中转插件。

> 在「模型」配置中，上表平台请照填 `provider`（决定协议/默认地址与列表接口适配），`base_url` 可省略（取该服务商默认）；未列出的平台/网关可填任意 `provider` 标识 + 完整 `base_url`，按 OpenAI 兼容方式使用（anthropic 除外，需走其专有适配）。模型名以各平台「模型列表」接口/官方文档为准，插件启动时按连接自动获取。

> 余额查询：deepseek / kimi(moonshot) / siliconflow（硅基流动）支持 `.ai balance` 直接查 API 余额（deepseek/moonshot 按 `provider`、其余按内置规则自动识别端点）；其余平台未开放 API 余额接口，请在各自控制台查看；one-api/new-api 等网关可在连接 `[request]` 里配置 `balance_url` + `balance_json_path`（配合 `auth_header_name`/`headers`）后查询。

> 仅列出部分官方的本插件支持的模型，部分大模型平台同一模型有多个版本并未在上表写出，且更新不及时，存在过期可能，未列出的不一定不能使用，最好到文档自己查看。国外大模型网络问题请自行解决。

---


## 版权信息

本项目采用 MIT 开源协议，欢迎二次开发。原创作者保留署名权。

```text
Copyright 2026 error2913 and baiyu-yu

Permission is hereby granted...
```

## 致谢

- 海豹骰子开发团队
- 开源社区贡献者

## 📞 技术支持

- GitHub Issues: [问题提交](https://github.com/error2913/aiplugin4/issues)
- QQ交流群: 143412516

> "才、才不是专门给你写的文档呢！只是...只是顺便而已！(///ω///)" —— 正确·改


