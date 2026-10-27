// 版本更新日志（数据文件）：4.29.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## ⚠️ 重要：提示词全面英文化（破坏性）

- **system prompt 全英文**：内置提示词改为英文段注册表（identity / role / response language / session / message markers / images / reply style / work direction / tool access / skills / knowledge / sub-agent delegation / current time / long-term memory）。角色设定、技能/知识库正文等**用户内容保持原语言**，机器人仍按对话语言回复（新增「Response language」段约束）。
- **代码生成的上下文标记全部改英文且不再兼容旧中文**：\`[原文已压缩]\`→\`[content-compressed: …]\`、\`[原文已截断]\`→\`[content-truncated: …]\`、\`[工具原文过长]\`→\`[tool-output-truncated: …]\`、\`[图片识别原文过长]\`→\`[image-text-truncated: …]\`；\`【工具返回:name】\`→\`[tool_result:name]…[/tool_result]\`；\`[system:…]\` 名义改为 \`trigger\` / \`group-event\` / \`request-event\` / \`media-task\` / \`subagent\` / \`timer\` / \`active-hours\` / \`nudge\` / \`cross-session\` / \`condensed-history\` / \`preserved\`；群事件/好友事件/请求事件/定时器/媒体任务/子代理结算等通知句改为英文。**旧会话里的中文标记不再被识别/清理**（作为普通文本保留，不迁移）。
- **工具 schema 全英文**：全部内置工具的描述与参数说明、工具分类/组名（Dispatch / Memory / Images / Subagents …）、媒体工具动态参数说明改为英文；\`search_music\` 平台枚举改为 \`netease\`（内部兼容旧值）。\`.ai tool\` 输出的描述与组名同步为英文。
- **默认配置内容英文**：出厂角色 \`Test Bot\`、默认技能 \`Character Card Import\`、默认知识库 \`Core Commands\` / \`Extension Commands\` / \`ob11-api\` 及媒体预设说明改为英文。**海豹不提供配置写回能力**，已安装用户存储的中文默认值不会自动更新；需要英文默认值的用户请在 WebUI 里恢复默认或重新粘贴配置生成器输出（涉及「角色设定」「技能列表」「知识库配置」「MCP服务器」；旧默认技能名还会被自动补入一个新的英文技能，恢复默认技能列表即可清理）。
- **辅助提示词英文**：判分、记忆抽取/观察/反思/增量/重排、心智模型固定问题、子代理 system/摘要器、压缩/摘要智能体 instruction、识图提示均改为英文；观察/抽取/摘要/反思提示词显式要求「用对话语言产出」。
- **旧中文兼容移除**：不保留中文文案字典、不做旧标记 dual-read；旧 persona 问题迁移改为哈希比对（不保留中文字面量）。

## 提示词架构：段注册表 + system/runtime 分道

- 新增 \`src/prompt/\` 段注册表：内置模块与外部插件都通过 \`registerPromptSection\` 注册**有序段**（name/order/channel/gate/cache/build）；组装时按 order 排序、空段丢弃、单段上限、仅外部数据段清洗内部标签、可选全局预算、组装 hook、digest 统计。
- **system 只放稳定段**（30s 段级缓存，deps 变化即失效）；**时间/长期记忆改为每轮 runtime 段以 user 消息注入**（\`[system:runtime]…[/system]\`），system 前缀跨轮稳定，提升前缀缓存命中；可用内部常量回退到 system。
- 段级缓存替代手工 \`staticKey\`：技能签名、知识库签名、工具可见性、记忆 revision、角色设定等 deps 自动参与 key；记忆/总结写入后主动失效。
- 新增 \`.ai prompt sections\`：查看段统计（order/name/channel/chars/tokens/cache）与 prompt digest；\`.ai prompt\` 同时展示 system 与 runtime 段。
- 对外 API 新增 \`globalThis.aiplugin4.registerPromptSection()\` 与 \`onPromptAssemble()\`（外部段限 \`ext:\` 命名空间、order ≥10000、单段 ≤2000 字符、合计 ≤4000、默认外部清洗）。
- 新增 **\`core:capabilities\` 能力地图段**：按当前会话已开启、平台匹配的工具组生成英文“能力域 + 用途 + 2 个代表工具”清单（不含参数），并明确要求「不确定能力时先 list_tools / search_tools，不要直接说做不到」；STATUS 关闭或没有可用工具时整段为空。MCP 服务器用途标签取配置 \`description\`，缺省用 \`initialize\` 的 \`serverInfo.title\`，再缺省用服务器名（运行时数据，不翻译）。
- **发现类工具可读性**：\`list_tools\` / \`search_tools\` / \`list_mcps\` / \`call_tool\` 的模型可见结果与错误文案改为英文；\`list_tools\` 组头带代表工具与分页提示、单条描述截断 160→240；\`search_tools\` 详情标注来源并提示用 \`call_tool\` 执行；未找到工具时提示用 list_tools/search_tools 查看可用能力。

## 能力认知（AI 知道“自己能做什么”）

- 之前 system prompt 只写“工具未列出，需要时用 list_tools/search_tools 发现”，模型遇到跨域任务容易直接回答“做不到”；新增的能力地图给出域级清单（Memory/Images/OB11/Web/Subagents/MCP…），把“发现工具”从盲搜变成定向确认。
- 能力地图只列域与代表工具名，不复制工具 schema（每轮 token 增量约 200–350），参数仍由 \`search_tools\` 按需提供；段级缓存按工具开关/平台/MCP 标签签名失效。
- MCP 用途来源优先级：服务器配置 \`description\` > \`initialize\` 返回的 \`serverInfo.title\` > 服务器名；不调用 LLM 总结、不在提示词装配时联网。

## MCP 适配（对齐主流客户端）

- 解析 \`initialize\` 返回的服务器 \`instructions\`；新增每服务器配置 \`exposeInstructions\`（默认关闭），开启后以 runtime 段注入（低权威、长度上限、外部清洗），不污染 system 前缀。
- 解析 \`initialize\` 返回的 \`serverInfo.title\`，与新增的可选配置 \`description\` 一起作为能力地图的服务器用途标签；\`.ai mcp list\` 同步展示用途。
- \`tools/list\` 的 \`annotations\`：\`destructiveHint=true\` 的 MCP 工具注册为敏感工具；工具名/参数不变。
- 新增 \`mcp_list_resources\` / \`mcp_read_resource\` 工具（resources 按需读取，不进 system prompt）；新增 \`.ai mcp prompt list|get\`（prompts 由用户手动触发，不自动注入）。
- \`${'`'}mcp\` 服务器仍只通过 tools 作为模型主通道；未实现 sampling / roots / elicitation / OAuth / MCP Apps。

