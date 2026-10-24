// 版本更新日志（数据文件）：4.13.3。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 新功能
- 新增 run_ext_command/run_core_command 工具：扩展指令区分 builtin/non_builtin，核心白名单使用 core|指令名；新增「指令前缀」配置，默认为 .
- 指令技能（今日人品/COC 模组/属性展示/检定/san检定）统一改为通过 run_ext_command 调用
- 工具按需加载：search_tools/call_tool/use_skill/run_ext_command/run_core_command/get_time 常驻，其余工具按需搜索并统一执行，system prompt 从约 2 万字符降到约 2800 字符
## 优化
- 更新链接改为官方 GitHub Release；商店 README 移除开发章节，只保留用户文档
## 修复
- tsconfig 改用 bundler 解析模式，兼容 TypeScript 6+
- 工具超长返回仅记录日志不发送，并分段打印`;
