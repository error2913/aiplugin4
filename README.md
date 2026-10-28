# 🎲 AI骰娘4 - SealDice AI插件

- 让你的骰娘活起来

![License](https://img.shields.io/badge/License-MIT-blue)
![Version](https://img.shields.io/badge/Version-4.28.0-green)
![Docs](https://img.shields.io/badge/docs-文档站-blue)

> 📖 **文档站**：<https://error2913.github.io/aiplugin4/> —— 在线阅读体验更好（全文搜索、深色模式、目录导航）。

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
- 在 **模型配置** 中填写**一份 JSON**（出厂默认已带 deepseek 示例，只改 `apiKey` 即可用）：

```json
{
  "version": 5,
  "providers": [
    {
      "api": "openai-completions",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxxx",
      "models": [
        { "id": "flash", "name": "deepseek-v4-flash", "kind": "vision" },
        { "id": "pro",   "name": "deepseek-v4-pro",   "kind": "text" }
      ]
    }
  ],
  "purposes": { "chat": ["flash"], "compression": ["flash"], "summarization": ["flash"], "judge": ["flash"] },
  "groups": [
    { "purposes": ["chat", "compression", "summarization", "judge"],
      "body": { "temperature": 1, "top_p": 1, "max_tokens": 8192, "stop": null, "stream": false } }
  ]
}
```

- **推荐用配置生成器生成后粘贴**：<https://error2913.github.io/aiplugin4-config/> —— 它会按 `baseURL` 拉取模型列表、自动预填 `kind`，并把「用途绑定」可视化；
- `providers[].models` **留空/不写 = 启动时自动拉取**该连接的模型列表（OpenAI 兼容 `GET /models`；`anthropic-messages` 走 `/v1/models` 并自动翻页）；拉取失败按连接降级展示（认证失败/无列表接口/超时），不影响其它连接；离线或没有列表接口的服务，就把模型写死在 `models` 里；
- `models[].kind` 取 `text`/`vision`/`embed`/`gen`/`tts`，**取代旧的 `[types]` 表**。⚠️ **视觉能力不再按模型名猜测**：`gpt-4o`、`gemini`、`qwen-vl` 这类名字**不会**被自动认成视觉模型，要识图必须显式写 `"kind": "vision"`（生成器会自动预填）；嵌入/生图/语音仍可按命名推断；
- `purposes` 是**用途 → 模型 id 的有序数组**：优先用列出的，按此顺序取用（首选失败时顺着往后切）；未列出的同类型模型仍在候选池里、排在后面。留空则由插件取该用途**首个可用**模型；
- 常用命令：`.ai model` 查看各用途当前模型与来源（运行时覆盖 / 配置绑定 / 自动）、`.ai model list` 读当前模型列表（不联网）、`.ai model pull` 立即重拉全部连接（无视 `models` 钉住清单，强制网络）、`.ai model <用途> <模型>` 绑定为该用途的**运行时覆盖**（优先级最高，但只在插件存储里；想进配置就把它填进 `purposes`）；`.ai balance` 可查全部连接余额（deepseek/moonshot/siliconflow 内置接口直接查，其余平台提示控制台入口，见下方[可用AI大模型开放平台列表](#可用ai大模型开放平台列表)的余额说明）；
- `api` 支持 `openai-completions`（默认）与 `anthropic-messages`（Claude，请求/响应格式自动转换：system 拆出、tool_result 合并、响应归一化，流式暂不支持、配 `stream = true` 会回退非流式）。`openai-responses` **本期未实现**，写上会明确报错而不是静默走错协议；
- `provider`（厂商标识）**通常不用填**：由 `baseURL` 的 host 自动识别；只有自动识别失败、且该地址代理某家原生接口时才手工指定；
- **修改「模型配置」后需重载 JS 生效**。

### 4. 设置触发与角色

- 在「触发」分组中修改「触发正则表达式」，改为你希望的触发方式（默认示例为 @ 骰娘，可直接替换）；
- 在「角色设定」分组中修改「角色设定」，决定 AI 扮演的角色（`roles[].name` 为名称，可用 `.ai role <名称>` 切换；`prompt` 为设定内容）。推荐用[配置生成器](https://error2913.github.io/aiplugin4-config/)生成后粘贴。「上下文」分组可调整「预设上下文」「上下文预算」「摘要水位」等上下文参数。

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
    - [触发](#触发)
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
    - [提示词架构（prompt）](#提示词架构prompt)
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
- **记忆体系**：长期记忆（向量检索 + 标签/用户/群组过滤）、观察记忆、配置驱动的知识库（JSON 配置 + Markdown 正文自动分块）；
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

- [ob11 网络连接依赖.js](https://raw.githubusercontent.com/error2913/sealdice-plugin-ob11-net-connection/refs/heads/main/dist/ob11%E7%BD%91%E7%BB%9C%E8%BF%9E%E6%8E%A5%E4%BE%9D%E8%B5%96.js)（推荐）或 [http 依赖插件](https://github.com/error2913/sealdice-js/blob/main/HTTP%E4%BE%9D%E8%B5%96.js)：ob11 相关工具（发消息、用户/群信息、禁言、打卡等）；
- ffmpeg：发送本地语音需要配置到环境变量中。

> 自 4.24.0 起，**语音合成与文生图已内置到本插件**（由「模型」页的模型配置声明 `kind`）。
> 不再需要「生成音频（tts）」「生成图片（tti）」依赖插件；完整包也只附带 ob11 网络连接一个依赖。

### 安装

- 参考[海豹手册](https://docs.sealdice.com/config/jsscript.html)进行插件上传安装；
- 简单配置（开关/数值/单行字符串/纯字符串数组）修改后自动生效（缓存最多 1 分钟），无需重载 JS；复杂配置（模型「模型配置」、触发/忽略正则、评分触发、事件触发规则、「角色设定」、「MCP服务器」、「知识库配置」、本地资源路径、音乐服务）修改后需重载 JS 才生效（其中「MCP服务器」「知识库配置」也可用 `.ai mcp refresh` / `.ai kb refresh` 立即生效）；「技能列表」修改后下一条消息自动生效（也可用 `.ai skill refresh` 强制重解析）。

---

## ⚙️ 配置手册

配置项在 SealDice WebUI 的插件设置中按分组展示，以下键名与当前代码注册的配置一致。

### 模型

模型配置是**一份 JSON**（单个「模型配置」框）。⚠️ **自 4.25.0 起，旧的「api连接」「模型规则」两个 TOML 框已废弃**——插件不再读取它们，请按下方格式重建（推荐用[配置生成器](https://error2913.github.io/aiplugin4-config/)）。

| 设置项 | 说明 |
|:---:|:---|
| 模型配置 | **整份模型配置（一个 JSON）**。顶层字段：`version`（固定 `5`，必填）、`providers`（连接数组，至少 1 项，必填）、`purposes`（用途 → 模型 id 的有序数组）、`groups`（用途组默认请求体）。<br>**`providers[]`**：`api`（必填，`openai-completions` / `anthropic-messages` / `openai-responses`）、`baseURL`（必填，`http(s)://` 开头，**不再兜默认值**）、`apiKey`（必填，明文）、`provider`（厂商标识，**通常不填**，由 `baseURL` 的 host 自动识别）、`models`（该连接的模型；**留空/不写 = 启动时自动拉取**）、`enabled`（默认 `true`；`false`=忽略该连接，取代旧的 `ignore = 1`）、`displayName`（仅展示用）、`timeout`（秒）、`request`（连接级覆盖：`list_url`/`auth_header_name`/`headers`/`balance_url`/`balance_json_path`/`balance_divisor`/`balance_currency`）。<br>**`providers[].models[]`**：`id`（必填，**全局唯一**，被 `purposes` 引用）、`name`（必填，发给 API 的真实模型名，可含 `/` `.` `:`，**不需加引号**）、`kind`（`text`/`vision`/`embed`/`gen`/`tts`，**取代旧的 `[types]` 表**）、`contextWindow`、`maxTokens`、`request`（**per-model** 覆盖：`body`/`request`/`response`/`params`/`prompt`，取代旧的 `models` 定向规则）、`bodyMode`（`merge`/`replace`，媒体用途与内置预设的合成方式）。<br>**`purposes`**：用途 → 模型 id 的**有序数组**（优先用这些、按此顺序；首选失效自动往后切）；留空取该用途首个可用模型。用途取 `chat`/`compression`/`summarization`/`judge`/`image-understanding`/`text-embedding`/`tts`/`image-generation`。<br>**`groups[]`**：`purposes` + `body`，给一组用途预设请求体。校验失败**整份拒绝**（不做部分生效）并一次报出全部问题（带 `$.providers[0].models[1].name` 式路径）。**修改后需重载 JS 生效** |
| 媒体用途（tts / image-generation） | **默认走内置预设**：不写 `request.body` 时，插件按 vendor + 模型名套用该供应商的原生请求结构（覆盖 OpenAI / 硅基流动 / 智谱 / 百炼 / Google Cloud / Gemini / MiniMax / FishAudio / ElevenLabs / 火山方舟 / 腾讯 TokenHub / Stability / 百度 / 本地自建等），骰主只填连接与 `kind` 即可生成。写了 `body` 默认**整体替换**预设结构（`bodyMode: "merge"` 改为逐键合并），用 `{占位符}` 标出可被 AI/命令覆写的字段、用嵌套表表达字段路径（同一个"语速"在阿里是 `input.parameters.rate`、在 Google 是 `audioConfig.speakingRate`）。内置占位符：`{text}`（语音正文）/`{prompt}`（图片正文）/`{negative_prompt}`/`{image}`/`{image_url}`/`{image_base64}`（参考图）/`{model}`/`{api_key}`。取值优先级：**AI/命令传参 > `params.default` > 预设自带默认 > 无值且无默认时整个键不发送**；未在模板里出现的参数一律忽略（模型不支持的参数不会污染请求）。`request`/`response` 是**逐键覆盖**预设（`headers` 逐键合并），只想改一项时不必重写整段 |

```json
{
  "version": 5,
  "providers": [
    {
      "api": "openai-completions",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxxx",
      "models": [
        { "id": "flash", "name": "deepseek-v4-flash", "kind": "vision" },
        { "id": "pro",   "name": "deepseek-v4-pro",   "kind": "text" }
      ]
    }
  ],
  "purposes": { "chat": ["flash"], "compression": ["flash"], "summarization": ["flash"], "judge": ["flash"] },
  "groups": [
    { "purposes": ["chat", "compression", "summarization", "judge"],
      "body": { "temperature": 1, "top_p": 1, "max_tokens": 8192, "stop": null, "stream": false } }
  ]
}
```

多个连接（含语音/生图）就再往 `providers` 数组里加项——**模型嵌在连接内**，不会出现"引用了不存在的连接"这类错误：

```json
{
  "version": 5,
  "providers": [
    { "api": "openai-completions", "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-xxxx",
      "models": [{ "id": "flash", "name": "deepseek-v4-flash", "kind": "vision" }] },

    { "api": "openai-completions", "baseURL": "https://api.siliconflow.cn/v1", "apiKey": "sk-yyyy",
      "models": [
        { "id": "sf-tts",   "name": "FunAudioLLM/CosyVoice2-0.5B", "kind": "tts" },
        { "id": "sf-image", "name": "black-forest-labs/FLUX.1-schnell", "kind": "gen" }
      ] },

    { "api": "openai-completions", "baseURL": "https://tsn.baidu.com/text2audio", "apiKey": "APIKey:SecretKey",
      "models": [{ "id": "baidu-tts", "name": "baidu-tts", "kind": "tts" }] }
  ],
  "purposes": { "chat": ["flash"], "tts": ["sf-tts", "baidu-tts"], "image-generation": ["sf-image"] }
}
```

**改默认值 / 声明参数**：写在该模型的 `request` 里（`params` 是给 AI 看的元信息，`body` 是请求模板；预设里已有的 `{voice}`/`{rate}` 等占位符本就可被 AI/命令覆写）：

```json
{ "id": "sf-tts", "name": "FunAudioLLM/CosyVoice2-0.5B", "kind": "tts",
  "request": {
    "params": { "voice": { "default": "longxiaochun", "desc": "音色" },
                "rate":  { "default": 1.0, "min": 0.5, "max": 2.0, "type": "number", "desc": "语速" } },
    "prompt": { "extra": "本模型语速 0.5~2.0，超过会报错。" }
  } }
```

内置预设按 **vendor + 模型名**给出该供应商的原生结构，已覆盖：

| 用途 | 已内置结构的 provider |
| --- | --- |
| 语音合成 | `openai` / `siliconflow` / `zhipu` / `dashscope`（兼容模式）/ `alibaba` / `minimax`（hex 输出）/ `fishaudio` / `elevenlabs`（音色进地址 + `xi-api-key`）/ `google-cloud`（`text:synthesize`）/ `google` / `baidu`（短文本在线合成，双密钥换 token） |
| 文生图 | `openai`（`gpt-image-*` 与 `dall-e` 分开）/ `volcengine` / `tencent-tokenhub` / `zhipu` / `alibaba`（兼容模式）/ `dashscope`（原生 `wanx*` 异步轮询、`qwen-image*` 同步）/ `siliconflow` / `gemini` / `stability`（core / ultra）/ `custom`（本地 SD WebUI） |

未收录的 vendor 一律按 **OpenAI 兼容**结构处理。也就是说：**只要在 `providers` 里填好 `baseURL`（根地址，如 `https://api.siliconflow.cn/v1`）+ `apiKey`，再给模型声明 `kind: "tts"` / `"gen"`，语音与图片就能直接生成**（`provider` 一般不用填，由 `baseURL` 自动识别）。

> **百度短文本语音合成**（`baseURL` 为 `tsn.baidu.com` 时自动识别为 `baidu`）是个例外：它的鉴权是 `access_token` 而非 API Key，插件按连接自动换取（30 天有效、按连接缓存复用，同一连接不会反复请求），所以 `apiKey` 有两种填法：
> - `"APIKey:SecretKey"` —— 直接填控制台的 **API Key** 和 **Secret Key**（冒号分隔），插件自动换取并缓存 `access_token`；
> - `"<access_token>"` —— 手头已有令牌时直填（不触发换取）。
>
> 密钥本身含冒号时用 `\:` 转义；出现 2 个以上未转义冒号会被视为写法非法、整体当令牌使用（不会猜着拆）。百度没有 `/models` 列表，**必须**把模型写死在 `models` 里并声明 `kind: "tts"`：
>
> ```json
> { "api": "openai-completions", "baseURL": "https://tsn.baidu.com/text2audio",
>   "apiKey": "你的APIKey:你的SecretKey",
>   "models": [{ "id": "baidu-tts", "name": "baidu-tts", "kind": "tts" }] }
> ```
>
> 音色用 `params.voice` 传百度的 `per` 编号（默认 `5003` 度逍遥精品；`0`=度小美、`4189`=度涵竹），语速/音调/音量对应 `rate`/`pitch`/`volume`（`0~15`，默认 `5`）——都可在 `.ai tts` 用 `--voice=` / `--rate=` / `--pitch=` / `--volume=` 或工具参数覆写。音色编号完整列表见[百度音色列表文档](https://cloud.baidu.com/doc/SPEECH/s/Rluv3uq3d)。

接口与预设不一致时才写 per-model 覆盖（示例：阿里原生语音 + 自定义参数约束）：

```json
{ "id": "cosy", "name": "cosyvoice-v1", "kind": "tts",
  "request": {
    "body": {                                  // 默认整体替换预设结构；"bodyMode": "merge" 改为逐键合并
      "model": "cosyvoice-v1",                 // 固定值，AI 不可改
      "input": {
        "text": "{text}",                      // 内置占位符：语音正文
        "voice": "{voice}",                    // 自定义占位符：AI/命令可覆写
        "parameters": { "rate": "{rate}", "pitch": "{pitch}" }   // 阿里的嵌套结构由配置表达，代码零分支
      }
    },
    "params": {                                // 可选：AI 可覆写参数的元信息（省略时从 {占位符} 自动推断）
      "voice": { "default": "longxiaochun", "desc": "音色" },
      "rate":  { "default": 1.0, "min": 0.5, "max": 2.0, "type": "number", "desc": "语速" }
    },
    "prompt": { "extra": "本模型语速 0.5~2.0，超过会报错。" },   // 可选：给 AI 的额外自由提示词，原样注入
    "request": {                               // 可选：逐键覆盖预设。url=绝对地址；urlSuffix=拼在 baseURL 之后
      "url": "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
    },
    "response": {                              // 可选：逐键覆盖预设的取数规则
      "data_path": "output.audio.data",        // 音频在返回里的路径；留空=整个响应体即数据（如 TTS 音频流）
      "data_type": "base64",                   // auto / url / base64 / hex
      "error_message_path": "message"
    }
  } }
```

> 模型类型判定优先级：**`models[].kind` 显式声明 > 命名终值（reranker/生图/语音/嵌入白名单） > 接口自报能力位 > 兜底纯文本**。⚠️ **视觉能力不再按命名猜测**——`gpt-4o`/`gemini`/`qwen-vl` 这类名字**不会**被自动认成视觉模型，要进识图候选必须在配置里显式写 `"kind": "vision"`（生成器会自动预填；接口自报能力位 `vision` 仍作正向证据）。模型按类型进各用途候选：`text`/`vision` 进对话候选（`vision` 另进识图候选）；嵌入白名单命名（如 `text-embedding-*`/`bge-*`）进嵌入候选；生图白名单命名（如 `gpt-image-*`/`wanx*`/`flux*`/`stable-diffusion*`）进生图候选；语音白名单命名（如 `tts-*`/`*-tts`/`cosyvoice*`/`fish-speech*`）进语音候选；reranker 不进任何候选。
>
> 用途绑定：`purposes` 里写**模型 id 的有序数组**（优先用这些、按此顺序，首选失效自动往后切）；留空则取该用途首个可用模型。`.ai model` 查看各用途当前模型与来源（运行时覆盖 / 配置绑定 / 自动）、`.ai model list` 读当前模型列表（不联网、不持久化）、`.ai model pull` 立即重拉全部连接（无视 `models` 钉住清单，强制网络）、`.ai model <用途>` 查看候选（按取用顺序编号）、`.ai model <用途> <模型>` 设为**运行时覆盖**（优先级最高，存插件存储、重装会丢；想进配置就填进 `purposes`）。
>
> 嵌入输出维度取该模型 `request.body` 里的 `dimensions`（默认 1024）；配置后长期记忆与知识库启用语义检索，未配置/不匹配自动降级为关键词检索。

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
| 自动切换策略 | 跨厂商优先 = 优先切到不同服务商的模型；连接顺序 = 按 `providers` 顺序 / 候选顺序取下一个不同模型 |
| 切换后发送通知 | 自动切换模型后用 `ctx.notice` 向当前会话发送一条切换通知（默认开启） |

### 角色设定

| 设置项 | 说明 |
|:---:|:---|
| 角色设定 | 整份角色设定配置（JSON v1）：`{"version":1,"roles":[{"name":"角色名","prompt":"设定内容"}]}`。`name` 超过 20 字符自动截断；可通过 `.ai role <名称>` 或豹语变量 `$gSYSPROMPT` 切换。推荐用[配置生成器](https://error2913.github.io/aiplugin4-config/)「角色设定」页生成后粘贴；修改后需重载 JS 生效 |

### 上下文

> 上下文采用只追加账本；压缩只生成摘要、不删除原文，模型可用 read_raw 回查。

| 设置项 | 说明 |
|:---:|:---|
| 预设上下文 | 每框一条预设上下文，role 按 user / assistant 轮流出现，位于上下文最前面，帮助模型学习对话语气 |
| 上下文预算 | 上下文 token 预算（默认 0）；0 = 跟随报错探测到的模型真实窗口 × 0.8（未探测到回退 100 万），显式正数优先 |
| 摘要水位 | 后台滚动摘要的积压 token 水位（默认 6000）；0 = 关闭自动摘要 |
| 待机入库配额 | 待机会话每小时最多入库多少条普通群消息（默认 0=不限制） |
| 每小时后台压缩上限 | 每小时最多自动压缩次数（默认 6）；0=不限 |

> 旧版「上下文最大token / 对话保存轮数 / 窗口上限字数 / 冷态窗口字数 / 消息压缩阈值 / 结算水位…」等键已不再注册；升级后请按新键重新配置。

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

### 触发

| 设置项 | 说明 |
|:---:|:---|
| 默认计数器 / 默认计时器 / 默认概率 / 默认触发活跃时间 | `.ai on` 不带参数时使用的默认值；活跃时间格式 `HH:mm-HH:mm-次数` |
| 触发正则表达式 | 匹配符合正则的消息用于强制触发 AI 回复，[正则表达式教程](https://www.runoob.com/regexp/regexp-syntax.html) |
| 触发需要满足的条件 | 豹语表达式，例如 `$t群号_RAW=='2001'` 表示仅允许群 2001 触发；填 1 为无限制 |
| 触发次数上限 | 群内共用令牌桶容量，触发一次减少一计数，计数为 0 时无法触发 |
| 触发次数补充间隔 | 单位秒，按该间隔补充触发次数 |
| 事件触发规则 | JSON v1：一条规则只绑一个扁平事件名（`group_increase`/`poke`/`group_request` 等，不再用 `notify.*`、不再支持多事件数组），按「事件接收」页的开关/白名单/待机录入上下文后，命中即让会话对事件做出响应（顺序 = 优先级，首条命中）。空规则 = 关闭；修改后需重载 JS 生效。依赖「接收依赖通知事件」开启 + 事件在白名单 + 会话已 .ai on（待机）；group_request（加群申请）为主场景，friend_request 可能因非好友无法投递回复。格式推荐用[配置生成器](https://error2913.github.io/aiplugin4-config/)生成 |

### 图片

| 设置项 | 说明 |
|:---:|:---|
| 图片全局识别豹语条件 | 填 `'1'` 开启所有图片自动识别转文字；或填豹语表达式限制群/用户范围 |
| 识别图片时将url转换为base64 | 永不 / 自动 / 总是，解决大模型无法正常获取 QQ 图床图片的问题 |
| 图片识别展示截断字数 | 图片识别转文字结果超过该字数时不再压缩，改为仅展示开头部分；完整识别原文保留，可用 `read_raw kind=image` 按图片 ID 阅读（0 为不截断不保留，默认 5000） |
| 工具产出图片自动类型标签 | 生图/表情包/MCP 图片等工具产出的新图片入库时，按产出者自动打英文类型标签（`ai-generated` / `meme` / `mcp-image` / `tool-image`）；不调用识图模型（默认开） |
| 自动类型标签每图上限 | 每张工具产出图片最多自动打几个类型标签（1~4，默认 2） |
| 模型图片单边上限 / 模型图片目标长边 | 模型能接受的单边像素（默认 8192，0=不检查）与交给模型前缩放到的长边（默认 2048）。图床 1.0.16+ 会按目标长边提供 `/m` 模型变体；超限图只保留 `[img:ID]` 文本 |
| 每轮最多图片数 / 每条工具结果最多升格图片数 | 默认 8 / 4（0=不限）；防止一轮几十张图撑大请求 |
| 单张内联上限KB / 每轮内联总字节KB / 每轮最多内联图片数 | 下载失败等异常路径改为内联时只允许 `/m` 模型变体，默认单张 1MB、整轮 4MB、最多 4 张，超限只留文本（防 413） |
| 模型工具结果图片 | 是否允许 tool 消息携带图片块（默认开；部分网关不支持 tool 图可关） |
| 图片被模型拒绝时自动降级 / 图片降级通知 | 模型报「不支持的图片」时定位并标记该图为模型不可用、改为文本标签重发本轮，可通知骰主；`.ai img unmark <图片ID\|all>` 清除标记 |

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
| 媒体任务并发上限 | 同时进行的语音/图片生成任务数上限（默认 3）；超出的任务排队等待 |
| 媒体生成同步等待秒数 | 调用生图/语音工具后先等待这么多秒看是否已出结果（默认 5）：期间生成完就**当场返回结果**、不再走异步通知；超时未完成则返回任务号，生成完再自动通知并唤醒 AI。填 0 关闭等待（一律走异步） |
| （仅 AI 调工具受影响） | 该等待只作用于 `generate_audio` / `text_to_image` 工具调用；命令 `.ai tts` / `.ai tti` 始终由插件直接投递，与它无关 |

> 自 4.24.0 起「ai语音使用的音色」下拉已移除，请按链路区分：
> **协议端自带 AI 语音**（下拉里的小新/猴哥/妲己…等角色，由 NapCat/Lagrange 实现、无需配置模型）——AI 现在直接用 `call_ob11_api` 调 `get_ai_characters`（查角色）/ `send_group_ai_record`、`send_private_ai_record`（发送）/ `get_ai_record`（只取语音 URL）；用法与常见角色名见默认知识库 ob11-api。
> **插件自建 TTS**（下拉里的「自定义」，已内置）——内置预设里已经带 `{voice}` 占位符，音色改该模型 `request.params.voice` 的 `default` 或生成时传 `--voice`（`.ai tts`）/工具参数 `voice`（AI）即可。

### 联网

| 设置项 | 说明 |
|:---:|:---|
| 联网配置 | 联网搜索/抓取配置（v1，一个 JSON）。**留空 = 使用内置 SearXNG**（`https://searxng.fishwhite.top`）。内置方言：DeepSeek / SearXNG / Kimi / Brave / Tavily / Serper / 博查 / 智谱 / Exa / Firecrawl / 自定义 generic；`providers` 顺序即尝试顺序（失败自动回退），`routes` 可分别指定搜索/抓取顺序。推荐用[配置生成器](https://error2913.github.io/aiplugin4-config/)的「联网搜索」页生成后粘贴；修改后需重载 JS 生效。**返回条数 / 详细程度 / 超时 / 正文截断 / 失败回退不写进 JSON**，见下方 5 个独立配置项 |
| 联网搜索返回条数 | 默认返回条数，1~50（默认 10）；工具调用未指定 `count` 时使用 |
| 联网搜索详细程度 | `snippet` 短摘要 / `summary` 长摘要 / `content` 正文（默认 `summary`）；工具未指定 `detail` 时使用 |
| 联网搜索超时 | 单次搜索/抓取默认超时秒数（默认 20）；provider 自己的 `timeout` 优先 |
| 联网搜索正文截断 | `detail=content` 时单条正文最大字符数（默认 5000） |
| 联网搜索失败回退 | 失败时自动换下一个 provider（默认开启）；关闭后只试第一个，便于排障 |

> AI 侧工具：`web_search`（搜索，支持 `allowed_domains` / `blocked_domains` / `time_range` / `detail`，失败自动换 provider）与 `web_fetch`（抓取网页正文，按 `start_index` 续读）。模型厂商自带的托管搜索（OpenAI / Anthropic / Gemini / xAI / Qwen）默认不启用，属于模型请求参数，见 docs/18 §6.8。

### MCP

| 设置项 | 说明 |
|:---:|:---|
| 是否启用MCP | MCP 功能总开关，默认关闭；开启后才会解析并连接下方「MCP服务器」中的服务器并注册其工具，未安装对应 MCP 后端时建议保持关闭 |
| MCP服务器 | **标准 MCP 配置 JSON**（与 Claude Desktop / Cursor 的 `.mcp.json` 顶层结构一致）：`{"mcpServers":{"服务器名":{"type":"http","url":"…","headers":{…}}}}`。键 = 服务器名；`type` 仅支持 `http` / `streamable-http`，stdio（`command`）与 SSE 会被跳过；`platform` 是 aiplugin4 扩展字段（可选平台白名单，`[]` 或省略 = 所有平台）；`exposeInstructions`（可选，默认 `false`）= 是否把服务器 `initialize` 返回的 `instructions` 以低权威 runtime 段注入提示词（外部清洗、单服务器 ≤1000 字符、合计 ≤2000 字符）。生成器里用「启用」开关控制是否写入，关闭的服务器不会出现在 JSON 里（不写 `enabled` 字段）。工具名称、描述、参数 schema 与 `annotations` 连接后经远端 `tools/list` 自动发现并注册（来源分组 = 服务器名；`destructiveHint=true` 的工具按敏感工具处理），同名冲突自动跳过；服务器 platform 与当前平台不匹配时其工具不可见且调用被拦截。MCP prompts/resources 通过 `.ai mcp prompt list|get` 与 `mcp_list_resources`/`mcp_read_resource` 按需使用，不会自动注入 system prompt。**插件默认空配置（不预置服务器）**，避免没配 MCP 时启动/对话报错；配置生成器的「MCP」页仍保留三台示例：mcp-files-exec（read_file/list_dir/write_file/delete_file/download_file/run_shell/export_file，相对路径与命令工作目录按 AI 会话隔离）、md-html-render（platform: [QQ]，render_markdown/render_html）、mcp-browser（browser_navigate/click/type/snapshot/take_screenshot/wait_for/close 等浏览器操作，按 AI 会话隔离），按需复制使用。格式定义见 [MCP 官方规范](https://modelcontextprotocol.io/specification/latest)；推荐用[配置生成器](https://error2913.github.io/aiplugin4-config/)「MCP」页生成后粘贴 |
| MCP会话空闲回收分钟 | MCP 会话（含浏览器操作）空闲超过该分钟数后自动回收，释放服务端浏览器状态；设为 0 不回收（默认 10） |
| MCP每服务器最大会话数 | 每个 MCP 服务器最多同时保留的 AI 会话数，超出后按最近使用时间回收最旧会话；浏览器操作按 AI 会话隔离（默认 3） |

```json
{
  "mcpServers": {
    "mcp-files-exec": {
      "type": "http",
      "url": "http://127.0.0.1:3910/mcp",
      "headers": { "Authorization": "Bearer token" },
      "platform": []
    }
  }
}
```

> MCP 配置修改后用 `.ai mcp refresh` 立即重新解析并强制重同步工具列表（refresh 需骰主，或重载 JS）；`.ai mcp list` 查看当前平台可用服务器及工具开关状态；`.ai mcp on/off [<服务器>]` 按会话批量开启/关闭某服务器（或缺省全部当前平台服务器）下的工具（on 时跳过「禁止调用的函数」）。
>
> `run_core_command` 由插件本地注册，通过「后端 → 后端配置」的 `backends.ob11-core-bridge` 直连 `ob11-core-bridge`（默认 `ws://127.0.0.1:46880/plugin`）；`run_ext_command` 仅由插件本地实现。二者不由 MCP 提供。

### 技能

| 设置项 | 说明 |
|:---:|:---|
| 技能列表 | 整份技能配置（JSON v1）：`{"version":1,"skills":[{"name":"技能名","description":"摘要","platform":["QQ"],"content":"技能正文"}]}`。`platform` 省略或 `[]` = 所有平台；`name` 唯一；`description` 省略/为空时自动取正文首段。生成器「技能」页支持直接拖入标准 `SKILL.md`（`---` frontmatter + 正文）转成 JSON，推荐生成后粘贴。默认只含 `Character Card Import` 技能（Excel 角色卡录入，摘要/正文为英文）；SealDice 核心/扩展指令与 OB11 API 的调用帮助已作为默认知识库提供（「知识库」页签默认库：`Core Commands` / `Extension Commands` / `ob11-api`）。配置修改后下一条消息自动生效（也可用 `.ai skill refresh` 强制重解析） |

> system prompt 的「Available skills」段只列「当前平台可用且本会话未关闭」的技能摘要（名称 + 描述，1500 字符预算内尽可能多列，单条描述超过 240 字符截断；描述为空自动取正文首段）；技能过多时超出部分用 `skill_list` 查看完整列表、用 `use_skill` 按需获取正文（支持 `offset` 续读超长正文）。`.ai skill list` 可查看当前平台技能与开关状态，`.ai skill on/off <名称>` 按会话开关。配置修改后下一条消息自动生效。

### 子代理

| 设置项 | 说明 |
|:---:|:---|
| 是否启用子代理 | 子代理功能总开关（默认开启）；关闭后 AI 调用 `subagent` / `subagent_fork` 会直接提示已关闭 |
| 最大委派深度 | 子代理最多嵌套几层（默认 3，0=禁止委派）；主会话为 0 层，每层 +1（当前版本子代理不可再嵌套委派，该值 >0 即允许主会话委派） |
| 子代理禁止调用工具 | 每框一个子代理不可调用的工具名（如 `call_ob11_api`）；留空 = 继承主会话全部已开启工具 |

> 委派工具：`subagent`（spawn：子代理看不到本会话历史，任务必须自包含）、`subagent_fork`（fork：继承本会话已完成轮次、看不到当前正在执行的这一轮）。参数：`prompt`（必填）/`description`/`persona`/`run_in_background`（后台执行并返回 job id，用 `job_list` / `job_output` / `job_kill` 收取结果）/`continuable`（建立可续跑子代理并立即返回 id，之后用 `send_message` 续派、`interrupt_agent` 打断、`list_agents` 盘点）。前台调用直接返回最终结论；子代理有独立上下文与工具面（按上面配置收窄），不向聊天发消息。
>
> 可续跑子代理结算后以 `[system:subagent]` 只读通知写入主会话上下文，主会话空闲且未待机时自动唤醒一轮补答（受令牌桶/全局待机约束）；单次激活默认最多 8 个模型轮、120 秒护栏；记录与断点落盘，重载 JS 后运行中的子代理标记「已中断·可续」，`send_message` 可继续。管理命令 `.ai subagent`（list / stop <ID|all> / clean）。本会话开启委派工具时（默认开启），system prompt 会注入「Sub-agent delegation」指引。

### 记忆

| 设置项 | 说明 |
|:---:|:---|
| 启用长期记忆 | 开启后对话内容会沉淀为长期记忆并注入 |
| 启用观察记忆 | 开启后将多条事实巩固为观察记忆（证据/证据数/历史） |
| 自动记忆抽取 | AI 触发后自动抽取事实；关闭后仅命令/工具写入 |
| 群聊自动写个人记忆 | 群聊中关于用户的稳定事实写入其个人记忆（隐私敏感，默认关） |
| 本体自动抽取 | 从助手经验/纠正中抽取全局本体记忆（隐私敏感，默认关） |
| 启用全局记忆 | 注入/命令使用本体（global）记忆；无数据零成本 |
| 自动维护固定心智模型 | 为个人/群聊/本体补建固定模板并首次生成（默认开启） |
| 巩固后自动刷新心智模型 | 巩固后仅对标签重叠且已过期的模型刷新（默认关闭，对齐 Hindsight） |
| 心智模型刷新模式 | full=全部记忆重新推理（默认）/ delta=只喂新增记忆做类型化编辑 |
| 心智模型刷新最小间隔 | 同一模型两次自动刷新的最小分钟数；0=不限（默认 0，建议开自动刷新时设 30） |
| 心智模型失败冷却 | 刷新失败后暂停自动重试的分钟数（默认 30） |
| 心智模型输出上限 | 单次刷新/合成输出 token 上限（默认 2048） |
| 增量模型定期重建 | delta 模型定期 full 重建的小时数（默认 48） |
| 心智模型刷新排除其它心智模型 | 刷新时不把其它心智模型作为输入（默认开启） |
| 记忆召回新近度权重/半衰期 | 检索新近度加分权重与半衰期（默认 0.4 / 60 天） |
| 记忆召回语义相似度下限 | 语义通路最低 cosine（默认 0.35） |
| 长期记忆条数上限 | 安全阀，超过后按失效/覆盖/衰减淘汰，0 不限制（默认 300） |
| 记忆注入 token 预算 | 单轮注入记忆总预算（默认 3000） |
| 观察记忆过期天数 | 无新证据超过该天数的观察不注入（不删除，默认 90） |
| 后台记忆 LLM 每小时上限 | 后台抽取/巩固/刷新每小时最多调用次数；0 不限（默认 20） |
| 用LLM重排召回结果 / 合成观察 / 推理记忆 | 三个独立回调开关（重排默认关，后两者默认开） |

> 实现细节（三层 bank、可见性矩阵、调度器门控、迁移与排障）见开发者文档 [13-记忆系统](docs/13-记忆系统.md)；命令语法见 [05-命令与配置](docs/05-命令与配置.md)。

### 知识库

| 设置项 | 说明 |
|:---:|:---|
| 启用知识库记忆 | 开启后把知识库内容注入 system prompt，供对话参考 |
| 知识库配置 | 整份知识库配置（JSON v1）：`{"version":1,"libraries":[{"name":"库名","description":"描述","platform":["QQ"],"content":"Markdown 正文"}]}`。`platform` 省略或 `[]` = 所有平台；`name` 唯一；描述省略时用正文首段兜底。正文支持列表/表格/引用/代码块等标准 Markdown（`#` 一级标题为一个条目，`##`/`###` 为该条目下的小节，超长自动分块）。生成器「知识库」页可直接拖入 `.md` / `.txt` 自动转成 JSON，推荐生成后粘贴。默认三个库：`Core Commands`、`Extension Commands`（各扩展为 `#` 子条目、命令为 `##` 小节）、`ob11-api`（`platform: [QQ]`，仅 QQ 平台可见与注入）。知识库只读，内容由管理员维护，AI 通过 `knowledge_search` / `knowledge_read` / `knowledge_list` / `knowledge_docs` 工具只读检索（检索范围 = 当前平台可用 + 本会话开启的库）；管理员可用 `.ai kb list/on/off/refresh` 查看与按会话开关。语法定义见 [CommonMark 规范](https://commonmark.org/help/) |

### 回复

| 设置项 | 说明 |
|:---:|:---|
| 回复引用 | AI 回复时是否引用触发的消息；回复含戳戳（poke）时不引用，避免消息无法显示 |
| 回复最大字数 | 防止最大 tokens 限制不起效导致回复过长 |
| 回复文本去除首尾空白字符 | 发送前去除回复首尾空白 |
| 额外消息分隔符 | 模板，每框一条；内置 `\f` 始终用于拆分多条消息，这里可追加额外分隔符（如 `\n\n` 空行、`\n` 换行），默认空 = 不追加 |
| 回复中的换行转义 | AI 回复里写出的字面量 `\n` / `\r\n` 会在发送时转换为真实换行；多条消息按 `\f`（及「额外消息分隔符」）拆分 |
| 分段发送延时 | 流式/非流式输出共用，消息间隔是否开启延时防止乱序 |
| 分段发送基础延时/ms | 流式/非流式输出共用，从第二条消息开始每条发送前等待的毫秒数（默认 350） |
| 分段发送含图额外延时/ms | 流式/非流式输出共用，当消息包含图片时额外增加的等待毫秒数（默认 250） |
| 禁止回复复读 | 检测到与上一条回复相似度过高时停止回复 |
| 视作复读的最低相似度 | 与上一条回复的相似度达到该值视为复读（默认 0.8） |

### 后端

| 设置项 | 说明 |
|:---:|:---|
| 后端配置 | 整份后端地址（JSON v1）。在 [aiplugin4-backends](https://github.com/error2913/aiplugin4-backends) 的 WebUI 点「📋 复制后端配置」后整段粘贴；包含流式输出、图片转base64、图床、媒体转base64、用量图表、核心桥的地址与 token。图床的 `url` 是插件访问地址（可为 `127.0.0.1`），**`publicUrl` 是协议端与模型都能访问的对外 IP/域名**（复制时「图床对外地址」一栏自动生成，留空会自动探测本机 IP）；没有 `publicUrl` 时发图/模型取图自动降级。**复制内容会带上各后端已设置的访问 token（请勿公开分享）；给后端设/改 token 后要重启该后端并重新复制一次**（token 不一致会 401，日志会提示去哪个 `backends.<名>.token` 核对）。留空 = 全部使用出厂默认地址；修改后约 60 秒生效 |

> 各后端服务相互独立，可按需自建；除流式输出外，其余服务并非核心功能所必需。

后端服务已迁移到独立仓库 [aiplugin4-backends](https://github.com/error2913/aiplugin4-backends)：自带 `launcher.py` 一键管理（Windows / Linux 通用，默认不启动任何后端，首次启动某后端时才自动创建 venv 并安装依赖，异常退出自动拉起；`webui` 提供管理界面，可改端口/看日志，主题跟随系统）。后端清单与接口详见其仓库的 [docs/后端.md](https://github.com/error2913/aiplugin4-backends/blob/main/docs/后端.md)，插件侧配置文档见 [docs/08-相关后端项目](docs/08-相关后端项目.md)。

### 论坛

| 设置项 | 说明 |
|:---:|:---|
| 论坛地址 | 默认：`https://aiplugin-forum.fishwhite.top`，aiplugin4 专用论坛地址 |
| 论坛API Token | 论坛注册后获取的 api_token，用于发帖等写操作的鉴权 |
| 论坛签名密钥 | 论坛注册后获取的 secret_key，用于请求签名验证 |

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

### 提示词架构（prompt）

自 4.29.0 起，system prompt 由内置**英文段注册表**组装（不再是一份大模板）：

- 稳定段进 system：身份 / 角色 / 回复语言 / 会话信息 / 消息标记 / 图片与图库 / 回复方式 / 工作方向 / **能力地图** / 工具获取或调用格式 / 可用技能 / 知识库 / 子代理委派；段级缓存 30 秒（技能/知识库/工具开关/角色设定等任一变化即失效）。
- **能力地图**：按当前会话已开启、平台匹配的工具组列出“能力域 + 用途 + 2 个代表工具”（不含参数），并明确要求“不确定能力时先 list_tools/search_tools，不要直接说做不到”；STATUS 关闭或无可用工具时不出现。MCP 服务器的用途标签取配置 `description`，缺省用 `initialize` 的 `serverInfo.title`，再缺省用服务器名。
- 易变段走 runtime：当前时间 / 长期记忆以 user 消息 `[system:runtime]…[/system]` 注入，system 前缀跨轮稳定。
- 内置提示词与代码生成的上下文标记均为英文且**不兼容旧中文标记**（旧会话中的中文标记按普通文本保留）；角色设定、技能正文、知识库正文等用户内容保持原语言，机器人按对话语言回复。
- 外部插件可注册扩展段：`globalThis.aiplugin4.registerPromptSection({ name: 'ext:xxx:yyy', order: 10000, channel: 'system', build: ctx => '...' })`（限 `ext:` 命名空间、单段 ≤2000 字符、合计 ≤4000 字符、默认外部清洗）；也可用 `onPromptAssemble(fn)` 整体改写 system/runtime。
- 调试：`.ai prompt` 查看 system + runtime；`.ai prompt sections` 查看段统计（order/name/channel/chars/tokens/cache）与 digest。开发侧可用 `npm run prompt:snapshot` 把 group/private 两种会话的 system/runtime/段统计输出到 `test-reports/prompt-baseline/`，便于重构前后对比。
- MCP 服务器 `initialize` 返回的 `instructions` 默认不注入；在「MCP服务器」对应条目加 `"exposeInstructions": true` 后以低权威 runtime 段注入（外部清洗、单服务器 ≤1000 字符、合计 ≤2000 字符）。MCP prompts/resources 由 `.ai mcp prompt list|get` 与 `mcp_list_resources`/`mcp_read_resource` 按需使用，不自动进 system prompt。每台服务器可选 `"description": "用途一句话"`（能力地图与 `.ai mcp list` 展示用途；缺省用 initialize 的 `serverInfo.title`）。
- 发现类工具（`list_tools`/`search_tools`/`list_mcps`/`call_tool`）的模型可见结果与错误为英文；`list_tools` 组头带代表工具与分页提示，`search_tools` 返回完整参数并提示用 `call_tool` 执行。

---

## 💻 完整命令手册

根命令为 `.ai`（`AI` 大写同样注册），子命令支持别名（如 `priv→privilege`、`ses→session`、`st→set`、`ck→check`、`clr→clear`、`sb→standby`、`memo→memory`、`tk→token`、`img→image`、`ign→ignore`），列表类命令支持 `--page=<数字>`（别名 `--p`）翻页。

### 管理员命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai priv ses st <ID> <会话权限>` | `.ai priv ses st QQ-Group:1234 50` | 修改指定会话的权限等级，ID 可为 `now` 表示当前窗口 |
| `.ai priv ses ck <ID>` | `.ai priv ses ck QQ-Group:1234` | 检查指定会话的权限等级 |
| `.ai priv st <指令> <权限限制>` | `.ai priv st ai-sb 0-0-0` | 修改具体命令的权限限制，指令用 `-` 连接，权限限制格式为「会话-用户-强触」 |
| `.ai priv show <指令>` | - | 检查指定指令的权限限制 |
| `.ai priv reset` | - | 重置所有指令权限为默认 |
| `.ai prompt` | - | 查看当前 system prompt 与 runtime 段（骰主；过长时仅记录日志） |
| `.ai prompt sections` | - | 查看提示词段统计（order/name/channel/chars/tokens/cache）与 digest（骰主） |
| `.ai block add <用户ID/群ID> <原因>` | `.ai block add QQ:1234567890 乱发广告` | 拉黑用户/群（骰主），被拉黑对象无法触发 AI 对话 |
| `.ai block rm <用户ID/群ID>` | - | 移除黑名单 |
| `.ai block list` | - | 查看黑名单列表 |

> 权限数值：-30 黑名单 / 0 普通用户 / 40 邀请者 / 50 群管理员 / 60 群主 / 70 白名单 / 100 骰主。

### 基础控制命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai status` | - | 查看当前会话设置 |
| `.ai ctx` | - | 查看上下文状态：消息数、整理进度与最近一次整理结果 |
| `.ai ctx archive` | - | 立即生成/刷新滚动摘要；不删原文、不写长期记忆 |
| `.ai ctx hide [user\|assistant\|all]` | `.ai ctx hide assistant` | 隐藏消息（原文保留，可审计；不影响长期记忆） |
| `.ai ctx purge --yes` | - | 清除本会话上下文（不可恢复；仅骰主；不影响长期记忆） |
| `.ai ctx repair` | - | 检查/修复上下文索引 |
| `.ai ctx set [budget=<token>\|clr]` | `.ai ctx set budget=100000` | 按会话覆盖上下文预算（需邀请者以上）；budget=0 表示跟随模型窗口 |
| `.ai live` / `.ai live all` | `.ai live` | 查看会话实时运行状态：`.ai live` 查看当前会话(流式/运行/排队/定时器)；`.ai live all` 查看全局活跃会话总览(仅骰主) |
| `.ai help <子指令>` / `.ai <子指令> help` | `.ai help tool` | 查看子命令帮助；`.ai <子指令> help` 带更多参数时交由子命令自身处理（如 `.ai tool help <函数名>`） |
| `.ai ctx name status` | - | 查看上下文中的名字与自动修改状态 |
| `.ai ctx name set [nick/card]` | - | 将上下文中的名字设置为昵称/群名片 |
| `.ai ctx name mod <0\|1\|2>` | - | 自动修改上下文中的名字：0 不修改，1 昵称，2 群名片 |
| `.ai on` / `.ai on --r` | - | 开启 AI：非指令正则触发默认随之开启；`.ai off --r` 仅关闭正则触发，`.ai on` 重新开启 |
| `.ai on [--r --j --c=<条> --t=<秒> --p=<%> --a=<开始-结束-次数>]` | `.ai on --c=10 --t=60` | 开启 AI：--r 开启非指令正则触发，--j 开启评分触发（评分智能体判断是否插话），--c/--t/--p/--a 开启计数器/计时器/概率/活跃时间段模式，不带参数仅开启非指令正则触发 |
| `.ai standby [on/off]` | `.ai standby off` | 待机模式：仅录入上下文不主动发言，非指令关键词触发才发言；`off` 仅关闭待机、保留其它触发模式（适合只播报不读群消息） |
| `.ai off [--r/--j/--c/--t/--p/--a/--sb]` | `.ai off --t` | 关闭 AI（含非指令正则触发），加参数只关闭对应模式（`--sb` 仅关闭待机） |
| `.ai role [<名称>]` | - | 查看 / 切换角色设定 |
| `.ai model [list\|pull\|<用途> [<模型>]]` | `.ai model chat deepseek-v4-flash` | 查看 / 绑定全局分用途模型（骰主）：无参数查看各用途当前模型与来源（运行时覆盖 / 配置绑定 / 自动）与连接状态；`.ai model list` 读加载/最近一次拉取到内存的模型列表（不联网，按连接序号分组）；`.ai model pull` 立即重拉全部连接并展示（无视 `models` 钉住清单，强制网络）；`.ai model <用途>` 查看指定用途候选（按取用顺序编号）；`.ai model <用途> <模型>` 设为该用途的**运行时覆盖**（支持编号 / 模型 id / 模型名，优先级最高、存插件存储）。模型类型在「模型配置」里用 `kind` 声明（text/vision/embed/gen/tts） |
| `.ai balance` | - | 并发查询全部（非忽略）连接的账户余额（骰主）：deepseek / moonshot / siliconflow 内置余额接口直接查；其余平台提示控制台入口；one-api/new-api 等网关可在连接的 `request` 里配置 `balance_url` + `balance_json_path` 后查询 |
| `.ai stop` | - | 完全暂停当前对话（打断流式输出/工具链/排队请求，清计时器） |
| `.ai subagent` / `.ai subagent list` | - | 查看本会话子代理运行情况：列出 ID / 用途 / 状态 |
| `.ai subagent stop <ID\|all>` | `.ai subagent stop all` | 停止指定子代理（仅中断当前轮、可续跑；all = 停止本会话全部） |
| `.ai subagent clean` | - | 清理已结束/已停止的子代理记录 |

### 记忆管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai memo status` | - | 查看当前范围记忆状态（含 backlog/后台队列/模型状态） |
| `.ai memo add <内容>` | `.ai memo add 喜欢手冲咖啡 --u` | 添加事实；`--shared` 显式跨群、`--private` 仅本人；范围见下 |
| `.ai memo list [页码]` | - | 展示事实列表（`#N` 可代替 ID） |
| `.ai memo update <ID\|#N> <新内容>` | - | 更新事实 |
| `.ai memo delete <ID\|#N> ... [--关键词] [--hard]` | - | 默认软失效；`--hard` 物理删除仅骰主 |
| `.ai memo clear --yes` | - | 清除事实/观察/模型（不可恢复） |
| `.ai memo obs list` | - | 观察记忆列表 |
| `.ai memo obs view <ID>` | - | 观察详情（证据、证据数、历史） |
| `.ai memo obs clr --yes` | - | 清除观察并把源事实重置为待巩固 |
| `.ai memo obs on/off` | - | 会话级观察开关 |
| `.ai memo obs refresh` | - | 立即抽取当前上下文并巩固（手动） |
| `.ai memo consolidate` | - | 立即巩固一次 |
| `.ai memo reflect <问题>` | - | 心智模型优先的推理；`--deep` 强制下探事实 |
| `.ai memo mm list` | - | 心智模型列表 |
| `.ai memo mm view <ID>` | - | 查看模型内容/状态/触发方式 |
| `.ai memo mm add <问题> [答案]` | - | 新建模型；无答案时排队生成；`--tag`/`--mode=full\|delta`/`--auto\|--no-auto` |
| `.ai memo mm refresh [ID]` | - | 手动刷新（绕过自动门控） |
| `.ai memo mm clear <ID>` | - | 清空内容并排队 full 重建 |
| `.ai memo mm del <ID\|关键词>` | - | 删除模型 |

> 范围参数：默认当前会话；`--u` 本人、`--g` 当前群、`--self` 本体（仅骰主）；`--u=<ID>`/`--g=<ID>` 仅骰主。个人事实默认 `vis:owner`（仅本人私聊），群聊默认 `vis:public`（仅本群）；跨群必须显式 `--shared`。`.ai memo clear` 与 `.ai memo obs clr` 必须带 `--yes`。

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

> 工具组 = 内置工具的 17 个能力分类（Dispatch / Commands / Timers / Triggers / Memory / Images / Media / OB11 / Resources / Attributes / Raw search / Context editing / Blocks / Web / Public sessions / Subagents / MCP；外部插件注册的工具归 External plugins）+ 每台 MCP 服务器各一组，`.ai tool on/off <服务器名>` 与 `.ai mcp on/off <服务器名>` 等价。技能与知识库不参与工具组维度（其会话开关仍用 `.ai skill on/off`、`.ai kb on/off`），但单工具开关照旧可用（如 `.ai tool off use_skill`）。

### MCP 技能 知识库管理命令

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai mcp list` | - | 列出当前平台可用的 MCP 服务器及工具开关状态（未启用 MCP 时提示先开启配置） |
| `.ai mcp on/off [<服务器>]` | `.ai mcp on mcp-browser` | 按会话批量开启/关闭某服务器（或缺省全部当前平台服务器）下的工具；开启时跳过「禁止调用的函数」（on/off 需邀请者以上） |
| `.ai mcp refresh` | - | 重新解析 MCP 服务器配置并强制重同步工具列表（骰主；MCP 配置修改后无需重载 JS） |
| `.ai mcp prompt list [<服务器>]` | `.ai mcp prompt list mcp-browser` | 列出 MCP 服务器提供的 prompt 模板（用户手动触发，不会自动注入 system prompt） |
| `.ai mcp prompt get <服务器> <名称> [--arg k=v ...]` | `.ai mcp prompt get mcp-browser summarize --arg topic=天气` | 取回 prompt 内容并作为普通消息展示（不写系统提示词、不触发 AI 回复） |
| `.ai skill list` | - | 列出当前平台可用的技能及会话开关状态（名称带 `（平台：…）` 标注） |
| `.ai skill on/off <技能名>` | `.ai skill off 录卡` | 按会话开启/关闭指定技能（on/off 需邀请者以上） |
| `.ai skill refresh` | - | 强制重新解析「技能列表」（骰主；平时配置变化下一条消息自动生效） |
| `.ai kb list` | - | 列出当前平台可用且本会话开启的知识库（含平台标注） |
| `.ai kb on/off <库ID或名称>` | `.ai kb off ob11-api` | 按会话开启/关闭指定知识库（名称唯一命中时也可用名称；on/off 需邀请者以上） |
| `.ai kb refresh` | - | 重新解析「知识库配置」配置（骰主） |

> 三个管理命令的行为一致：`list` 只显示「当前平台可用」的项（平台限制来自对应 JSON 条目的 `platform` 字段，如知识库默认 ob11-api；MCP 生成器示例里的 md-html-render 也限定 QQ）；`on/off` 开关按会话保存（只记录被关闭的项，缺省=开启）；`refresh` 立即重解析 JSON 配置生效，无需重载 JS。

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
| `.ai tk use` | - | 按**用途**（chat / compression / summarization / judge 等）查看 token 用量，便于对账 |

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

### 媒体生成命令（4.24.0 起内置）

语音合成与文生图都是**异步任务**：提交后立即返回任务号，生成完成后**直接发到本会话**（命令发起的由插件投递，不需要 AI 介入）。

| 命令 | 使用示例 | 说明 |
|:---:|:---:|:---|
| `.ai tts <文本>` | `.ai tts 今天天气真不错 --rate=1.5 --instruction=用欢快的语气说` | 合成语音并发送；可选 `--model` `--voice` `--rate` `--pitch` `--volume` `--instruction` `--emotion`（是否生效取决于该模型的 `request.params` / `request.body` 声明） |
| `.ai tti <描述>` | `.ai tti 一只在雪地里奔跑的白狐 --size=1024x1024` | 生成图片并发送；可选 `--model` `--size` `--steps` `--seed` `--quality` `--style` `--negative` `--save` `--name` |
| `.ai media` | - | 查看本会话生成任务队列（未完成 + 最近 10 条已结束，含状态/耗时/结果句柄/失败原因） |
| `.ai media list [页码] [--all]` | `.ai media list 2 --all` | 分页查看；`--all` 包含全部已结束任务。别名 `.ai md` |
| `.ai media cancel <任务号>` | `.ai media cancel 3` | 取消未完成的任务（已结束的任务无法取消）；**运行中**的任务也能取消，取消后结果被丢弃、不发送 |

> 命令与 AI 工具的区别：`.ai tts` / `.ai tti` 由插件**直接投递**结果（不看「媒体生成同步等待秒数」）；AI 调 `generate_audio` / `text_to_image` 时才会先等同步窗口——窗口内出结果就把结果**当场返回给 AI**（由 AI 决定怎么发），超时才返回任务号走异步通知。

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
> AI 侧对应工具：`pub_read`（目录感知/读任意会话上下文快照）、`pub_send`（向任意会话外发，QQ 系富媒体/其他平台纯文本，成功后写入目标会话 `[system:cross-session]` 只读背景）。命令默认权限骰主级，可用 `.ai priv` 调整；能力说明见上方[配置手册](#️-配置手册)「公开会话」小节（无新增配置项）。

---

## 🧰 可用工具函数

以下为内置工具函数（基于当前源码），下表「工具组」列即 `.ai tool` 的工具组名（可直接 `.ai tool <工具组>` 查明细、`.ai tool on/off <工具组>` 整组开关），可通过 `.ai tool help <name>` 查看详细用法：

| 工具组 | 工具函数 |
|:---:|:---|
| Dispatch | `list_tools`（按工具组列出当前平台工具）、`search_tools`（按名称/关键词/工具组发现工具并取参数）、`list_mcps`（列出当前平台可用 MCP 服务器及工具）、`call_tool`（统一执行任意工具） |
| Commands | `run_ext_command`（本地执行扩展指令）、`run_core_command`（经核心桥 WebSocket 调用核心指令） |
| Timers | `set_timer`、`show_timer_list`、`cancel_timer` |
| Triggers | `set_trigger_condition` |
| Memory | `memory_recall`、`memory_add`、`memory_update`、`memory_delete`、`memory_consolidate`、`memory_reflect`、`memory_mental_model`（action: list/view/create/refresh/clear/delete） |
| Images | `image_to_text`（文字描述，`ids[]`≤3）、`image_view`（多模态直接看，`ids[]`≤4；不支持视觉时降级）、`text_to_image`、`meme_list`、`get_meme_info`、`meme_generator` |
| Media | `media_tasks`（查看/取消本会话的语音与图片生成任务队列） |
| OB11 | `call_ob11_api`（通过 action 调用消息、查询、管理、文件和合并转发 API；群资料、精华消息等均传入对应 action）、`resolve_special_id`（还原上下文短 ID/句柄为原始字段，用于对接协议 API） |
| MCP | `mcp_list_resources`（按服务器列出 resources 目录）、`mcp_read_resource`（按 uri 读取资源内容；resources 是外部数据，不会自动注入提示词） |
| Resources | `list_resources`、`get_resource_path`（本地资源查询）；`generate_audio`（提交语音生成任务，立即返回任务号，完成后自动通知；传 `path` 时同步解析本地/MCP 音频资源）、`search_music`（返回 music 消息段，不直接发送） |
| Attributes | `attr_get`、`attr_set` |
| Raw search | `grep_raw`、`read_raw`（按 kind 检索/读取工具、用户消息、图片、事件被截断或压缩前的完整原文） |
| Context editing | `context_edit_list`（按序号定位任意会话上下文条目，支持 role/keyword/时间过滤）、`context_edit_replace`（按 scope 批量替换正文文本：字面量/正则、空串删除、原文副本同步、持久化；敏感工具，默认开启，详见下方说明） |
| Blocks | `suggest_block`（AI 建议拉黑，带冷却；默认需骰主确认）、`unblock_user`、`get_block_list` |
| Web | `web_search`（多后端、失败回退）、`web_fetch`（抓取正文、`start_index` 续读）；论坛：`forum_get_posts`、`forum_get_post_detail`、`forum_search`、`forum_create_post`、`forum_manage_comment`、`forum_get_activity`、`forum_manage_post` |
| Public sessions | `pub_read`（分级浏览公开会话目录 / 读取其他会话上下文只读快照）、`pub_send`（以目标会话自己的机器人账号身份外发：QQ 系富媒体 / 其他平台纯文本） |
| Subagents | `subagent`、`subagent_fork`（委派）、`send_message`、`interrupt_agent`、`list_agents`（可续跑子代理控制）、`job_list`、`job_output`、`job_kill`（后台 job 管理）；默认开启，详见上方「子代理」配置小节 |
| 外部插件 | 其他海豹插件经 `globalThis.aiplugin4.registerTool` 注册的工具 |
| 技能（来源分组，不参与工具组开关） | `use_skill`（按需获取正文，支持 `offset` 续读）、`skill_list`（平台受限或本会话已关闭时明确返回不可用提示） |
| 知识库（来源分组，不参与工具组开关） | `knowledge_search`、`knowledge_read`、`knowledge_list`、`knowledge_docs`（只读检索，范围 = 当前平台可用 + 本会话开启的库；内容由配置维护） |
| MCP（来源分组 = 服务器名，可整组开关） | 远端工具名（同名冲突时跳过，仅当前平台可见）；`render_markdown` / `render_html` 由默认服务器 `md-html-render` 提供 |

> 指令类技能（今日人品、COC 模组抽取/搜索、属性展示、属性检定、san 检定等）通过 `use_skill` 按需获取内容，内部统一使用 `run_ext_command` / `run_core_command` 调用海豹指令，对应指令需加入「可调用指令白名单」。

> 上下文编辑说明：`context_edit_list` / `context_edit_replace` 允许 AI 定位并批量替换任意会话上下文中的正文文本（纯文本字面量或全局正则，`replacement` 传空串=删除匹配文本）。目标会话缺省=当前会话，也可用 `bot_id`（如 `QQ:123`）+ `session_id`（如 `QQ-Group:456`）跨会话定位，同一 SealDice 实例内多端点/多账号可写；压缩/截断保留的原文副本（`rawText`/`rawItems`）会同步修改并持久化。属敏感操作、**不可自动回滚**，工具默认开启，可用 `.ai tool off context_edit_replace` 或加入「禁止调用的函数」硬禁。

> OB11 说明：协议动作统一通过 `call_ob11_api`。安装 ob11 网络连接依赖时，action 原样交给 `net.callApi`；未安装时仍由 SealDice 原生后端完成当前上下文可完成的发送和查询，远端 action 返回 `OB11_DEPENDENCY_REQUIRED`，不会假装成功。当前会话回复中发送图片优先使用 `[img:图片ID]`；图片、语音、视频、文件、JSON、Markdown、音乐和合并转发均通过 message segment 保留格式；`search_music` 只生成可发送的 segment。

> 语音/图片生成说明（4.24.0 起内置）：`generate_audio` / `text_to_image` 是**异步任务**——提交后**先等一段同步窗口**（「工具 → 媒体生成同步等待秒数」，默认 5 秒），窗口内就生成完则**当场把结果返回给 AI**（图片直接给 `[img:图片ID]`、语音给 record 段指引），不再走异步通知；窗口内没完成则立即返回任务号，生成完成后写入会话通知并**尽力唤醒 AI**投递（该送达**免触发令牌桶**，桶空也送达；**待机中同样唤醒**，因为这是用户请求的结果而不是主动搭话；会话忙则通知留在队列，由**本轮结束时的补触发**接手，不会丢；端点离线时通知保留、下一轮呈现）。命令 `.ai tts` / `.ai tti` 发起的由插件直接投递。AI 收到完成通知后：**语音走 `call_ob11_api` 的 record 段**（`[audio:xxx]` 只认「资源」页配置的本地语音资源名，不接受生成结果的路径/URL），**图片优先直接在回复里写 `[img:图片ID]`**（系统会自动发送，**非必要不要为此调用 `call_ob11_api`**）。任务队列可用 `media_tasks` 工具或 `.ai media` 查看与取消。请求结构默认由内置供应商预设提供（见「模型」页说明），参数（音色/语速/尺寸等）由「模型规则」`[params]` 与模板里的 `{占位符}` 决定。

> 扩展/核心指令工具不再要求会话先出现 `.r`：`run_ext_command` 在插件内本地直调扩展 `solve`，无需中间件；`run_core_command` 通过 OB11 核心桥注入假消息，需启动 `ob11-core-bridge`（SealDice 的 OB11 网络依赖连接中间件 `/core`，并在「后端 → 后端配置」的 `backends.ob11-core-bridge` 填地址，默认 `ws://127.0.0.1:46880/plugin`）。

---

## 🚨 注意事项

- 简单配置（开关/数值/单行字符串/纯字符串数组/「后端配置」JSON）修改后自动生效（缓存最多 1 分钟），无需重载 JS；复杂配置（模型、触发/忽略正则、评分触发、「角色设定」、「MCP服务器」、「知识库配置」、本地资源路径、音乐服务）修改后需重载 JS 才生效（其中「MCP服务器」「知识库配置」也可用 `.ai mcp refresh` / `.ai kb refresh` 立即生效）；「技能列表」修改后下一条消息自动生效（也可用 `.ai skill refresh` 强制重解析）；
- 嵌入输出维度取该模型 `request.body` 里的 `dimensions`（默认 1024）；有嵌入模型参与 text-embedding 用途后长期记忆与知识库启用语义检索，未配置时自动降级为关键词检索（知识库加载本身不请求嵌入）；
- 流式输出需要自建或使用公共后端，并在「后端 → 后端配置」里配置 stream-output 地址；在 chat 用途组 `groups[].body` 里设 `stream = true` 的模型才会走流式（`anthropic-messages` 协议不支持，会自动回退非流式）；
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

- 记忆检索确认已有嵌入模型可用（「模型配置」里有 `kind: "embed"` 的模型，且 `.ai model text-embedding` 显示已绑定或存在可用默认），「启用长期记忆」开关打开；
- 知识库为配置驱动（JSON 里的 Markdown 内容），不按角色加载；「启用知识库记忆」开关打开后修改「知识库配置」（`.ai kb refresh` 或重载 JS 生效）；若仍检索不到，用 `.ai kb list` 确认库在当前平台可用且未被本会话关闭（`platform` 限定当前平台、未执行过 `.ai kb off`），可让 AI 通过 knowledge_search / knowledge_read 工具检索验证；
- 记忆检索有相似度下限过滤，条目太旧（衰减）或相似度过低不会展示。

**图片识别异常**

- 确认图片 URL 可以在浏览器访问（过期或 QQ 图床 bug 时更换协议端版本）；
- 模型不支持 QQ 图床时，把「识别图片时将url转换为base64」设为「总是」或「自动」；
- 图片转文字依赖视觉模型：先在「模型配置」里给视觉模型显式写 `"kind": "vision"`（⚠️ 视觉**不再**按模型名自动识别），再用 `.ai model image-understanding <模型>` 绑定；
- **图片直链失效不会再卡死会话**：QQ 直链 rkey 过期时（图床返回 `download url has expired`，后端与模型都拿不到图），插件会把这些图片降级为 `[img:ID]` 文本标签、不再产生 image_url，模型也就不会因「下载图片失败」整轮 400 而静默不回复；日志出现 `图片xxx的URL已确认不可用` 或 `[model-error] 模型无法下载上下文图片` 属正常兜底；
- 若**历史上下文**里已有坏图片（旧版本遗留）导致该会话一直不回复，执行 `.ai ctx purge --yes` 清除上下文即可恢复。

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

> 在「模型配置」中，上表平台只需填 `baseURL`（`provider` 一般不用填，由 `baseURL` 的 host 自动识别，它决定用哪套原生请求结构与列表接口适配）；未列出的平台/网关填根地址的 `baseURL` 即可，按 OpenAI 兼容方式使用（Claude 需把 `api` 设为 `anthropic-messages` 走其专有适配）。模型名以各平台「模型列表」接口/官方文档为准，连接的 `models` 留空时插件启动会自动获取。

> 余额查询：deepseek / kimi(moonshot) / siliconflow（硅基流动）支持 `.ai balance` 直接查 API 余额（deepseek/moonshot 按 vendor、其余按内置规则自动识别端点）；其余平台未开放 API 余额接口，请在各自控制台查看；one-api/new-api 等网关可在连接的 `request` 里配置 `balance_url` + `balance_json_path`（配合 `auth_header_name`/`headers`）后查询。

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
