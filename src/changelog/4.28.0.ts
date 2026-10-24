// 版本更新日志（数据文件）：4.28.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 图片引用标准与 AI 图库交互（CIR v1 / image_view / 工具图类型标签）

- **CIR v1**：\`[img:<ref>]\` 统一支持 图床 \`h<sha256>\` / 裸 sha256 / 插件图片 ID / 头像；工具结果里的图床引用自动规范化为 \`[img:h<sha>]\` 并注册内存虚拟图（不落插件 storage、不进索引、不重复上传）。
- **看图**：新增 \`image_view\`（多模态聊天模型直接看，支持 \`ids[]\`≤4；不支持视觉/取图失败自动降级文字描述）；\`image_to_text\` 支持 \`ids[]\`≤3。提示词工程模式下工具返回的 image contentParts 不再被丢弃。
- **工具图片**：生图/表情包/MCP image block 入库时记录来源元数据（群/用户/会话/工具/服务器，不写“未知”），并按产出者自动打英文类型标签（\`ai-generated\` / \`meme\` / \`mcp-image\` / \`tool-image\`）；类型标签是确定性映射，不调用识图模型；来源/群/工具只写元数据，不再写成标签。
- **模型可达性**：图床对外地址是内网/回环而模型端点是公网时，模型侧自动改用内联 base64；模型报图片下载失败时先探测 404，图片仍存在则用 b64 重试，不再永久标坏；回退链恢复为 URL → b64 → 稳定原始 URL → 文本标签。
- **引用管理**：\`resolve_special_id(type=image)\` 返回 \`hosted_id\`/\`hosted_url\`；\`get_image\` 对图床引用明确提示“没有协议端缓存文件，请用 URL 或 \`[img:]\` 发送”（不下载落盘）。
- **MCP**：支持 \`imageRefs\` 配置（image-host 自动/生成器写入）；后端 image-host 1.0.15 提供 6 个工具（search/keep/unkeep/rename/tag/tags），搜索支持 tool/server/platform/group_id/since/tags 过滤；keep/unkeep/tag 单次 ≤50；工具元数据标签（\`来源:\`/\`群:\`/\`工具:\` 等）会被拒绝。
- 批量：\`image_view\`≤4 张、\`image_to_text\`≤3 张、keep/unkeep/tag≤50 个 id；不提供 AI 删除。


## Skills：注入预算与 use_skill 健壮性

- **修复「可用技能」段预算失效**：此前重构后只按 100 条截断，长描述可能把 system prompt 撑大；现恢复 1500 字符列表预算（100 条为第二道上限），单条描述超过 200 字符截断、空描述自动取正文首段，超预算条目跳过后继续列后续短条目。
- **use_skill 增强**：返回统一带技能标题与结束边界；正文超过 12000 字符时给 \`offset\` 续读；\`{{skill:名称}}\` 引用新增循环引用/未开启/不存在/超过最大深度的明确标记；结果豁免「工具响应截断字数」的 head 截断，保证末尾的续读提示不被吞掉。
- **配置自动生效**：修改「技能列表」后下一条消息自动重新解析（不会因暂时非法 JSON 清空技能，保留上一份可用列表）；\`.ai skill refresh\` 强制重解析失败时也保留上一份并明确提示，不再静默回退出厂技能。
- 工具结果文本在渲染层转义 \`[/tool_result]\` 边界（幂等），入库路径继续剥离内部标签；技能名/描述的配置校验给出 warning 指引。
`;
