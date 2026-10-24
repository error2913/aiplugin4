// 版本更新日志（数据文件）：4.11.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `- 新增请求超时相关
- 修复addMemory时，keywords可以为null的问题
- 新增表情包制作工具
- 新增活跃时间
- 新增展示时间
- 新增清除上下文标志位$gCLRMSGS，1:清除所有上下文，2:清除assistant和tool上下文，3:清除user上下文
- 适配了戳一戳事件
- 重构权限检查
- 重构timer，增加间隔定时器
- 为记忆新增images字段，用于存储图片id
- 新增查看精华消息，删除精华消息工具函数`;
