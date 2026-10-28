// 版本更新日志（数据文件）：4.30.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 记忆注入：尾部约束、预算下调与多 bank 相关性排序

- **记忆段末尾新增低权威约束句**：长期记忆位于 runtime，是整条请求的最后内容，容易让模型把历史记忆当成当前请求。现在记忆文本之后追加一句英文约束（背景、可能过期、非当前请求、相关才用），随 \`[system:runtime]\` 以 user 消息注入，不进入 system；记忆为空时整段（含标题）不输出，也不追加约束句。
- **单轮注入预算 3000 → 2048 token，单 bank 召回上限 1600 → 1024 token**：与 Hindsight 口径（2048）及心智模型输出上限一致；预算变紧后由相关性排序决定谁进入上下文。
- **群聊多 personal bank 按相关性排序**：之前固定为「当前会话 → 最近 3 位发言者 → global」，与 query 相关性无关；现按元组 \`hasHits → bestHit → bestModel → updatedAt → 原顺序\` 排序（当前会话 bank 固定第一、global 固定最后），同一轮预算下优先保留最相关的 bank。
- 段内心智模型改为「固定模板（persona 等）在前、相关性补余」，复用既有 \`mergeMentalModels\`；观察保持最近更新优先，事实保持召回顺序；隐私过滤（owner/origin/public、群聊个人 bank 不注入心智模型）不变。

## 配置项更改

- 「记忆注入 token 预算」默认值 3000 → 2048。**海豹不提供配置写回能力**，已安装用户存储的 3000 不会自动变化；需要新默认值的用户请在 WebUI 里恢复默认或手动改为 2048（文档：README「长期记忆」配置表、docs/13 §6.3/§8）。

## 开发与工程

- 新增单测：记忆尾部约束（runtime / 无记忆 / 不进 system）、空段整段丢弃、预算默认值 2048 与单 bank 1024、多 bank 相关性排序、预算裁剪顺序。
- \`v2/prompt.ts\` 渲染器：空 section（只有标题、没有条目）整段丢弃；\`MemoryService.collectSections\` 带出每个 bank 的相关性信号，\`buildMemoryPrompt\` 渲染前排序。
`;
