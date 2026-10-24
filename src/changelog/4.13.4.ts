// 版本更新日志（数据文件）：4.13.4。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 对外 API（globalThis.aiplugin4）新增三种模型直接调用：chatMessages（传入 OpenAI 风格 messages 数组调用对话模型）、imageToText（识图）、embed（文本向量），其他插件可构建消息直接拿回复
- web_read 工具新增网页截图能力（screenshot=true，支持宽高/整页/延时），截图返回图片可直接发送
- web_read / render_markdown / render_html 后端改为 MCP（Streamable HTTP）调用，配置默认值指向 /mcp 端点；对应后端 REST 接口已移除
## 优化
- seal.d.ts 类型补齐（配置注册 group 参数、async solve），启用 strict 类型检查
- 移除 globalThis.http 旧依赖兜底，统一使用 ob11 网络连接依赖
- 新增 AGENT.md 代理协作速查文档
## 修复
- 修复工具调用后孤立 tool 消息导致的 API 报错（tool 消息缺少对应 tool_calls）`;
