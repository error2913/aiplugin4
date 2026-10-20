# AI 骰娘4 文档

> 让骰娘活起来 —— 运行在 [SealDice](https://docs.sealdice.com/) 上的 AI 对话插件，
> 为骰娘接入 OpenAI 兼容的大模型 API。

本页是**门户**：装插件走「用户手册」，改代码走「开发者知识库」。

---

## 🚀 三条上手路径

<div class="grid cards" markdown>

- **① 第一次安装**

    下载插件、上传到 SealDice、填一个 `api_key` 就能对话。

    [:octicons-arrow-right-24: 用户手册 · 快速开始](guide/index.md#快速开始)

- **② 想改配置 / 查命令**

    配置手册按分组列出全部键名，命令手册覆盖 `.ai` 全部指令。

    [:octicons-arrow-right-24: 用户手册 · 配置手册](guide/index.md#️-配置手册)
    ·
    [:octicons-arrow-right-24: 完整命令手册](guide/index.md#-完整命令手册)

- **③ 要改代码 / 排查问题**

    架构、模块职责、工具系统、数据存储与排障要点。

    [:octicons-arrow-right-24: 知识库索引](kb/index.md)
    ·
    [:octicons-arrow-right-24: 常见问题](kb/09-注意事项与常见问题.md)

</div>

---

## 📚 这份文档里有什么

| 分区 | 内容 | 适合谁 |
| --- | --- | --- |
| [**用户手册**](guide/index.md) | 安装在 SealDice 上的使用说明：快速开始、完整安装、配置手册（模型/角色/上下文/工具/MCP/记忆…）、完整命令手册、可用工具函数、常见问题 | 使用插件的骰主 |
| [**开发者知识库**](kb/index.md) | 14 篇按编号组织的项目文档：架构设计、核心模块、工具系统、命令与配置实现、数据存储、开发指南、方案设计稿 | 改代码、写扩展、排查线上问题的人 |
| [**第三方参考**](reference/index.md) | Claude Code 官方文档存档（Hooks / MCP / Settings 等），供对照参考 | 需要横向参考的开发者 |

### 开发者知识库导览

- **先读这两篇**：[01 项目概览](kb/01-项目概览.md) → [02 架构设计](kb/02-架构设计.md)
- **动手改代码**：[07 开发指南](kb/07-开发指南.md)、[03 核心模块详解](kb/03-核心模块详解.md)、[04 工具系统](kb/04-工具系统.md)
- **排查线上问题**：[09 注意事项与常见问题](kb/09-注意事项与常见问题.md)

!!! info "16 是已实现的方案 / 实现规格"

    [16 图片生命周期与图床](kb/16-图片生命周期与图床方案.md) 记录的是 **4.27.0 已实现**的行为
    （插件侧接入 `image-host`；后端 `image-host 1.0.14`）。文中「后端 → 图床」「图床Token」等旧称呼
    对应现在的「后端配置」JSON（v1），配置以 [08 相关后端项目](kb/08-相关后端项目.md) 为准。
    14 / 15 等已清理的历史方案见 Git 历史（v4.26.0 及更早提交）。

!!! success "17 已实现"

    [17 图片引用标准与 AI 图库交互](kb/17-图片引用标准与AI图库交互方案.md) 已在插件 4.27.1 + image-host 1.0.15 落地：
    `[img:<ref>]` 通用引用标准、ImageRefAdapter 翻译层、工具返回图片的来源元数据与英文类型标签（按产出工具映射，不调识图；不与元数据重复）、
    `image_view` 批量看图、`image_keep/tag/unkeep` 批量处理及其上限。

---

## 🔗 相关链接

- [GitHub 仓库](https://github.com/error2913/aiplugin4)
- [最新版本下载](https://github.com/error2913/aiplugin4/releases/latest)
- [SealDice 官方手册](https://docs.sealdice.com/)
- [配套后端 aiplugin4-backends](https://github.com/error2913/aiplugin4-backends)

---

## 关于本站

本站由 [MkDocs](https://www.mkdocs.org/) + [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/)
构建，源文件就是仓库里的 `README.md`、`docs/`、`ccdocs/`，
由 [`.github/workflows/docs.yml`](https://github.com/error2913/aiplugin4/blob/main/.github/workflows/docs.yml)
在 `main` 分支更新时自动发布。内容与代码不一致时，**以仓库代码为准**。
