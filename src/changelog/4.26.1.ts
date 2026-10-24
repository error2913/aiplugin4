// 版本更新日志（数据文件）：4.26.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 角色 / 技能 / MCP / 知识库配置改为 JSON

- **四个配置项改为单框 String JSON**（新键名，旧模板键不再注册/读取，不做迁移）：
  「角色设定」「技能列表」「MCP服务器」「知识库配置」。
  格式见 README「配置手册」，推荐用配置生成器 https://error2913.github.io/aiplugin4-config/ 的四个页签生成后粘贴。
- **MCP 改为标准 \`mcpServers\` JSON**（与 Claude Desktop / Cursor 一致）：\`{"mcpServers":{"服务器名":{"type":"http","url":"…","headers":{…}}}}\`；
  \`platform\` 是可选平台白名单扩展；stdio / SSE 继续跳过；生成器的「启用」开关只控制是否写入，不写 \`enabled\` 字段。
- **MCP 默认配置改为空**（不再预置三台服务器），保留「是否启用MCP」总开关（默认关闭，避免没配 MCP 时启动/对话报错）；配置生成器「MCP」页仍保留三台示例供按需复制。
- **技能**保留标准 \`SKILL.md\` 的 frontmatter 仅作为生成器「文件导入」格式；插件运行时只读 JSON，不再解析 frontmatter。
- **出厂默认**由 \`scripts/gen-domain-default-data.mjs\` 从旧默认值生成：角色/录卡/三个知识库与旧版一致，MCP 为空。

## 联网搜索默认值调整

- **默认项改为「联网」页独立配置项**：\`联网搜索返回条数\`（默认 10）、\`联网搜索详细程度\`（默认 summary）、\`联网搜索超时\`（默认 20 秒）、\`联网搜索正文截断\`（默认 5000 字）、\`联网搜索失败回退\`（默认开）；旧的联网 JSON \`defaults\` 字段忽略、不再读取。
- 配置生成器「联网搜索」页已移除默认项，只生成 \`providers\` / \`routes\`。
`;
