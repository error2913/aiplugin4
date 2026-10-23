// 版本更新日志（数据文件）：4.14.2。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 修复
- 修复上下文存在空 tool_calls 数组时请求被后端拒绝的问题（Invalid 'messages[N].tool_calls': empty array）：构建请求时只在非空时附带 tool_calls，会话加载时自动清理历史遗留的空数组，并在流式/非流式请求入口统一兜底净化
- 修复工具调用过滤时未剔除空 id 的 tool_call、tool 消息缺失 tool_call_id 时仍发送的问题
## 说明
- 无需恢复默认配置；长期使用过旧版本的会话会在下次加载时自动清理残留的空 tool_calls 数据`;
