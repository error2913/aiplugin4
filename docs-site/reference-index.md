---
title: 第三方参考
---

# 第三方参考（Claude Code 官方文档存档）

!!! danger "这是第三方资料，不是本项目的文档"

    本分区收录的是 **Claude Code 官方文档的离线存档**，随仓库放在 `ccdocs/` 下，
    用于开发时横向对照（Hooks 机制、MCP 协议、Settings 字段等）。

    - **不要把这里的配置项当成 aiplugin4 的配置**——插件自身的配置见
      [用户手册 · 配置手册](../guide/index.md#️-配置手册) 与
      [05 命令与配置](../kb/05-命令与配置.md)。
    - 内容版权归 Anthropic 所有，可能已滞后于官方最新版本；
      以 [code.claude.com/docs](https://code.claude.com/docs/llms.txt) 为准。
    - 本分区页面已标记 `noindex`，避免与官方文档在搜索结果中混淆。

## 存档清单

| 文档 | 内容 |
| --- | --- |
| [Hooks 参考](hooks.md) | Claude Code 生命周期钩子：事件、匹配器、输入输出协议 |
| [MCP](mcp.md) | Model Context Protocol 接入、服务器配置与传输方式 |
| [Settings 参考](settings-reference.md) | 全部设置项字段说明（最大的一个文件） |
| [Amazon Bedrock](amazon-bedrock.md) | 在 Bedrock 上运行 Claude Code |
| [Google Vertex AI](google-vertex-ai.md) | 在 Google Cloud 上运行 Claude Code |
| [第三方集成](third-party-integrations.md) | 企业部署与第三方集成概览 |