## 修复

- **修复 system prompt 示例被自身清洗剥掉**：旧实现把整条 system 文本交给 \`stripInternalTags\`，导致 \`[from:…]\`/\`[msg_id:…]\`/\`[system:…]\`/\`[tool_result]\` 示例被删除；新架构按段清洗（内置文案 trusted、外部数据 external）。
- 新增第 5 个此前未登记的截断标记（编译层事件区间 \`content-truncated\`），统一纳入协议常量并被清理。
- 技能输出（\`## Skill: …\` / \`use_skill returned:\`）的截断豁免前缀随英文化同步更新，避免技能正文被误截断。
- 压缩/摘要/子代理摘要头、上下文桥角色标签、入站媒体占位符、折叠摘要系统名义等统一改为英文。

## 图片：角色规则、请求体预算与模型图源（v2）

- **assistant 消息不再携带图片**：API 明确拒绝 \`Image in assistant message is not supported\`；机器人回复里的 \`[img:ID]\` 在入库、编译、旧数据迁移三处统一降级为文本标签，历史脏数据无需迁移即生效。
- **aux / 对外 API 默认不解析图片（破坏性）**：摘要/压缩/评分/记忆等辅助调用固定不带图；\`globalThis.aiplugin4.chat()\` / \`chatMessages()\` 默认把 \`[img:]\` 当文本，需要模型看图时显式传第 3 个参数 \`{ allowImages: true }\`（非 user 消息里的图片块仍会被清洗）。
- **请求体过大（413）恢复**：识别 413 与网关 HTML 报错 → 本轮丢全部图片重发 → 仍超限按 \`resolveEffectiveMaxTokens×0.8\` 归档重试 → 再失败则记日志放弃（不再静默无回复）。
- **内联预算**：下载失败等异常路径只内联 \`/m\` 模型变体（禁止内联原图），默认单张 1MB / 整轮 4MB / 最多 4 张，超预算只留文本标签；旧后端（无 \`/m\`）内联原图同样受限。
- **模型图源**：单边超过 8192 的图只留文本；图床 1.0.16+ 按「模型图片目标长边」提供 \`/m\` 变体（GIF 默认首帧）；\`/i\`、\`/m\`、\`/b64\` 四种 URL 统一映射回图床 ID，下载失败降级不再误判。
- **数量与开关**：每轮图片上限默认 8（原 20）、每条工具结果升格默认 4（原 8）；新增「模型工具结果图片」开关（默认开）；MCP 原生图片块与旧 \`contentParts\` 图片统一受上限约束。
- **\`thinking\` 字段校验**：模型规则 \`body.thinking\` 写成字符串（如 \`"enabled"\`）时校验给出可读报错，请求层也会忽略并告警，避免整轮 422。
- **\`.ai img unmark <图片ID|all>\`**：清除「模型不可用」标记（图本身没坏，可恢复使用）。

## 配置项更改

- 图片页签新增：模型图片单边上限(8192)、模型图片目标长边(2048)、每轮最多图片数(8)、每条工具结果最多升格图片数(4)、单张内联上限KB(1024)、每轮内联总字节KB(4096)、每轮最多内联图片数(4)、模型工具结果图片(开)；原「每轮最多内联图片数」拆为「每轮最多图片数」与「每轮最多内联图片数」两个键。
- \`MCP服务器\` 的 JSON 条目新增可选字段 \`exposeInstructions\`（默认 false，旧配置无需修改）与 \`description\`（服务器用途，可选，用于能力地图与 \`.ai mcp list\`）。
- 「提示词模板」维持内置不可配置；本次内置模板内容已全部改为英文。

## 开发与工程

- 新增单测：\`scripts/unit-test-prompt.ts\`（注册表/组装/缓存/清洗/通道/hook/digest/内置段集成/能力地图）、\`scripts/unit-test-protocol.ts\`（标记构造与剥离、旧中文不识别锁定、系统名/包装）、\`scripts/unit-test-mcp.ts\`（instructions/annotations/prompts/resources/能力地图标签）、\`scripts/unit-test-image-source.ts\`（图源头解析/选源/轨迹定位/角色与 413 分类/URL 映射/内联预算/MCP 图上限）；\`scripts/unit-test-image-host.ts\` 增补变体内联预算与排除用例。
- 协议文本单一事实源 \`src/utils/protocol.ts\`（L0 叶子）；记忆缓存失效前缀改为 \`sect:core:memory|\`；依赖边界检查无新增跨层依赖。
- 验证：单测 654 通过、\`tsc --noEmit\`、\`lint\`、\`smoke\`、\`deps:check\`、\`domain:check\`、\`sim\` / \`sim:matrix\` 全绿。
`;
