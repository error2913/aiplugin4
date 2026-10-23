// 版本更新日志（数据文件）：4.14.3。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 修复
- 修复 milky 协议纯文本消息被误判为「未知消息段」的问题：goja 反射会把 Go 命名 int 类型（ElementType）包装成 Number 对象而非原始值，导致类型分派时严格相等失败、纯文本被当成 [未知消息段] 占位，上下文看不到真实内容；现在先归一化为数字再做类型分派，文本/at/图片/回复等段按原类型正常展开
## 说明
- 无需恢复默认配置`;
