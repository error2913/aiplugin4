// 版本更新日志（数据文件）：4.15.2。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 修复
- 修复提示词分层缓存：静态提示词、长期记忆、总结记忆和知识库按会话与版本缓存，记忆写入/删除/总结后主动失效，避免同一轮工具循环重复检索和嵌入
- 修复上下文 token 预算只裁剪历史消息的问题：现在统一估算 system、示例对话、历史消息和工具定义，优先保留 system/示例并从最早历史开始裁剪
- 修复上下文消息净化：清理空 tool_calls、孤立 tool 消息和无匹配工具结果，避免上游 API 因非法消息结构返回 400
- 修复示例对话中的空行导致 user/assistant 角色错位；修复定时器、指令入库、批量改名等异步调用缺少 rejection 兜底
- 修复图片消息中 Milky file 对象被误当成字符串的问题，并持久化通过 URL 创建的图片资源

## 消息接收
- 核心消息优先：直接使用 SealDice 原生 msg.message/消息事件，保留文本、图片、表情、at、reply、poke 等渲染标签
- 补充 OB11 依赖消息：仅处理核心未接收的文件、视频、语音、卡片、音乐和合并转发等消息，避免重复入库
- 完善 Milky 消息段转换：按 msg.segments 类型展开文本、图片、at、reply、face、file、video、record、music、json、消息节点等内容，并将 reply 序号转换为可引用的消息 ID；异常段只占位，不中断整条消息
- 修复负数消息 ID、未知表情、全体 at、私聊消息和嵌套消息节点进入上下文时的标签与发送者信息

## 工具与图片
- 增加 MCP 总开关与图生图能力：text_to_image 支持图片 ID、头像、URL、data URL 和 base64，适配 aiplugin4-dependencies 新接口
- 按需工具摘要限制数量并提供参数概览，减少 system prompt 中函数列表占用的 token

## 配置项更改
- 无新增或删除配置项；本版本主要为消息接收、提示词缓存、工具调用和图片处理的实现修复。升级后无需恢复默认配置。

## 日志
- 日志格式升级：每条日志带级别短标签（[ERROR]/[WARN]/[INFO]/[DEBUG]）与模块标签（[agent]/[model]/[pipeline]/[timer]/[send]/[ob11]/[context]/[image]），按模块过滤、按级别着色更直观
- 请求上下文改为摘要 + 明细两级：默认只打 run 号与消息条数摘要，逐条 role/长度/toolCalls 与正文进 DEBUG 级别，「日志记录消息内容」 开关仍控制正文是否输出
- 异常统一走 exception()：错误进 ERROR、堆栈进 DEBUG，不再把堆栈拼进单行错误
- 脱敏加强：URL query 中的 token/signature 等参数、sk- 前缀密钥、access/refresh token 一并打码
- 长文本分段打印带 [第x段/总段数] 标注；响应内容/思维链默认只打印截断摘要
`;
