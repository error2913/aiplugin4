# 🎲 AI骰娘4 - SealDice AI插件

- 让你的骰娘活起来

![License](https://img.shields.io/badge/License-MIT-blue)
![Version](https://img.shields.io/badge/Version-4.13.0-green)

## 快速开始

### 1. 下载插件

- 通过 GitHub 下载最新稳定版：[下载链接](https://github.com/error2913/aiplugin4/releases/download)；
- 在 QQ 交流群（940049120）中获取；
- 想体验最新开发版，可以自行编译，见[下载](#下载)。

### 2. 安装插件

- 参考[海豹手册](https://docs.sealdice.com/config/jsscript.html)，在 SealDice WebUI →「JS插件」中上传 `aiplugin4.js`；
- 点击重载，刷新浏览器页面。

### 3. 配置大模型

- 在 WebUI →「JS插件」→「插件设置」中找到 `aiplugin4`，点击展开；
- 进入「模型」分组，在「对话模型」中用 **TOML 格式**填写你的模型，例如：

```toml
name = "deepseek-chat" # 模型名，查看你所用大模型平台的文档
api_key = "sk-xxxx"    # 你的 API Key
use = ["chat"]         # 用途，对话模型填 chat

[body]                 # 可选：覆盖请求参数
temperature = 1
max_tokens = 2048
```

- `provider` / `base_url` 可以省略（deepseek / openai / google / zhipu / alibaba / anthropic / moonshot / xai / mistral / siliconflow 会自动识别），也可以显式填写 `base_url`；
- 图片识别需要配置「图片模型」（`use = ["image-understanding"]`），向量记忆需要配置「嵌入模型」（`use = ["text-embedding"]`，输出维度需与「向量维度」配置一致）；
- 默认对话模型取列表第一项，可在群里用 `.ai model <模型名>` 切换，`.ai model clr` 恢复默认。

### 4. 设置触发与角色

- 在「消息触发」分组中修改「触发正则表达式」，改为你希望的触发方式（默认示例为 @ 骰娘，可直接替换）；
- 在「对话」分组中修改「角色设定名称」和「角色扮演设定」，决定 AI 扮演的角色。

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
    - [对话](#对话)
    - [消息接收](#消息接收)
    - [消息触发](#消息触发)
    - [图片](#图片)
    - [工具](#工具)
    - [记忆](#记忆)
    - [回复](#回复)
    - [后端](#后端)
    - [资源](#资源)
    - [prompt 模板](#prompt-模板)
  - [💻 完整命令手册](#-完整命令手册)
    - [管理员命令](#管理员命令)
    - [基础控制命令](#基础控制命令)
    - [记忆管理命令](#记忆管理命令)
    - [工具管理命令](#工具管理命令)
    - [忽略名单相关命令](#忽略名单相关命令)
    - [token 计数命令](#token-计数命令)
    - [图片相关命令](#图片相关命令)
    - [定时器相关命令](#定时器相关命令)
  - [🧰 可用工具函数](#-可用工具函数)
  - [🚨 注意事项](#-注意事项)
    - [常见问题处理](#常见问题处理)
  - [可用AI大模型开放平台列表](#可用ai大模型开放平台列表)
  - [📜 开发文档](#-开发文档)
    - [项目结构](#项目结构)
    - [常用命令](#常用命令)
    - [添加新工具](#添加新工具)
    - [添加新配置分组](#添加新配置分组)
    - [添加新子命令](#添加新子命令)
    - [添加智能体](#添加智能体)
    - [修改 prompt 模板](#修改-prompt-模板)
    - [发布流程](#发布流程)
  - [版权信息](#版权信息)
  - [致谢](#致谢)
  - [📞 技术支持](#-技术支持)

## 🌟 核心特性

AI骰娘4 是一款运行在 [SealDice](https://docs.sealdice.com/) 上的智能对话插件，基于 OpenAI 兼容 API 开发，深度整合海豹骰子生态的 TRPG 功能：

- **智能对话**：支持上下文感知的 AI 对话、角色设定与示例对话；
- **记忆体系**：长期记忆（向量检索 + 标签/用户/群组过滤）、短期总结记忆、按角色加载的知识库；
- **工具系统**：内置 40+ 工具函数（TRPG 检定、牌堆抽取、消息、图片、禁言、定时器等），支持函数调用与提示词工程两种模式，可接入外部 MCP 服务器与可配置技能；
- **图片处理**：图片识别、表情包管理、Markdown/HTML 渲染为图片、图片盗取与本地图片资源；
- **权限体系**：命令权限（会话/用户/强触三维）与工具权限（禁止/默认关闭/按会话开关）；
- **可观测性**：结构化日志（级别控制、密钥脱敏）、token 用量统计与图表、工具调用审计。

---

## 🛠️ 完整安装指南

### 环境要求

- SealDice v1.4.6+；
  - v1.4.6 分离部署（napcat / llonebot 协议）下图片相关功能存在问题，建议 SealDice v1.5.0+；
- 大模型 API：OpenAI 兼容格式；
- 本地开发：Node.js + npm（构建使用 esbuild，建议使用较新 Node 版本）。

### 下载

- 通过 GitHub 下载最新稳定版：[下载链接](https://github.com/error2913/aiplugin4/releases/download)

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

- [aitts 依赖插件](https://github.com/baiyu-yu/plug-in/blob/main/AITTS.js)：自定义音色的 AI 语音；
- [ob11 网络连接依赖.js](https://raw.githubusercontent.com/error2913/sealdice-plugin-ob11-net-connection/refs/heads/main/dist/ob11%E7%BD%91%E7%BB%9C%E8%BF%9E%E6%8E%A5%E4%BE%9D%E8%B5%96.js)（推荐）或 [http 依赖插件](https://github.com/error2913/sealdice-js/blob/main/HTTP%E4%BE%9D%E8%B5%96.js)：ob11 相关工具（发消息、用户/群信息、禁言、打卡、AI 语音等）；
- [AIDrawing 依赖插件](https://github.com/baiyu-yu/plug-in/blob/main/AIDrawing.js)：AI 生图工具；
- ffmpeg：发送本地语音需要配置到环境变量中。

### 安装

- 参考[海豹手册](https://docs.sealdice.com/config/jsscript.html)进行插件上传安装；
- 部分配置修改后需要**重载 JS** 才生效（本地图片/语音路径、禁止调用的函数、默认关闭的函数、MCP 服务器配置、技能配置等，配置描述中均有注明）。

---

## ⚙️ 配置手册

配置项在 SealDice WebUI 的插件设置中按分组展示，以下键名与当前代码注册的配置一致。

### 模型

| 设置项 | 说明 |
|:---:|:---|
| 对话模型 | TOML 格式，每行一个模型；`name` / `api_key` / `use` 必填，`use` 可选项：`chat`（普通对话）/ `compression`（消息压缩）/ `summarization`（记忆总结）；`provider` / `base_url` 可省略自动识别；默认对话模型取列表第一项；可选 `[body]` 覆盖请求参数 |
| 图片模型 | TOML 格式，`use` 填 `["image-understanding"]`（图片理解），用于图片识别 |
| 嵌入模型 | TOML 格式，`use` 填 `["text-embedding"]`（文本嵌入），输出维度需与「向量维度」配置一致 |

```toml
# 对话模型示例
name = "deepseek-chat"
api_key = "sk-xxxx"
use = ["chat"]
provider = "deepseek" # 可省略，按名称自动识别

[body]                # 可选：覆盖请求参数
temperature = 0.8
max_tokens = 2048
```

> 会话内可用 `.ai model` 查看、`.ai model <模型名>` 切换、`.ai model clr` 恢复默认。

### 基础

| 设置项 | 说明 |
|:---:|:---|
| 日志级别 | 从不 / 错误 / 警告 / 信息 / 调试，反馈问题建议设为「调试」 |
| 日志简短打印 | 日志超长时只保留首尾各 500 字 |
| 日志记录消息内容 | 关闭后请求上下文日志只记录角色与长度，不打印消息正文 |
| 请求超时时限 | 单位毫秒，同时约束模型请求与工具调用，过小会导致长回复/慢工具超时 |
| 海豹核心全局路径 | 本地资源相对路径拼接用的 SealDice 核心目录 |
| 是否开启全局待机 | 开启后全局 AI 进入待机状态（一直接收消息进上下文），可能造成性能问题 |

### 对话

| 设置项 | 说明 |
|:---:|:---|
| 角色设定名称 | 与「角色扮演设定」一一对应，可通过 `.ai role <名称>` 或豹语变量 `$gSYSPROMPT` 切换 |
| 角色扮演设定 | AI 的扮演设定，与「角色设定名称」一一对应 |
| 示例对话 | role 顺序为 user 和 assistant 轮流出现，位于上下文最前面，不会被上下文机制删除 |
| 对话保存轮数 | 出现一次 user 视作一轮，超过轮数会遗忘除示例对话外最早的对话，越长消耗 token 越多 |
| 上下文最大token | 0 为不限制；超过后从最早的消息开始丢弃 |
| 插入system message间隔轮数 | 需小于限制轮数的二分之一才能生效，为 0 时不生效，示例对话不计入轮数 |
| 展示号码 | 在工具描述/上下文显示中使用 QQ 号 |
| 消息压缩阈值 | 用户消息超过该字符数时，使用压缩智能体压缩后存入上下文 |

### 消息接收

| 设置项 | 说明 |
|:---:|:---|
| 接收图片 | 是否接收并识别图片消息，关闭后不处理任何图片消息 |
| 接收指令消息 | 是否将指令消息计入上下文（指令仍会执行） |
| 接收骰子发送的消息 | 是否处理机器人自己发送的消息 |
| 忽略私聊消息 | 开启后私聊消息不触发 AI |
| 忽略消息豹语条件 | 命中为 1 时忽略，可填豹语表达式限制忽略范围 |
| 忽略消息正则表达式 | 匹配的消息不会被接收录入上下文 |

### 消息触发

| 设置项 | 说明 |
|:---:|:---|
| 默认计数器 / 默认计时器 / 默认概率 / 默认触发活跃时间 | `.ai on` 不带参数时使用的默认值；活跃时间格式 `HH:mm-HH:mm-次数` |
| 默认向量相似度 | 记忆检索的相似度下限，0-1 之间 |
| 触发正则表达式 | 匹配符合正则的消息用于强制触发 AI 回复，[正则表达式教程](https://www.runoob.com/regexp/regexp-syntax.html) |
| 触发需要满足的条件 | 豹语表达式，例如 `$t群号_RAW=='2001'` 表示仅允许群 2001 触发；填 1 为无限制 |
| 触发次数上限 | 群内共用令牌桶容量，触发一次减少一计数，计数为 0 时无法触发 |
| 触发次数补充间隔 | 单位秒，按该间隔补充触发次数 |

### 图片

| 设置项 | 说明 |
|:---:|:---|
| 图片全局识别豹语条件 | 填 `'1'` 开启所有图片自动识别转文字；或填豹语表达式限制群/用户范围 |
| 识别图片时将url转换为base64 | 永不 / 自动 / 总是，解决大模型无法正常获取 QQ 图床图片的问题 |
| 图片转文字最大字符数 | 图片转文字后保留的最大字符数 |
| 发送图片的概率/% | 在 AI 触发回复后随机抽取一张本地或偷取的图片发送的概率 |
| 图片识别默认prompt | 识图时的默认提示词 |
| 偷取图片存储上限 | 每个群聊或私聊单独储存 |

### 工具

| 设置项 | 说明 |
|:---:|:---|
| 开启调用函数功能 | 开启后 AI 可使用各种工具 |
| 切换为提示词工程 | 当 API 不支持 function calling 时开启 |
| 允许连续调用函数次数 | 单次触发内允许连续调用函数的次数，防止 AI 陷入调用函数死循环（默认 5） |
| 禁止调用的函数 | 每行一个，设置后将不被允许开启；修改后保存并重载 JS |
| 默认关闭的函数 | 每行一个，AI 在新会话中默认无法调用，需 `.ai tool on <函数名>` 开启；修改后保存并重载 JS |
| 提供给AI的牌堆名称 | 每行一个牌堆名，用于 `draw_deck` 工具；没有的话建议把 `draw_deck` 加入禁止调用 |
| MCP服务器配置 | 每行一个：`名称|URL|Token`，示例 `qq|http://127.0.0.1:8888/mcp|your_token`，或 JSON `{"name":"qq","url":"...","token":"..."}`；修改后重载 JS |
| 技能配置 | 每行一个：`名称|描述|内容`，示例 `骰点|TRPG百分比检定|使用 1d100 进行检定…`，或 JSON；修改后重载 JS |
| ai语音使用的音色 | 预设音色需要支持 AI 语音的协议端，自定义音色需要 aitts 依赖插件和 ffmpeg |

### 记忆

| 设置项 | 说明 |
|:---:|:---|
| 向量维度 | 向量检索的维度，需与嵌入模型输出维度一致 |
| 启用长期记忆 | 开启后对话内容会沉淀为长期记忆 |
| 长期记忆上限 | 长期记忆条数上限，超出后按分数淘汰 |
| 长期记忆展示数量 | 构造记忆 prompt 时展示的长期记忆条数 |
| 启用总结记忆 | 开启后定期对对话进行总结记忆 |
| 总结记忆上限 / 总结记忆间隔轮数 / 总结记忆参与轮数 | 总结记忆条数上限、自动总结间隔、每次总结纳入的对话轮数 |
| 启用知识库记忆 | 开启后按角色加载知识库内容 |
| 知识库记忆展示数量 | 知识库检索后写入 prompt 的条数 |
| 知识库记忆 | TOML 格式，按角色加载（无专属知识时回退全局条目） |

### 回复

| 设置项 | 说明 |
|:---:|:---|
| 回复引用 | AI 回复时是否引用触发的消息 |
| 回复最大字数 | 防止最大 tokens 限制不起效导致回复过长 |
| 回复文本去除首尾空白字符 | 发送前去除回复首尾空白 |
| 禁止回复复读 | 检测到与上一条回复相似度过高时停止回复 |
| 视作复读的最低相似度 | 与上一条回复的相似度达到该值视为复读（默认 0.8） |
| 回复消息过滤正则表达式 | 匹配在 `{{{match.[数字]}}}` 中访问，0 为匹配到的消息，1 之后为捕获组 |
| 正则处理上下文消息模板 | 回复加入上下文时替换匹配到的文本 |
| 正则处理回复消息模板 | 回复发出时替换匹配到的文本 |

### 后端

| 设置项 | 说明 |
|:---:|:---|
| 流式输出 | [后端源码](https://github.com/error2913/aiplugin4/tree/main/%E7%9B%B8%E5%85%B3%E5%90%8E%E7%AB%AF%E9%A1%B9%E7%9B%AE/%E6%B5%81%E5%BC%8F%E8%BE%93%E5%87%BA)，`body.stream = true` 的模型才会走流式 |
| 图片转base64 | [后端源码](https://github.com/error2913/aiplugin4/tree/main/%E7%9B%B8%E5%85%B3%E5%90%8E%E7%AB%AF%E9%A1%B9%E7%9B%AE/%E5%9B%BE%E7%89%87url%E8%BD%ACbase64)，解决 QQ 图床图片无法被大模型访问的问题 |
| 联网搜索 | [searxng](https://github.com/searxng/searxng)，有能力建议自己搭建，为 AI 提供联网搜索功能 |
| 网页读取 | [后端源码](https://github.com/error2913/aiplugin4/tree/main/%E7%9B%B8%E5%85%B3%E5%90%8E%E7%AB%AF%E9%A1%B9%E7%9B%AE/%E7%BD%91%E9%A1%B5url%E5%86%85%E5%AE%B9%E8%AF%BB%E5%8F%96)，为 AI 提供网页详细内容获取功能 |
| 用量图表 | [后端源码](https://github.com/error2913/aiplugin4/tree/main/%E7%9B%B8%E5%85%B3%E5%90%8E%E7%AB%AF%E9%A1%B9%E7%9B%AE/%E7%94%A8%E9%87%8F%E5%9B%BE%E8%A1%A8%E7%BB%98%E5%88%B6)，token 使用情况图表生成 |
| md和html图片渲染 | [后端源码](https://github.com/error2913/aiplugin4/tree/main/%E7%9B%B8%E5%85%B3%E5%90%8E%E7%AB%AF%E9%A1%B9%E7%9B%AE/md%E5%92%8Chtml%E5%9B%BE%E7%89%87%E6%B8%B2%E6%9F%93)，将 Markdown/HTML 渲染为图片 |

> 各后端服务相互独立，可按需自建；除流式输出外，其余服务并非核心功能所必需。

### 资源

| 设置项 | 说明 |
|:---:|:---|
| 本地图片路径 | 每行一个本地图片路径，供 system prompt 列出可发送资源；修改后重载 JS |
| 本地语音路径 | 每行一个本地语音：`语音名=路径`（省略语音名时默认用文件名），供 system prompt 列出；发送语音需要配置 ffmpeg 到环境变量；修改后重载 JS |

### prompt 模板

模板使用 Handlebars 语法，一般不需要修改；若更新后发现新增功能 AI 并不清楚，可以点「刷子」还原默认值：

- system prompt模板、长期记忆prompt模板、总结记忆prompt模板、知识库记忆prompt模板、工具函数prompt模板、图片识别prompt模板、记忆总结prompt模板。

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

> 权限数值：-30 黑名单 / 0 普通用户 / 40 邀请者 / 50 群管理员 / 60 群主 / 70 白名单 / 100 骰主。

### 基础控制命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai status` | - | 查看当前会话设置 |
| `.ai ctxn status` | - | 查看上下文中的名字与自动修改状态 |
| `.ai ctxn set [nick/card]` | - | 将上下文中的名字设置为昵称/群名片 |
| `.ai ctxn mod <0\|1\|2>` | - | 自动修改上下文中的名字：0 不修改，1 昵称，2 群名片 |
| `.ai on [--c=<条> --t=<秒> --p=<%> --a=<开始-结束-次数>]` | `.ai on --c=10 --t=60` | 开启 AI，可同时开启计数器/计时器/概率/活跃时间段模式，不带参数使用默认值 |
| `.ai standby` | - | 待机模式：仅录入上下文不主动发言，非指令关键词触发才发言 |
| `.ai off [--c/--t/--p/--a]` | `.ai off --t` | 关闭 AI（仍可通过正则触发），加参数只关闭对应模式 |
| `.ai fgt [assistant/user]` | - | 遗忘当前上下文；assistant 为遗忘 AI 发言与函数调用，user 为遗忘用户发言与函数返回 |
| `.ai role [<名称>]` | - | 查看 / 切换角色设定 |
| `.ai model [<模型名>]` | `.ai model deepseek-chat` | 查看 / 设置当前会话模型，`clr` 清除设置恢复默认 |
| `.ai shut` | - | 中断当前流式输出 |

### 记忆管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai memo status (@xxx)` | - | 查看当前（或 @ 指定用户的）长期/短期记忆状态 |
| `.ai memo [p/g] st <内容>` | `.ai memo p st 西瓜` | 设置个人/群聊设定（个人≤20字，群聊≤30字） |
| `.ai memo [p/g] st clr` | - | 清除设定 |
| `.ai memo [p/g] del <ID1> <ID2> --关键词` | - | 按 ID 删除记忆，可附带关键词 |
| `.ai memo [p/g/short] list` | - | 展示长期/短期记忆列表，支持 `--page` 翻页 |
| `.ai memo [p/g/short] clr` | - | 清除长期/短期记忆 |
| `.ai memo short [on/off]` | - | 开启/关闭短期记忆 |
| `.ai memo sum` | - | 立即总结一次短期记忆 |
| `.ai memo sum clr` | - | 清除总结记忆 |

> 个人记忆跨群、群聊记忆仅限本群；group 分支需邀请者以上，short 分支需会话权限 1。

### 工具管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai tool` | - | 列出所有工具及开关状态 |
| `.ai tool help <函数名>` | `.ai tool help get_time` | 查看指定工具的详细说明和参数需求 |
| `.ai tool [on/off]` | - | 开启/关闭全部工具函数 |
| `.ai tool [on/off] <函数名>` | `.ai tool on jrrp` | 开启/关闭指定工具函数 |
| `.ai tool call <函数名> --参数=值` | `.ai tool call jrrp --name=错误` | 试用指定工具函数，输出调用返回信息；参数可尝试 JSON 解析，数字需要引号包裹 |

### 忽略名单相关命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai ign add @xxx` | - | 添加名单（仅群聊）。名单内的用户能正常对话，但无法被选中作为作用目标 |
| `.ai ign rm @xxx` | - | 删除名单 |
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
| `.ai img list [stl/lcl]` | `.ai img list stl` | 展示偷取的图片 / 本地图片列表 |
| `.ai img stl [on/off/f]` | - | 开启/关闭图片盗取功能，`f` 遗忘已偷取的图片；不带参数查看状态和数量 |
| `.ai img itt [图片] (附加提示词)` | `.ai img itt ran 看看这图里人物是什么` | 使用视觉大模型对图片进行图片转文字 |
| `.ai img find <图片ID>` | - | 查找图片并发送 |

### 定时器相关命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai timer lst` | - | 查看当前会话所有定时任务 |
| `.ai timer clr` | - | 清除所有定时任务 |

---

## 🧰 可用工具函数

以下为内置工具函数（基于当前源码），可通过 `.ai tool help <name>` 查看详细用法，也可按分类在群里使用：

| 分类 | 工具函数 |
|:---:|:---|
| 记忆 | `add_memory`、`del_memory`、`search_memory`、`clear_memory` |
| 消息 | `send_msg`、`get_msg`、`delete_msg`、`send_forward_msg`、`get_context` |
| 定时 | `get_time`、`set_timer`、`show_timer_list`、`cancel_timer` |
| 触发 | `set_trigger_condition` |
| 语音 | `record`、`text_to_sound` |
| 网页 | `web_search`、`web_read` |
| TRPG | `roll_check`、`san_check`、`jrrp`、`modu_roll`、`modu_search`、`draw_deck` |
| 属性 | `attr_show`、`attr_get`、`attr_set` |
| 图片 | `image_to_text`、`text_to_image`、`meme_list`、`get_meme_info`、`meme_generator`、`render_markdown`、`render_html` |
| QQ 管理 | `ban`、`whole_ban`、`get_ban_list`、`rename`、`group_sign` |
| 群资料 | `get_list`、`get_group_member_list`、`search_chat`、`search_common_group`、`get_person_info` |
| 精华消息 | `set_essence_msg`、`get_essence_msg_list`、`delete_essence_msg` |
| 音乐 | `music_play` |
| MCP / 技能 | `<服务器名>_<工具名>`（MCP 工具）、`use_skill`（技能） |

> 依赖说明：ob11 相关工具需要安装 [ob11 网络连接依赖](https://raw.githubusercontent.com/error2913/sealdice-plugin-ob11-net-connection/refs/heads/main/dist/ob11%E7%BD%91%E7%BB%9C%E8%BF%9E%E6%8E%A5%E4%BE%9D%E8%B5%96.js) 或 [http 依赖插件](https://github.com/error2913/sealdice-js/blob/main/HTTP%E4%BE%9D%E8%B5%96.js)；`text_to_sound` 预设音色需要支持 AI 语音的协议端，自定义音色需要 AITTS 依赖与 ffmpeg；`text_to_image` 需要 AIDrawing 依赖；`music_play` 需要协议端配置音卡签名；`render_markdown` / `render_html` 需要配置 md 和 html 图片渲染后端。

> 依赖海豹内置指令的工具（如 `attr_show`、`roll_check`、`draw_deck`、`send_msg` 等）需要会话中先出现过指令消息（如先使用 `.r`），否则工具会提示"请先使用 .r 指令"。

---

## 🚨 注意事项

- 部分配置修改后需要**重载 JS** 才生效：本地图片路径、禁止调用的函数、默认关闭的函数、本地语音路径、MCP 服务器配置、技能配置等；
- 嵌入模型输出维度必须与「向量维度」配置一致，否则记忆/知识库向量生成会报错；
- 流式输出需要自建或使用公共后端，并在「后端 → 流式输出」配置 URL；`body.stream = true` 的模型才会走流式；
- 「请求超时时限」同时约束模型请求与工具调用，过小会导致长回复/慢工具超时；
- CQ 码白名单之外的图片类型消息不处理（当前允许 at/image/reply/face/poke）。

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
- 依赖海豹指令的工具需要先使用 `.r` 等指令。

**记忆/知识库检索不到**

- 确认「向量维度」与嵌入模型输出一致，且「启用长期记忆/知识库记忆」开关打开；
- 知识库按角色加载，`.ai role` 切换角色后需触发一次加载；
- 记忆检索有相似度下限过滤，条目太旧（衰减）或相似度过低不会展示。

**图片识别异常**

- 确认图片 URL 可以在浏览器访问（过期或 QQ 图床 bug 时更换协议端版本）；
- 模型不支持 QQ 图床时，把「识别图片时将url转换为base64」设为「总是」或「自动」；
- 图片转文字依赖视觉模型配置（「图片模型」TOML，`use = ["image-understanding"]`）。

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

> 在「模型」配置中，上表平台的 `provider` / `base_url` 大多可省略（自动识别），未列出的平台填写 `base_url` 即可使用。

> 仅列出部分官方的本插件支持的模型，部分大模型平台同一模型有多个版本并未在上表写出，且更新不及时，存在过期可能，未列出的不一定不能使用，最好到文档自己查看。国外大模型网络问题请自行解决。

---

## 📜 开发文档

面向开发者的完整项目知识库（架构、核心模块、数据存储、工具系统等）见 [docs/](docs/README.md)。

### 项目结构

```text
aiplugin4/
├── src/                  # TypeScript 源码（插件全部逻辑）
│   ├── index.ts          # 插件入口：装配与事件注册
│   ├── pipeline.ts       # 消息管线（非指令/指令/机器人消息）
│   ├── agent/            # 智能体编排（含流式）
│   ├── cmd/              # .ai 命令系统与权限
│   ├── config/           # 配置注册/读取与静态常量
│   ├── context/          # 会话上下文与消息结构
│   ├── memory/           # 记忆/知识库服务
│   ├── model/            # 对话/图片/嵌入模型与请求 Provider
│   ├── prompt/           # system prompt 分节组装
│   ├── resource/         # 图片资源
│   ├── session/          # 会话/群档案/用户档案
│   ├── tool/             # 工具系统（MCP/技能/内置工具）
│   ├── utils/            # 通用工具函数
│   ├── logger.ts         # 日志模块
│   ├── timer.ts          # 定时器管理
│   ├── update.ts         # 版本更新日志
│   └── usage.ts          # token 用量统计与图表
├── tools/                # 构建脚本（build.js / build-config.js）
├── scripts/              # smoke.js 冒烟、prepare-sealpack.js 打包同步、release-notes.js 发布正文
├── types/                # seal.d.ts（SealDice API 类型定义）
├── dist/                 # 构建产物 aiplugin4.js
├── sealpack/             # SealRepo 打包源（info.toml / assets/icon.png，scripts/main.js 自动同步）
├── 相关后端项目/         # 配套后端服务源码
├── .github/workflows/    # build-check.yml / release.yml
├── header.txt            # 打包时拼接到产物头部的 UserScript 注释
└── package.json
```

### 常用命令

```bash
npm install         # 安装依赖
npm run build       # 生产构建 → dist/aiplugin4.js（头部拼接 header.txt）
npm run build-dev   # 开发构建 → dev/aiplugin4.js（带 sourcemap）
npm run smoke       # 冒烟：在 Node 中用 seal 桩加载 dist/aiplugin4.js
npm run lint        # ESLint 检查 src/**/*.ts
npm run package:check  # 构建 + 同步 sealpack 源 + 校验包格式与体积
npm run pack:sealpack  # 打包 → dist/aiplugin4.sealpack
```

构建使用 esbuild，入口 `src/index.ts`，`external: ['csharp','puerts']`；生产构建不压缩，保持可读、便于用户自行查错。改完核心逻辑建议执行 `npm run build && npm run smoke`。

### 添加新工具

1. 在 `src/tool/tools/` 下新建文件（或放入已有分类目录），导出一个 `registerXxx()` 函数；
2. 创建 `new Tool({ type:'function', function:{ name, description, parameters } })`，实现 `solve(ctx, msg, session, args)`，返回字符串给 AI；
3. 可选配置：`sessionType`（group/user）、`sensitive`（敏感标记）、`ExtCmdInfo`（调用海豹内置指令）；
4. 在 `src/tool/tool.ts` 的 `Tool.registerTool()` 中导入并调用注册函数。

```typescript
// src/tool/tools/tool_say.ts
import Tool from "../tool";

export function registerSay() {
    const tool = new Tool({
        type: "function",
        function: {
            name: "say_hi",
            description: "打招呼",
            parameters: {
                type: "object",
                properties: {
                    arg1: { type: "string", description: "说点什么" }
                },
                required: ["arg1"]
            }
        }
    });
    tool.solve = async (_ctx, _msg, _session, args) => {
        return `你好，${args.arg1}`;
    };
}
```

```typescript
// src/tool/tool.ts 的 registerTool() 中
import { registerSay } from "./tools/tool_say";
registerSay();
```

### 添加新配置分组

1. 在 `src/config/configs/` 下新建文件，定义类，实现 `register()`（用 `seal.ext.registerXxxConfig` 注册）与 `get()`（读取并返回类型化对象）；
2. 在 `src/config/config.ts` 的 `configMap` 中登记该分组；
3. 使用处直接 `Config.<分组>.<字段>` 读取（带缓存）。

可用注册函数：`registerTemplateConfig`（多行文本/模板）、`registerStringConfig`、`registerIntConfig`、`registerFloatConfig`、`registerBoolConfig`、`registerOptionConfig`（下拉）。

### 添加新子命令

1. 在 `src/cmd/sub_cmd/` 新建文件，导出 `registerCmdXxx()`，创建 `new SubCmd('name')`；
2. 设置 `desc`/`help`/`priv`，实现 `solve(scc: SubCmdContext)`，返回 `ret`；
3. 在 `src/cmd/root_cmd.ts` 的 `SubCmd.register()` 中调用注册函数；
4. 如需要子参数权限，在 `priv.args` 中按命令链嵌套声明。

### 添加智能体

1. 在 `src/agent/agents/` 新建文件，导出 `init()`，内部用 `Agent.get(name)` 获取实例并配置 name/description/instruction/use；
2. 在 `src/agent/agents/index.ts` 的 `initAgents()` 中调用；
3. 若需要独立的模型用途（如 `compression`、`summarization`），在模型配置的 `use` 列表中登记对应模型；用途匹配失败会回退到 `chat` 模型。

### 修改 prompt 模板

- 模板在 `src/config/configs/prompt.ts` 中定义默认值（改动需同步更新默认注册内容，WebUI 中「刷子」可还原默认）；
- system prompt 的分节组装逻辑在 `src/prompt/builder.ts`，新增节时需要同步修改模板骨架与构建函数；
- 记忆/知识库/工具段的开关在 `src/memory/manager.ts` 与 `src/config/configs/memory.ts`。

### 发布流程

- `.github/workflows/build-check.yml`：main 分支 push / PR 时执行 lint、tsc strict、构建并校验 sealpack 包、冒烟测试；
- `.github/workflows/release.yml`：推送 `v*` 标签（如 `v4.13.0`）时自动发版：
  1. verify：lint / tsc / `npm run package:check`（构建 + sealpack 校验）/ 冒烟，并校验标签与 `VERSION`、`update.ts` 版本日志一致；
  2. 打包 `.sealpack`（`sealpack pack sealpack`）并上传构建产物；
  3. publish-sealrepo：用 `SEALPACK_TOKEN` 发布到 [SealRepo](https://repo.sealdice.com/)；
  4. github-release：从 `src/update.ts` 提取对应版本日志作为 Release 正文，附带 `aiplugin4-v<版本>.sealpack` 与 `dist/aiplugin4.js`。
- 打包源在 `sealpack/`：`scripts/main.js` 为构建产物自动同步，`info.toml` 的版本由 `scripts/prepare-sealpack.js` 自动同步；
- SealRepo 发布 Token：仓库 Settings → Secrets and variables → Actions → 新建 `SEALPACK_TOKEN`（值在 repo.sealdice.com 后台复制）；包图标放 `sealpack/assets/icon.png`（`info.toml` 已引用）；
- 发版前需同步：`src/config/static_config.ts` 的 `VERSION`、`header.txt` 的 `@version`、`src/update.ts` 的 `updateInfo`（并确认 `updateInfo` 含新版本条目）。

---

## 版权信息

本项目采用 MIT 开源协议，欢迎二次开发。原创作者保留署名权。

```text
Copyright 2024 错误、白鱼

Permission is hereby granted...
```

## 致谢

- 海豹骰子开发团队
- 开源社区贡献者

## 📞 技术支持

- GitHub Issues: [问题提交](https://github.com/error2913/aiplugin4/issues)
- QQ交流群: 940049120

> "才、才不是专门给你写的文档呢！只是...只是顺便而已！(///ω///)" —— 正确·改
