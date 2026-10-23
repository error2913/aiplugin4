// 版本更新日志（数据文件）：4.13.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 连续多条 user 消息合并后超阈值自动调用压缩智能体压缩，与单条超长消息统一处理
- 消息压缩阈值默认改为 2000
## 优化
- 对话请求默认 max_tokens 4096 -> 8192，避免思考链过长导致输出截断
## 修复
- 修复压缩/总结等用途的模型匹配失败时静默失效：getChatModel 会回退到 chat 用途模型`;
