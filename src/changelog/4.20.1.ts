// 版本更新日志（数据文件）：4.20.1。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 配置变更
- 「心智模型默认刷新模式」改为下拉选项「心智模型刷新模式」：可选 full（基于全部记忆重新推理）/ delta（只按新增记忆增量更新），默认 full，功能与原先一致
- 知识库默认示例补充 frontmatter（name/description）：默认库名与描述改由 frontmatter 定义，正文不变；配置描述同步说明 frontmatter 格式（无 frontmatter 时回退用 # 一级标题 + 正文首段）
`;
