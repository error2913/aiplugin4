# 对话模型示例

插件内置的自动识别表只覆盖部分经典模型，且可能滞后于各平台上线 / 退役节奏。需要其他模型或服务商时，从本文档复制完整 TOML，粘贴到 SealDice →「插件设置」→ aiplugin4 →「模型」→「对话模型」中，替换 `api_key` 等示例值即可。每行一个完整 TOML，多个模型用换行分隔；默认对话模型取列表第一项。

## 通用字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 模型名，与平台 API 文档一致 |
| `api_key` | 是 | API 密钥 |
| `use` | 是 | 用途，可多选：`chat`（普通对话）/ `compression`（消息压缩）/ `summarization`（记忆总结） |
| `provider` | 否 | 服务商标识；省略时按 `name` 在自动识别表中查找（deepseek / openai / google / zhipu / alibaba / anthropic / moonshot / xai / mistral / siliconflow），查不到则必须显式填写 |
| `base_url` | 否 | API 地址；省略时取该 provider 的默认地址 |
| `[body]` | 否 | 请求参数覆盖；默认 `max_tokens=8192`、`stop=null`、`stream=false` |

> 自动识别表更新不及时。文档中的模型名若不在内置表里（或表里的旧名已退役），显式填写 `provider` + `base_url` 即可，请求按 OpenAI 兼容格式发出，不受识别表限制。

## DeepSeek（深度求索）

```toml
name = "deepseek-v4-flash"
api_key = "sk-xxx"
use = ["chat", "compression", "summarization"]
provider = "deepseek"
base_url = "https://api.deepseek.com/v1"

[body]
temperature = 1
max_tokens = 8192
```

> `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 退役，旧名请求会直接报错，必须改用 `deepseek-v4-flash`（1M 上下文、支持工具调用）或 `deepseek-v4-pro`。

## OpenAI

```toml
name = "gpt-5.1"
api_key = "sk-xxx"
use = ["chat"]
provider = "openai"
base_url = "https://api.openai.com/v1"

[body]
temperature = 1
max_tokens = 8192
```

> `gpt-5.x` 系列（`gpt-5.1`、`gpt-5.2` 等）为当前主力；`gpt-4.1` / `gpt-4.1-mini` 已从 ChatGPT 下线但 API 仍可用（legacy）；其余旧模型名以 OpenAI 官方文档为准。

## Google Gemini

```toml
name = "gemini-3.5-flash"
api_key = "sk-xxx"
use = ["chat"]
provider = "google"
base_url = "https://generativelanguage.googleapis.com/v1beta/openai"

[body]
temperature = 1
max_tokens = 8192
```

> 走 Google 官方 OpenAI 兼容端点；`gemini-3.5-flash`（2026-05 GA）、`gemini-2.5-flash` 等 ID 可直接填写，更新的版本（如 `gemini-3.6-flash`）以 [Google 文档](https://ai.google.dev/gemini-api/docs/openai) 为准。

## 智谱 GLM

```toml
name = "glm-5"
api_key = "sk-xxx"
use = ["chat", "compression", "summarization"]
provider = "zhipu"
base_url = "https://open.bigmodel.cn/api/paas/v4"

[body]
temperature = 1
max_tokens = 8192
```

> 主力为 `glm-5` / `glm-5.1` / `glm-4.7` / `glm-4.7-flash`；`glm-4.6` 等旧版本仍可用。

## 阿里云百炼

```toml
name = "qwen3.7-plus"
api_key = "sk-xxx"
use = ["chat", "compression", "summarization"]
provider = "alibaba"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

[body]
temperature = 1
max_tokens = 8192
```

> 当前主力为 `qwen3.7-max` / `qwen3.7-plus`；`qwen3.5` 系列默认开启思考模式，会产生额外的思考 token，可通过 `[body] enable_thinking = false` 关闭，具体参数以 [百炼文档](https://help.aliyun.com/zh/model-studio) 为准。

## Anthropic Claude

```toml
name = "claude-sonnet-4-5"
api_key = "sk-xxx"
use = ["chat", "compression", "summarization"]
provider = "anthropic"
base_url = "https://api.anthropic.com/v1"

[body]
max_tokens = 8192
```

> `provider = "anthropic"` 走专有适配：请求 `/messages`、使用 `x-api-key` 请求头，system / tools / 多模态 / stop_sequences 自动转换，响应归一化为 OpenAI 格式；`stream = true` 暂不支持，会自动回退为非流式。模型名可用 `claude-opus-4-5` / `claude-sonnet-4-5` / `claude-haiku-4-5`，也可用 `opus` / `sonnet` / `haiku` 最新别名。

## Moonshot Kimi

```toml
name = "kimi-k2.6"
api_key = "sk-xxx"
use = ["chat"]
provider = "moonshot"
base_url = "https://api.moonshot.cn/v1"

[body]
max_tokens = 8192
```

> `kimi-k2.6`（256k 上下文，支持视觉与文本输入）与 `kimi-k2.5` 为当前主力；旧 `kimi-k2-0905-preview` 已过时。

## xAI Grok

```toml
name = "grok-4.3"
api_key = "sk-xxx"
use = ["chat"]
provider = "xai"
base_url = "https://api.x.ai/v1"

[body]
max_tokens = 8192
```

> `grok-4.3` 为 2026-05 推出的旗舰模型；`grok-4.1-fast-*` 等旧系列已退役，其余模型名以 [xAI 文档](https://docs.x.ai/) 为准。

## Mistral

```toml
name = "mistral-large-latest"
api_key = "sk-xxx"
use = ["chat"]
provider = "mistral"
base_url = "https://api.mistral.ai/v1"

[body]
max_tokens = 8192
```

> `mistral-large-latest`（Large 3）与 `mistral-small-latest`（Small 4）为当前主力。

## 硅基流动（SiliconFlow）

```toml
name = "deepseek-ai/DeepSeek-V3.2"
api_key = "sk-xxx"
use = ["chat"]
provider = "siliconflow"
base_url = "https://api.siliconflow.cn/v1"

[body]
max_tokens = 8192
```

> 开源模型托管平台，模型名带组织前缀（`deepseek-ai/DeepSeek-V3.2`、`Qwen/Qwen3-235B-A22B-Instruct`、`THUDM/GLM-5.1` 等），完整列表以 [模型中心](https://siliconflow.cn/models) 为准。

## 其他平台 / 自定义网关

```toml
name = "your-model"
api_key = "sk-xxx"
use = ["chat"]
provider = "any-custom"                     # 任意字符串，不要填 anthropic
base_url = "https://your-gateway.example.com/v1"

[body]
max_tokens = 8192
```

> 任何提供 OpenAI 兼容 `POST {base_url}/chat/completions` 的服务（含各类中转、网关、自建推理服务）都可以这样接入；`provider` 填非 `anthropic` 的任意值即可。

## 兼容性说明

- 接口标准为 OpenAI 兼容 Chat Completions；只有 `provider = "anthropic"` 走 `/messages` 专有协议（自动转换）。
- 工具调用依赖模型平台支持 function calling；不支持的模型配置后 AI 无法使用工具，需要换模型或在「工具」页签关闭调用函数功能。
- 流式输出：只有 `[body] stream = true` 的模型会走流式，且需要配置「后端 → 流式输出」URL；anthropic 的流式暂不支持。
- 同一用途在模型列表中取第一个匹配项；一个模型可配置多个 `use`（例如同时承担对话与压缩）。
- 不在内置自动识别表中的模型，显式填写 `provider` + `base_url` 即可，无需改动插件代码。
