// 版本更新日志（数据文件）：4.14.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 用户消息上下文补全发送者与消息 ID：每条用户消息带 [from:名字(QQ号)] 前缀与 [msg_id:xxx] 标记，模型可直接用 [quote:xxx] 引用历史消息
## 修复
- 修复回复段缺失消息 ID 时生成空 [quote:] 标签、发送引用时出现 id=NaN 的问题（无 ID 时跳过引用）
## 配置项更改
- 删除「展示号码」配置项：消息来源、发送者、群聊等一律固定展示数字号码，无需再配置
- 「system prompt模板」默认内容更新：补充 [from]/[msg_id] 标签说明，自定义过该模板的用户请恢复默认
## 重要
- 本次需要恢复默认的配置项：「system prompt模板」`;
