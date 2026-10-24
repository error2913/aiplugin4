// 版本更新日志（数据文件）：4.15.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 修复
- 修复 MCP 服务器配置默认值 mcp-files-exec 的 url 缺少 /mcp 路径的问题：默认值修正为 http://127.0.0.1:3910/mcp，与后端 Streamable HTTP 实际路径一致（旧默认值初始化会 404，面板实测 list_dir / read_file 调用正常）
- 自动改名（昵称/群名片）增加 5 秒超时保护：ob11 网络连接依赖请求异常或未响应时不再让整条消息处理链路挂起，超时记 warning 后继续处理
## 配置项更改
- MCP 服务器配置默认值更新：mcp-files-exec 的 url 由 http://127.0.0.1:3910 改为 http://127.0.0.1:3910/mcp
## 重要
- 若面板上已保存过旧的 mcp-files-exec 地址（http://127.0.0.1:3910），请在「工具 → MCP服务器配置」中改为 http://127.0.0.1:3910/mcp，或直接恢复默认配置`;
