// 版本更新日志（数据文件）：4.10.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `- 可能修复了非指令无法响应的问题
- 修复了构建ctx时，isPrivate始终为0的问题
- 新增保存图片功能
- 重构了定时任务的执行
- 新增短期记忆单独控制开启
- 新增memo status命令
- 将ai pr命令改为ai status`;
