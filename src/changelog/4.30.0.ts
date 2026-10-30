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

## 上下文：保留强度、预算到顶压缩与消息标签分级

- **新增「保留强度」配置（默认 30，范围 1-100）**：压缩后保留最新原文占上下文预算的比例，其余由滚动摘要替代；该比例同时用作消息 \`[msg_id]\`/\`[time]\` 的标签边界。
- **压缩只在预算到顶时触发**：编译器发现未摘要原文被预算裁掉（请求装不下）后，本轮回复结束才在后台按目标压缩；分批滚动摘要、每小时批次数上限、失败退避；空闲会话不会产生后台 LLM 调用。
- **编译器按滚动摘要边界裁剪原文（单元感知）**：已摘要内容不再重复以原文出现，摘要头带起止时间与 \`read_raw\` 指针；摘要区间与 edit/redact 相交时回退旧行为（原文优先），避免撤回/编辑内容仅经摘要残留。
- **消息标签分级**：保留窗口内 user 保留 \`[from][time][msg_id]\`、assistant 保留 \`[msg_id]\`；更旧消息去掉 \`[msg_id]\`，\`[time]\` 只在关键时间节点（首条未标记消息 / 静默 ≥1 小时 / 跨自然日 / 每 100 条消息）出现；system 事件不变。
- **检索出口**：\`grep_raw\` / \`read_raw\` 结果带发送时间与消息 ID，\`grep_raw\` 按时间升序返回；工具描述同步（缺 ID 时先检索，不要臆造）。
- **摘要记录**：新增可选 \`fromAt/toAt\`（\`fromAt\` 沿袭上一条滚动摘要）；摘要文本硬上限 2000 → 4000，与编译注入上限统一。
- 摘要落盘/读取、事件账本、原文保留策略均不变：不删除、不改写历史事件。

## 上下文引用解析：resolve_context_ref 与记忆句柄

- **新增 \`resolve_context_ref\`（Raw search 组）**：模型把上下文里的表示原样粘贴进去即可还原具体信息——\`e:<seq>\` / \`e:<from>-<to>\` / \`msg_id\` / \`read_raw\` 指针 → 事件原文（带时间、msg_id、游标）；\`[mem:<id>]\` → 记忆完整文本/标签/时间；\`[img:…]\`、\`[record:…]\`、\`[quote:…]\`、\`[at:…]\`、\`[resource:…]\` → 原始字段、同会话被引用原文、昵称或 URI；\`kind=event_raw\` + \`e:<seq>\` → system 事件原始 JSON。只读、无网络、不调 LLM；长区间精读仍用 \`read_raw\`，自由文本检索仍用 \`grep_raw\`。
- **记忆注入带 \`[mem:<id>]\` 句柄**：事实、观察、心智模型统一带句柄；\`memory_recall\` 输出同步。\`memory_update\` / \`memory_delete\` / \`memory_mental_model\` 接受 \`[mem:<id>]\` / \`mem:<id>\` 形式，模型复制标签即可操作。
- **短 ID/媒体解析去重**：\`resolve_special_id\` 与 \`resolve_context_ref\` 共用一个 \`src/resource/resolve.ts\`，避免两套字段口径；\`resolve_special_id\` 输出行为不变。
- **v2 事件 raw**：新增按 seq 读取 system 事件 \`raw\` 的能力（\`Event.raw\` 含禁言/入群/申请等原始 JSON），并受 epoch/redact 可见性约束。
- 新增单测：引用解析、事件/事件 raw、read_raw 指针、内容标签、记忆句柄、歧义/错误路径。

## 配置项更改

- **删除「摘要水位」**：压缩触发改为「预算到顶（编译裁剪未摘要原文）」；记忆桥抽取水位改用内部常量 6000（与原默认行为等价）。
- **新增「保留强度」**：默认 30，范围 1-100；压缩后保留最新原文比例，同时作为标签边界。
- 「每小时后台压缩上限」口径改为**每小时压缩批次数**，默认 6 → 20；0=不限。
- 升级后旧「摘要水位」存储值不再读取，请按新键重新配置（WebUI「上下文」页）。

## 开发与工程

- 单测新增/调整：压缩运行时目标循环与每小时批次上限、摘要边界单元过滤、标签分级与时间锚点、stale 摘要回退、摘要 \`fromAt\` 继承、检索时间/消息 ID 与升序输出；\`npx tsc --noEmit\`、\`npm run lint\`、\`npm run test:unit\`、\`npm run deps:check\`、\`npm run build && npm run smoke\`、\`npm run sim\` 全绿。

## 全局提示词

- 新增「全局提示词」配置（「角色设定」页，默认留空）：对所有角色生效的公共提示词，作为 system prompt 新段 \`core:global\`，位于身份总述与角色设定之间；\`.ai role\` / \`$gSYSPROMPT\` 切换角色时内容不变。
- 留空则整段不注入，升级后默认行为不变（system prompt 与旧版一致）；内容保持原语言。修改后约 1 分钟内自动生效，可用 \`.ai prompt\` / \`.ai prompt sections\` 查看。
- 不进入判分、记忆抽取与子代理 child system：这些入口的输入与主对话 system prompt 相互独立。

## 配置项更改

- 新增「全局提示词」（「角色设定」分组）：默认空字符串；不需要公共提示词时保持留空即可，行为与旧版完全一致。

## 移除压缩智能体与 compression 用途

- **删除压缩智能体（compress_agent）**：v2 事件账本已不再调用它；旧回退路径的用户消息超长改为**纯代码 token 截断**（保留头+尾、原文进 rawText，\`read_raw kind=user\` 可回查），不再产生任何 LLM 调用；\`agent_compress_agent\` 存储键不再使用。
- **彻底移除 \`compression\` 模型用途**：\`ChatModelUse\` / v5 \`MODEL_USES\` / 出厂 \`purposes\` / \`.ai model\` 用途列表 / \`groups\` 用途组 / 用量页说明都不再有 compression；\`chat\` / \`summarization\` / \`judge\` 仍共用文本/视觉候选链。
- **旧模型配置自动兼容**：解析期自动剔除 \`purposes.compression\` 与 \`groups[].purposes\` 里的 compression（空组丢弃）并打 WARN；**无需重建配置**。配置生成器同步移除该用途，导入旧配置时同样清洗并提示。
- 历史 token 用量里的 compression 记录保留可查，不再新增。

## 工具结果：token 截断 + 分页回读

- **新配置「工具结果展示token上限」**（「工具」页，默认 **8192** token，0=关闭）取代旧「工具响应截断字数」；工具结果按 token 估算截断，只展示开头，末尾附 \`[tool-output-truncated: N tokens, first M shown; read_raw id=e:<seq>]\`。
- **完整原文不丢**：截断只发生在请求编译展示层，事件账本里的 \`tool_result\` 原文完整保留；用 \`read_raw id=e:<seq>\`（游标分页，单条/区间）或 \`grep_raw\` 回读。旧会话仍兼容 \`read_raw kind=tool\`。
- **工具结果不进滚动摘要**：摘要输入只保留工具名称/字数/\`read_raw\` 指针，不再把工具正文喂给摘要器，避免长工具输出挤占摘要预算并被二次加工。
- **子代理**：child 的工具结果同样按该上限截断；子代理没有 \`read_raw\`，截断标记会提示用工具自身的 \`offset\`/\`start_index\` 翻页或收窄查询。

## 配置项更改

- 新增「工具结果展示token上限」（「工具」分组）：默认 8192，0=关闭；旧「工具响应截断字数」不再注册/读取（旧存储值忽略）。已安装用户如需调整请在 WebUI 手动配置新键。
- \`compression\` 用途从模型配置与 \`.ai model\` 中移除；旧配置里的该用途会被自动忽略（日志 WARN），无需重建。

## 上下文：自动摘要改为每会话最多一次，预算到顶只归档

- **自动摘要额度**：每会话（context epoch）最多自动摘要 1 次；只有摘要成功才消耗额度，失败/空摘要/被单飞挡下不消耗，额度持久化在会话存档（重启不重置）；\`.ai ctx purge --yes\` 后重置。
- **额度用完后只归档**：编译发现预算装不下未摘要原文时，只把更早原文省略出请求（原文仍在事件账本，\`read_raw\`/\`grep_raw\`/\`resolve_context_ref\` 可回查），不再产生摘要 LLM 调用；手动 \`.ai ctx archive\` 不受额度限制。
- **context_too_long 恢复改为快速路径**：v2 事件账本下只把本轮请求预算收紧到 \`min(本地预算, 报文窗口) × 0.8\` 后直接重发，不再同步压缩/摘要；旧回退路径保持原行为。
- **自动/手动压缩共用同一运行时**：修复自动路径与 \`.ai ctx archive\` 各自 new 一个运行时导致两个单飞互不可见、同一批事件被重复摘要/重复计费的问题。
- **编译预算口径修复**：工具 schema 预留改为按 JSON 估算，请求预算按 \`TokenCalibration\` 校准系数折算；事件 token 估算统一为 \`estimateTextTokens\`（CJK≈1 token/字符，不再按 chars/3 低估约 3 倍），并修复最新单元超预算时 \`truncateUnit\` 的旧「3 字符/token」假设。
- **事件页大事件落盘**：单条事件独占一页时上限放宽到 256KB（多事件页仍 32KB）；超过上限的 tool_result 在写账本前截断并追加 \`[tool-result-truncated-for-storage: …]\` 标记，避免 flush 永久卡在失败页、重启后整批事件丢失。
- **\`.ai ctx\`**：status 增加自动摘要额度与「超预算内容不注入请求、原文可回查」说明；archive 帮助改为“手动整理…会花 LLM；自动摘要每会话最多 1 次”；删除 \`settle\` 别名。

## 配置项更改

- 删除「每小时后台压缩上限」：自动摘要改为每会话最多 1 次后不再需要（旧存储值升级后自动忽略，无需重建配置）。

## 开发与工程

- 新增 \`src/context/compact/session_runtime.ts\`（按会话共享压缩运行时）；删除 \`shouldCompact\`、\`forceCompactToTarget\`、\`ctxStats.summarization\`、\`DEFAULT_HOURLY_COMPACT_CAP\`、\`TOOL_RESULT_MAX_TOKENS_DEFAULT\` 等冗余。
- 单测：更新上下文运行时/服务/编译/日志/存储/命令/会话/桥接/入口用例，新增额度一次性/失败退还/持久化、context_too_long 快速路径、40KB 单事件页落盘、CJK 大单元截断等用例；\`npx tsc --noEmit\`、\`npm run lint\`、\`npm run test:unit\`（714）、\`npm run deps:check\`、\`npm run build && npm run smoke\`、\`npm run sim\`、\`npm run sim:matrix\`、\`npm run fuzz\`、\`npm run test:integration\`、\`npm run docs:manifest\` 全绿。

## 默认内容：角色/技能/知识库正文恢复中文

- 4.29.0 曾把默认角色「测试机器人」、默认技能「录卡」与三个内置知识库（\`核心指令\` / \`扩展指令\` / \`ob11-api\`）正文一并英文化；本版**改回中文**。系统提示词、工具描述、协议标记等非用户内容仍保持英文，机器人回复语言仍按对话语言。
- 默认角色/技能/知识库属于**用户内容**，保持原语言；配置生成器同步恢复中文默认。
- 影响：仅影响出厂默认/「恢复默认」内容。已安装用户存储不会自动回写（海豹无配置写回 API），需要中文默认的请在 WebUI 恢复默认或重新粘贴生成器输出；旧英文默认技能名可能仍留在存储里，恢复默认技能列表即可清理。
- 单测调整：能力地图/内置段英文断言排除角色、技能、知识库等用户内容段；默认角色/技能/知识库断言改回中文。

## 开发与工程

- 新增 token 截断叶子 \`src/utils/token_budget.ts\`；编译层 \`toolResultMaxTokens\` 与估算口径同源，避免"显示已截断但预算仍按全文计"。
- 单测新增/调整：编译期工具结果 token 截断（标记/图片保留/关闭/估算一致）、摘要输入不含工具正文、旧回退路径用户消息 token 截断、v5 旧配置 compression 清洗、子代理工具结果截断；\`npx tsc --noEmit\`、\`npm run lint\`、\`npm run test:unit\`、\`npm run build && npm run smoke\`、\`npm run sim\`、\`npm run deps:check\` 全绿。

## 触发域统一重构（R1：判定 shadow，行为不变）

- **统一触发域**：消息/事件/调度/延迟回调/判定五类入口收敛到同一张「闸 → 裁决 → 起轮」流水线；新增门控链规则（regex/event/active_time/timer 源门 + user/counter/prob 过滤门 + delay 时序门），AI 可用 \`set_trigger_rule\`/\`list_trigger_rules\`/\`delete_trigger_rule\` 管理，用户可用 \`.ai trg rule lst/rm/clr/set\` 查看/删除。
- **\`standby\` 概念删除**：会话开关统一为 \`aiEnabled\`（新会话默认关，\`.ai on\` 开启；旧存档 \`standby=true\` 自动迁移）；\`.ai standby\` 与 \`.ai off --sb\` 移除。\`Session.chat\` 返回 \`ChatOutcome\`（fired/deferred/bucket-empty/gated），未真正起轮不再扣精力/记 WAIT。
- **单触发模式统一为 8 个命令模式**（active/counter/delay/event/judge/prob/regex/timer；单字母别名 a/c/d/e/j/p/r/t，p 与旧 private 通过别名用途域隔离）：新增 **@ 触发**，但按作者要求做成**触发页配置开关「被@触发」**（默认开，群聊中有人 @ 机器人即触发，私聊不触发；替代默认正则里的 at CQ），**不进入 \`.ai trg\` 命令**（\`.ai trg at\` 不存在）；\`.ai trg\` 总览与开关、\`.ai trg all off\`。
- **触发页 12 键（顺序）**：\`被@触发(开关，默认开，第一项) / 触发需要满足的条件 / 触发次数上限 / 触发次数补充间隔 / 触发活跃时间(Template 多段) / 默认计数器 / 默认计时器 / 事件触发规则 / 评分触发参数(String TOML v2) / 默认概率 / 触发正则表达式 / 默认定时器(Template，每框一个 TimerSpec TOML，多框=多个定时器)\`；旧 \`默认触发活跃时间\`/\`评分触发配置\` 废弃且**旧值不迁移**。
- **判定内核 R1 shadow**：\`评分触发参数\` 升级 TOML v2（9 段全参数化，空/非法⇒判定不可用并报错）；新判定内核（六维特征 → prompt → parse → 策略 \`S\`）默认 \`shadow=true\` **只记日志、不改变发言**；\`.ai status\` 可看最近 shadow 决策与判定预算，供 2~4 周灰度定阈值。
- **定时器参数统一**：\`set_timer\` / 全局「默认定时器」/ 链 \`timer\` 门共用一套参数与 \`validateTimerSpec\`（\`prompts\` 1~10 必填；target 必填年/月/日；修掉旧 target 缺省年份的 1900 年 bug）；\`TimerManager\` 支持规则/模式条目（\`ruleId/modeTag/prompts\`）、双向端口分派与启动对账；\`.ai trg timer lst/clr\`。
- **事件域**：链事件规则独立于「事件触发规则」开关（只需录制门），v1 规则保留兼容；事件认领去重防「链 + v1」双触发。
- **辅助适配层**：图床/资源/内置记忆工具统一走 \`aux_tools\` 端口与三段注入（图床提示/资源清单按 snippet 派生），摘要辅助智能体工具循环（默认关）。
- **观测**：\`.ai status\` 新增触发域观测（规则数/损坏数、delay 挂起、去抖/在飞、判定配置有效性、预算、WAIT 剩余、最近 shadow 决策）。
- 兼容：\`set_trigger_condition\` 旧版一次性条件继续可用；v1 事件规则配置契约不变；外部插件 API 不受总闸影响（\`bypassGate\`）。
- 单测/门禁：新增触发域纯逻辑、链编排、规则工具、判定配置 v2、判定调度、探针、ChatOutcome 等用例（\`npm run test:unit\` 833）；\`npx tsc --noEmit\`、\`npm run lint\`、\`npm run deps:check\`、\`npm run test:integration\`（260）、\`npm run build && npm run smoke\` 全绿。

## 触发域统一重构（R2：判定切流 / 治理启用 / token 范围化）

- **判定切流（重要）**：\`[decision] shadow\` 默认值 \`true\` → **\`false\`**。新判定内核（六维特征 → 单次 LLM → 归一化分 \`S\`/decision → 策略层）直接驱动 SPEAK/WAIT/IGNORE；旧五维动作路径只在 \`shadow=true\` 时保留一版，可配置回滚。切流后判定时机与成本与 R1 不同：新增零 LLM 预筛、IGNORE 短冷却、调用令牌桶（默认 30 次/小时、burst 5）与最短调用间隔。
- **治理启用**：消息判定改为「先落盘 → 去抖 4~12 秒评估」（Addressed/强求助立即评估）；同会话在飞去重、在飞期间仅合并保留最新候选、WAIT 轮内候选轮末合并、\`.ai off\`/\`.ai stop\` 清理；\`.ai status\` 里的「去抖/在飞」现在真实生效。静默探针仍默认关。
- **精力记账修复**：评分触发 SPEAK 只有 \`Session.chat\` 返回 \`fired\`（真正起轮）才扣精力；\`bucket-empty\`/\`deferred\`/\`gated\` 不再出现「假 SPEAK 扣精力」。
- **token 范围化（A/B 组）**：新增 \`selectByTokenBudget\` 纯函数；\`[model] context_tokens\` 成为 judge 历史唯一口径（删除条数口径 \`context_count\`，0 = 不注入历史，旧值忽略并 WARN）；\`pub_read\` 参数 \`rounds\`/\`chars\` → \`tokens\`（默认 3000、上限 8000；旧参数接受但 WARN 并忽略一版）；上下文投影改 \`maxTokens: 6000\`（最新单元必留）；记忆桥、\`resolve_context\` 参数（\`max_chars\` → \`max_tokens\`）、子代理内容截断等字符口径统一改 token 预算；白名单（\`read_raw\`/\`grep_raw\` 分页、图片张数、工具轮数、记忆事实条数、legacy 归档字符窗口）保持不变并在文档标注。
- **τ/主动度校准**：R1 发布后未进入真机 shadow 灰度（无 \`[judge-shadow]\` 样本），本版用 14 条标注场景做离线校准（阈值扫描 0.40~0.80）：τ∈[0.53,0.60] 均可保持 SPEAK precision=1，默认保持 \`speak_threshold=0.55\`、\`aggressiveness=2\`；上线后建议继续收集 \`[judge-shadow]\`/\`[judge-decision]\` 日志复核。
- **生成器同步**：judge 用途标签改「评分 / 决策（判定）」并新增选型提示（vendor/价格档/structured_output/thinking，只提示不预选）；可选「判定请求体预设」（默认关，独立 \`groups[]\`：temperature 0 / max_tokens 300 / json_object）；MCP 新增 \`capability: "image-host"\` 扩展字段（旧 \`imageRefs\` 兼容一版），默认数据同步。
- 单测：新增/调整判定切流分支（SPEAK/WAIT/IGNORE、仅 fired 扣精力、预筛、调用预算、IGNORE 冷却绕过）、去抖延迟增长/封顶/旁路、在飞合并、token 选择与各调用点 token 口径；全量门禁见 PR。
`;
