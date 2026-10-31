// 版本更新日志（数据文件）：4.30.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 判定默认值修正（4.30.0 回归）

- **默认模板与兜底统一**：4.30.0 的「评分触发参数」默认模板与解析兜底用了 \`speak_threshold = 0.6\` 与另一组权重，本版统一为 \`speak_threshold = 0.4\`、权重 \`addressed = 4\` / \`help_signal = 3\` / \`relevance = 6\` / \`friendships = 3\` / \`silence_gap = 2\` / \`interruption_risk = -1\`。访问路径：触发页「评分触发参数」默认值、\`.ai trg judge default\` 打印的模板、TOML 缺字段时的兜底。
- **已安装用户不受影响（行为不变）**：海豹没有配置写回 API，已存储的「评分触发参数」不会被自动改写；不重新粘贴模板就沿用你当前的 TOML。需要新默认值请在触发页重新粘贴默认模板（\`.ai trg judge default\` 可打印）或手动改 \`[scoring]\` / \`[weights]\`。
- **文档同步**：README、docs/03、docs/09 的默认阈值与默认模板改为 0.4 与该组权重。
`;
