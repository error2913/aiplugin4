# 嵌入模型示例

嵌入模型用于向量记忆与知识库的语义检索：文本先向量化，再按相似度过滤。接口必须为 OpenAI 兼容 `POST {base_url}/embeddings`。

从本文档复制完整 TOML，粘贴到 SealDice →「插件设置」→ aiplugin4 →「模型」→「嵌入模型」中，替换 `api_key` 等示例值即可。每行一个完整 TOML，多个模型用换行分隔。

## 通用字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 模型名，与平台 API 文档一致 |
| `api_key` | 是 | API 密钥 |
| `use` | 是 | 固定填 `["text-embedding"]` |
| `provider` | 否 | 服务商标识；省略时按 `name` 在自动识别表中查找（alibaba / openai / zhipu / siliconflow），查不到则必须显式填写 |
| `base_url` | 否 | API 地址；省略时取该 provider 的默认地址 |
| `[body]` | 否 | 请求参数覆盖；默认 `encoding_format=float`、`dimensions=1024` |
| `ignore` | 否 | 1=忽略该条配置（不出现在列表/不可选中/不作为默认），0/不写=正常 |

> **维度必须与后端真实输出一致**：插件从第一个嵌入模型的 `[body] dimensions` 读取检索维度（默认 1024），不一致时向量检索会自动降级为关键词 / 分数检索。模型响应日志会打印实际 embedding 长度，可用于核对。

## 阿里云百炼

```toml
name = "text-embedding-v4"
api_key = "sk-xxx"
use = ["text-embedding"]
provider = "alibaba"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

[body]
dimensions = 1024
```

> `text-embedding-v4` 支持 2048 / 1536 / 1024（默认）/ 768 / 512 / 256 / 128 / 64 共 8 种维度；`text-embedding-v3` / `v2` 旧款仍可用。

## OpenAI

```toml
name = "text-embedding-3-small"
api_key = "sk-xxx"
use = ["text-embedding"]
provider = "openai"
base_url = "https://api.openai.com/v1"

[body]
dimensions = 1536
```

> `text-embedding-3-small` 默认 1536 维、`text-embedding-3-large` 默认 3072 维（两者均支持降维，例如填 1024 也能生效）。**不要使用 `text-embedding-ada-002`**：它不支持 `dimensions` 参数，而插件默认会携带 `dimensions`，请求会直接报错。

## 智谱 GLM

```toml
name = "embedding-3"
api_key = "sk-xxx"
use = ["text-embedding"]
provider = "zhipu"
base_url = "https://open.bigmodel.cn/api/paas/v4"

[body]
dimensions = 1024
```

> `embedding-3` 默认输出 2048 维，支持 256 / 512 / 1024 / 2048 自定义维度；建议显式填 `dimensions` 与检索配置保持一致。

## 硅基流动（SiliconFlow）

```toml
name = "BAAI/bge-m3"
api_key = "sk-xxx"
use = ["text-embedding"]
provider = "siliconflow"
base_url = "https://api.siliconflow.cn/v1"

[body]
dimensions = 1024
```

> `BAAI/bge-m3`（1024 维，多语言含中文）、`BAAI/bge-large-zh-v1.5`（1024 维）、`Qwen/Qwen3-Embedding-0.6B/4B/8B`（支持自定义维度，如 1024 / 1536）均可使用；`Qwen/Qwen3-VL-Embedding-8B` 为多模态嵌入模型，但插件只发送文本 `input`，无法利用其图像能力。

## 其他平台 / 自定义网关

```toml
name = "your-embedding-model"
api_key = "sk-xxx"
use = ["text-embedding"]
provider = "any-custom"
base_url = "https://your-gateway.example.com/v1"

[body]
dimensions = 1024
```

> 任何提供 OpenAI 兼容 `POST {base_url}/embeddings` 的服务（含百度千帆兼容模式、腾讯混元、各类中转与自建推理服务）都可以这样接入；具体模型名与支持维度以各平台文档为准。

## 兼容性说明

- 接口必须为 OpenAI 兼容 `/embeddings`（请求体 `model` + `input`，`[body]` 合并进请求体）。
- Google Gemini 的原生嵌入接口与 OpenAI 格式不同，不能直接填原生地址；需自建 OpenAI 兼容代理 / 网关，或改用百炼、智谱等兼容服务。
- 插件默认携带 `encoding_format=float` 与 `dimensions=1024`（可被 `[body]` 覆盖，但不能移除）；不支持 `dimensions` 参数的旧模型（如 `text-embedding-ada-002`）不兼容。
- 维度一致性是向量检索正确的前提；配置好「嵌入模型」后即自动启用语义检索，无需额外开关；`ignore` 可选：1=忽略该条配置，0/不写=正常。
- 向量缓存只缓存最近一条文本，不影响日常使用。
