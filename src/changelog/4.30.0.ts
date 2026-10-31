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
- **彻底移除 \`compression\` 模型用途**：\`ChatModelUse\` / v5 \`MODEL_USES\` / 出厂 \`purposes\` / \`.ai model\` 用途列表 / 用量页说明都不再有 compression；\`chat\` / \`summarization\` / \`judge\` 仍共用文本/视觉候选链。
- **旧模型配置自动兼容**：解析期自动剔除 \`purposes.compression\` 并打 WARN；**无需重建配置**。配置生成器同步移除该用途，导入旧配置时同样清洗并提示。
- 历史 token 用量里的 compression 记录保留可查，不再新增。

## 模型配置：groups 移除与逐模型按用途请求体

- **移除 \`groups[]\`**：v5 顶层不再有用途组请求体；旧配置里的 groups 解析期忽略并 WARN，不迁移。
- **请求体覆盖改为逐模型按用途**：\`providers[].models[].request.bodyByUse\`（用途 → 请求体，优先级高于代码默认）；配置生成器在连接编辑里每个模型可添加 N 条「用途 → 请求体」，默认 0 条 = 用插件默认。
- **插件默认请求体**：对话/总结/评分/识图默认 \`{"max_tokens": 65536, "temperature": 1}\`（嵌入与媒体不变），**原样发送**；超过模型上限由服务商拒绝（用户自担）。\`decision\` 模型不允许 \`bodyByUse\`（请求体由内置 System One 适配器生成）。
- **生成器同步**：删除「判定请求体预设」与主界面「用途组请求体」；新增条目预填 \`{"max_tokens":65536,"temperature":1}\`；MCP 新增 \`capability: "image-host"\` 扩展字段（旧 \`imageRefs\` 兼容一版）。

## 判定（评分触发）现行行为

- **模型只输出六维分数**：judge 的模型输出六维 0~10 分（\`dims\`），直接乘权重后归一化 \`S\`（默认阈值 0.6，0~1 可配；\`aggressiveness\` 1~3 微调有效阈值）；不再输出 \`decision\`/\`confidence\`/\`reason\`/\`evidence\`，SPEAK/WAIT 由策略层阈值决定。
- **新增模型 kind \`decision\`（System One）**：阿里 \`decision-model-preview\` / Jev \`jev-latest\`，只能绑 \`judge\`，请求固定 \`POST {baseURL}/systemone\`（Bearer 鉴权），响应 \`answers\` 归一化回六维；与普通 chat 模型共用 \`judge\` 用途（同一用途可替换模型，不拆用途），judge 在 chat/decision 两种后端间自动选择。
- **判定时序**：消息到达立即评分；结果为 WAIT 或回复成功后进入 30s WAIT（\`[scoring] wait_cooldown\`，0 = 不进入 WAIT），期间只挂起最新一条，WAIT 到点才评挂起消息，无 pending 不调模型。
- **移除的旧机制**：shadow/旧五维动作路径、IGNORE、预筛、调用预算、精力、活跃时间/计时器挂起/会话忙/密度闸门、静默探针与 4~12s 去抖全部删除；旧 TOML 的 \`[energy]\`/\`[features]\`/\`[gate]\`/\`[probe]\`/shadow/ignore_* 按未知键忽略（不报错、不迁移）。
- **判定配置与状态**：范围校验（负值/越界拒绝，\`timeout_sec\` 必须 >0，\`speak_threshold\` 0~1，\`wait_cooldown\` ≥0）；新增会话判定 generation——\`.ai off\`/\`.ai stop\`/\`judge off\`/LRU 淘汰后，在飞判定返回直接丢弃；候选消息按 600 token 截断注入；\`.ai trg judge off\`/\`all off\` 同步清理 WAIT/调度状态。
- **τ/主动度校准**：本版用 14 条标注场景做离线校准（阈值扫描 0.40~0.80）：τ∈[0.53,0.60] 均可保持 SPEAK precision=1，默认 \`speak_threshold=0.6\`、\`aggressiveness=2\`。
- 单测：新增会话判定 generation、六维直出解析/合并、System One 归一化、WAIT 时序、配置范围校验等用例；全量门禁见 PR。

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

## 触发域统一重构

- **统一触发域**：消息/事件/调度/延迟回调/判定五类入口收敛到同一张「闸 → 裁决 → 起轮」流水线；新增门控链规则（regex/event/active_time/timer 源门 + user/counter/prob 过滤门 + delay 时序门），AI 可用 \`set_trigger_rule\`/\`list_trigger_rules\`/\`delete_trigger_rule\` 管理，用户可用 \`.ai trg rule lst/rm/clr/set\` 查看/删除。
- **\`standby\` 概念删除**：会话开关统一为 \`aiEnabled\`（新会话默认关，\`.ai on\` 开启；旧存档 \`standby=true\` 自动迁移，并修复迁移在 revive 之后读取导致失效的问题）；\`.ai standby\` 与 \`.ai off --sb\` 移除。\`Session.chat\` 返回 \`ChatOutcome\`（fired/deferred/bucket-empty/gated），未真正起轮不再扣精力/记 WAIT。
- **单触发模式统一为 8 个命令模式**（active/counter/delay/event/judge/prob/regex/timer；单字母别名 a/c/d/e/j/p/r/t，p 与旧 private 通过别名用途域隔离）：新增 **@ 触发**，按作者要求做成**触发页配置开关「被@触发」**（默认开，群聊中有人 @ 机器人即触发，私聊不触发；替代默认正则里的 at CQ），**不进入 \`.ai trg\` 命令**（\`.ai trg at\` 不存在）；\`.ai trg\` 总览与开关、\`.ai trg all off\`。
- **触发页 12 键（顺序）**：\`被@触发(开关，默认开，第一项) / 触发需要满足的条件 / 触发次数上限 / 触发次数补充间隔 / 触发活跃时间(Template 多段) / 默认计数器 / 默认计时器 / 事件触发规则 / 评分触发参数(String TOML v2) / 默认概率 / 触发正则表达式 / 默认定时器(Template，每框一个 TimerSpec TOML，多框=多个定时器)\`；旧 \`默认触发活跃时间\`/\`评分触发配置\` 废弃且**旧值不迁移**。
- **定时器参数统一**：\`set_timer\` / 全局「默认定时器」/ 链 \`timer\` 门共用一套参数与 \`validateTimerSpec\`（\`prompts\` 1~10 必填；target 必填年/月/日；修掉旧 target 缺省年份的 1900 年 bug）；\`TimerManager\` 支持规则/模式条目（\`ruleId/modeTag/prompts\`）、双向端口分派与启动对账；\`.ai trg timer lst/clr\`；删除顶层 \`.ai timer\`（手动定时器工具与视图保留）。
- **事件域**：链事件规则独立于「事件触发规则」开关（只需录制门），v1 规则保留兼容；事件入口先 claim 再求值（no-match 释放）防「链 + v1」双触发 TOCTOU；链 event 规则空闲时异步起轮（\`detached\`，不再 await 整轮 AI 阻塞 ob11 通知/请求分发），会话忙时挂起 \`kind:'trigger'\`，轮末补一轮。
- **忙时强触发挂起**：运行中收到的消息先做链规则/@/正则/AI 一次性条件的轻量判定，命中则 defer 为 trigger；计数器/概率/延迟/评分仍不推进。恢复时二次判闸，\`.ai off\` 期间不写 trigger 提示。
- **wake 先判闸/判桶再写提示**：gated/bucket-empty 不再留下无法兑现的 system 提示；\`.ai off\` 期间规则/模式 timer 不再持续污染上下文。
- **\`.ai off\` 清理矩阵**：补齐规则/模式 timer 条目移除、activeMode/activeTime 清理、judge WAIT/调度清理；\`.ai on\` 按模式开关重建 active/timer/规则 timer。
- **GLOBAL_STANDBY 语义**：录制闸与触发闸分离；全局待机只记录、不触发任何模式（配置文案同步）。
- **timer 模式修复**：重载恢复不再用 \`sessionId\` 兜底 epId（避免首轮点火自删）；多个「默认定时器」框共用 ruleId 时改为精确续期，不再互相删除；\`.ai on\`/会话入口幂等补注册规则 timer；target 型超时 1 小时丢弃；默认定时器解析不再做模块级缓存（target 绝对时间按当前时间重算）。
- **delay 与事件认领**：delay 到期续算复核 scope/过期/次数；到期遇忙 3s×5 退避重试。
- **存储与观测**：规则库主键损坏回退 \`:bak\`，坏规则随主库保留不再被下次写入删除；state 分片无变化不写（计数/fired 仍写穿）；WAIT 轮末重放标记 \`source:'wait'\`，不再重复记时间线；\`show_timer_list\`/\`cancel_timer\`/\`.ai trg timer clr\` 隔离手动定时器；\`.ai status\` 新增触发域与判定观测（规则数/损坏数、delay 挂起、评分在飞/排队、WAIT 剩余、最近一次决策的 action/S/后端/来源）。
- **active_time 源门补齐自主调度**：规则创建/\`.ai on\`/会话入口按 \`start/end/segs\` 排下一子段起点，到点走 \`runChain(sourceSatisfied)\`；每段最多 1 次（occurrence 持久去重，重载/重复投递不重复），跨天自动续排。
- **命令输出窄屏友好**：\`.ai status\`（判定在飞/排队）、\`.ai trg\`（总览/模式详情/规则列表/定时器列表）、\`.ai live\`、\`.ai pub add\` 原先把多个字段用「｜」/「|」挤在同一行，现改为逐字段换行；规则与定时器每条一个块、块间空行，手机窄屏更易读（字段语义不变）。
- **权限与文档**：全局链规则删除/改写仅骰主；同步 README/docs（触发页/全局待机/命令语义/定时器命令调整/评分触发参数默认模板）。
- 单测：新增迁移、wake 闸门、手动/规则 timer 隔离、多计划精确续期、规则 timer 补注册、链规则 parked、规则库备份/坏规则保留等用例（\`npm run test:unit\` 848）；\`tsc/lint/deps/build/smoke\` 全绿。
`;
