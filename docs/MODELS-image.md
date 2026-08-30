# 多模态模型示例

本插件的「多模态模型」是**视觉理解 / 多模态模型**：用于图片转文字（`.ai img itt`）、图片识别，以及多模态对话（上下文中的图片直接以图片内容传给模型）。它不是生图模型——生图模型示例见依赖仓库的 [tti/MODELS.md](../aiplugin4-dependencies/tti/MODELS.md)（属于另一个插件的配置，不要填到这里）。

从本文档复制完整 TOML，粘贴到 SealDice →「插件设置」→ aiplugin4 →「模型」→「多模态模型」中，替换 `api_key` 等示例值即可。每行一个完整 TOML，多个模型用换行分隔。

## 通用字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 模型名，与平台 API 文档一致 |
| `api_key` | 是 | API 密钥 |
| `use` | 是 | 用途：`image-understanding`（图片理解 / 图片转文字）、`chat`（多模态对话）、`compression` / `summarization` / `judge`（当作对应对话模型使用），可并存 |
| `provider` | 否 | 服务商标识；省略时按 `name` 在自动识别表中查找（zhipu / alibaba / openai / google / siliconflow），查不到则必须显式填写 |
| `base_url` | 否 | API 地址；省略时取该 provider 的默认地址 |
| `[body]` | 否 | 请求参数覆盖；默认 `max_tokens=2048`、`stop=null`、`stream=false` |

> 请求固定为 OpenAI 兼容 `POST {base_url}/chat/completions`，图片以 `image_url` 内容块传入。`[body]` 中的字段会作为请求体顶层字段发送（例如 `temperature`、`max_tokens`），模型名只认 `name`。

## 智谱 GLM

```toml
name = "glm-4.6v-flash"
api_key = "sk-xxx"
use = ["image-understanding", "chat"]
provider = "zhipu"
base_url = "https://open.bigmodel.cn/api/paas/v4"

[body]
max_tokens = 2048
```

> `glm-4.6v-flash` 为智谱免费视觉模型，128K 上下文，支持图片 / 视频 / 文件输入，适合图片转文字与多模态对话；`glm-4.6v` 为旗舰视觉模型；`glm-4v-flash` 等旧款仍可用。

## 阿里云百炼

```toml
name = "qwen3-vl-plus"
api_key = "sk-xxx"
use = ["image-understanding", "chat"]
provider = "alibaba"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

[body]
max_tokens = 2048
```

> `qwen3-vl-plus` / `qwen3-vl-flash` 为当前主力视觉模型；`qwen-vl-max` / `qwen-vl-plus` 已进入下线流程（以百炼控制台为准），不建议继续使用。

## OpenAI

```toml
name = "gpt-4.1"
api_key = "sk-xxx"
use = ["image-understanding", "chat"]
provider = "openai"
base_url = "https://api.openai.com/v1"

[body]
max_tokens = 2048
```

> `gpt-4.1` 为 API 仍可用的 legacy 多模态模型；`gpt-5.x` 等最新模型是否开放图片输入以 OpenAI 官方文档为准。

## Google Gemini

```toml
name = "gemini-3.5-flash"
api_key = "sk-xxx"
use = ["image-understanding", "chat"]
provider = "google"
base_url = "https://generativelanguage.googleapis.com/v1beta/openai"

[body]
max_tokens = 2048
```

> `gemini-3.5-flash`、`gemini-2.5-flash` / `gemini-2.5-pro` 均支持视觉；走 Google 官方 OpenAI 兼容端点，自动接收 `image_url` 内容块。

## 硅基流动（SiliconFlow）

```toml
name = "Qwen/Qwen2.5-VL-72B-Instruct"
api_key = "sk-xxx"
use = ["image-understanding", "chat"]
provider = "siliconflow"
base_url = "https://api.siliconflow.cn/v1"

[body]
max_tokens = 2048
```

> `Qwen/Qwen2.5-VL-72B-Instruct`、`THUDM/GLM-4.6V-9B` 等，完整列表以 [模型中心](https://siliconflow.cn/models) 为准。

## Moonshot Kimi

```toml
name = "kimi-k2.6"
api_key = "sk-xxx"
use = ["chat"]
provider = "moonshot"
base_url = "https://api.moonshot.cn/v1"

[body]
max_tokens = 2048
```

> `kimi-k2.6` 支持视觉与文本输入，可放在本列表并 `use = ["chat"]` 作为多模态对话模型使用。

## 多模态对话的接法

- 把视觉模型放「多模态模型」列表，`use = ["chat"]`，然后 `.ai model <模型名>` 选中它；列表内模型一律按多模态处理，上下文中的图片以 `image_url` 内容直接传给模型，不再转成文本标签；
- 或直接把支持视觉的模型放「对话模型」列表（`use = ["chat"]`）按纯文本对话使用（图片仍只以文本标签形式出现）。

> 只有「多模态模型」列表里的模型才按多模态处理；同名模型若同时出现在「对话模型」列表，按对话模型（纯文本）优先。多模态对话的前提是「消息接收」里的接收图片开关开启，且模型本身支持视觉输入。

## 兼容性说明

- 接口标准为 OpenAI 兼容 Chat Completions + `image_url` 内容块；不提供该格式的服务商需要自建或使用 OpenAI 兼容网关。
- **不要在多模态模型列表填 `provider = "anthropic"`**：图片识别请求没有 anthropic 适配，会请求到不存在的 `/chat/completions`。想用 Claude 看图，把它配在「对话模型」（`use = ["chat"]`），由对话适配层自动把图片转成 anthropic image 块。
- 部分大模型无法访问 QQ 图床图片：可开启「识别图片时将url转换为base64」或「图片转base64」后端解决。
- 「是否开启识图模型」开关默认关闭，只影响图片识别 / 图片转文字（image-understanding），多模态对话不受该开关控制；配置好模型后需要手动打开。