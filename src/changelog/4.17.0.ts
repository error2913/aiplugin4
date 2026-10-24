// 版本更新日志（数据文件）：4.17.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 记忆引擎重构为 Hindsight-like 纯 TS 引擎：新增 reflect_memory（基于记忆推理，返回心智模型/观察记忆/事实证据汇总）与 consolidate_memory（观察巩固，合并重复观察、清理过期记忆）工具；.ai memo 子命令改为 obs（观察记忆），支持 on/off、list、立即生成、clr
- run_core_command 改为直连 ob11-core-bridge 的 /plugin WebSocket：新增「核心桥WS地址/核心桥Token」后端配置，支持自动重连/超时/令牌校验；默认 MCP 服务器列表移除 ob11-core-bridge
- MCP 工具结果通用归一化并支持多模态内容块；call_tool 原样透传 contentParts（文本 + image_url 等），不再把对象 toString 成 [object Object]
- 特殊 ID 处理：上下文消息 ID 使用 base36 短 ID（超出 2^53 的大整数无损还原），图片保留原始段字段，语音/视频/文件消息登记 handle=句柄；新增 resolve_special_id 工具还原原始 message_id/file/url 等字段，call_ob11_api 调用前自动把短 ID 归一化为协议端可用的原始值

## 修复
- 修复 DeepSeek thinking mode 下带工具调用的轮次请求报 400：assistant 消息的思维链 reasoning_content 全链路原样透传（含空字符串），工具轮 / 提示词工程轮 / 最终回复均入库并在后续请求中带回
- 修复 anthropic（Claude）适配：assistant 消息的思维链自动转换为 thinking 块并置于消息最前，相邻 assistant 消息的 thinking 块自动合并，避免工具循环时请求体结构非法
- 修复 OB11 发送路径把渲染标签原样外发：call_ob11_api 发送消息前把 [img:]/[at:]/[poke:]/[quote:]/[face:]/[avatar:]/[audio:] 等解析为真实消息段，并剥离 [from]/[msg_id]/[system]/[time] 内部标签
- 修复论坛发帖/评论/编辑把内部或渲染标签原样外发：统一清洗为纯文本/Markdown，仅保留正文
- 修复核心桥 WebSocket 连接状态判断：使用数值 readyState 并补充 connected 状态，兼容 SealDice WebSocket 实现

## 功能调整
- 长期记忆检索改为按最近 2~3 条用户消息的全部发言者进行，群聊多人在线时不再只按最后一位发言者过滤
- 观察记忆提示词返回格式示例改为严格合法 JSON（键与字符串使用双引号），并明确要求不输出 Markdown 代码块，降低模型返回非法 JSON 的概率
- 旧记忆自动迁移到 v2 引擎，统一用户可见术语为「观察记忆」

## 开发与工程
- 升级 eslint 9 + flat config，移除未使用的旧依赖（lodash-es / eslint-plugin-functional / fs-extra / source-map-support 等），消除 npm install deprecation 警告
`;
