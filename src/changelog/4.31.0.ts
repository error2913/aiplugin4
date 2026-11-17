// 版本更新日志（数据文件）：4.31.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
// 由 scripts/gen-changelog.mjs 迁移/校验；修改正文后运行 npm run changelog:gen 更新聚合索引。
export default `## 前缀缓存稳定性（#163）

前缀缓存（context caching）按请求体的**字节前缀**命中：请求体只要在最前面某个位置被改写，该位置之后全部重新计费。本版把"会随轮次漂移的字节"系统性赶出稳定前缀。三条不变量：**未归档内容必须严格前缀扩展**（第 k 轮请求体是第 k+1 轮的前缀）、**同一快照编译两次字节相同**、**只有显式记账的重建点才允许前缀断裂**。

- **历史消息不再带 \`[msg_id]\` / \`[time]\`**：这两个标记原本按"本轮还剩多少预算"从最新往回分级，窗口一晃边界就平移，已发送区中间的字节被改写 —— 一次抖动废掉半个请求体的缓存。现在历史一律不带；模型定位历史用 \`grep_raw\`（内容搜索）→ \`read_raw\`（按 \`e:<seq>\` 读原文），都不依赖标记。旧会话不需要迁移。唯一保留时间标签的是**系统事件**（唤醒/通知等框架事件带 \`[time:<时间>]\`）：那是事件写入时就冻结的值，不随轮次变，且模型需要它判断"距上次隔了多久"。
- **\`[from:<名字>(<号码>)]\` 改为写入时冻结**：消息入库那一刻取一次显示名并随事件落盘，之后用户改名、改群名片不再改写已发送历史（旧数据没有冻结字段时回落当前名字，不回填历史页）。
- **引用回复带 \`[quote_of:<消息ID>]\`**：被引消息展开为独立消息写入上下文，回复消息前带被引 ID，模型可直接用 \`read_raw\` / \`resolve_context_ref\` 回查原文，不必猜"引用的是哪句"。
- **当前时间 / 长期记忆 / MCP 服务器说明改为「增量注入块」**：三者原本每轮重新生成、作为 \`[system:runtime]\` 尾块塞在请求体末尾（时间戳必然每轮变，记忆清单也可能变）。现在改为编译成 \`[system:inject-<kind>]\` 块，**只在内容变化时追加到历史尾部**，稳定前缀（身份/角色/工具 schema/已发送历史）逐轮字节不变。时间改由新增的 \`get_time\` 工具与系统事件自带时间承担。
- **工具 schema 恒定**：原生 function calling 只暴露三个元工具（\`list_tools\` / \`search_tools\` / \`call_tool\`），不再随会话工具开关、会话类型、平台变化。工具是否可用改由执行期判定并返回 \`not_found\` / \`not_enabled\` / \`platform\` / \`session_type\` 四类失败码。
- **历史全量渲染**：删除"按本轮预算从最新往回挑一部分单元"的选择器。原实现下预算降一点就会从历史中间丢一条消息，已发送区随即被改写；现在可见历史全部渲染，预算不够交给归档。
- **归档是唯一的前缀重建点**：硬切/总结归档把水位往前推，是设计允许的重建；其它任何前缀变化都必须可归因并显式记账（见下一条）。请求超长（\`context_too_long\`）不再只是收紧预算重发，而是先零 LLM 硬切归档推进水位、再重发。
- **实际收益**：同一个会话连续提问时，system + 预设上下文 + 工具 schema + 已发送历史这一整段全部命中缓存；对话越长、连续发言越密，省下的输入 token 与首字延迟越多。可用 \`.ai ctx\` 的「缓存：命中率」直接观察。

## \`.ai ctx\` 观测增强

- **新增四行状态**：\`前缀：稳定\` / \`前缀：已重建 N 次（最近原因：X）\`；\`注入：活动 N 块 / N token / 已释放 N 块\`；\`前缀守卫：上次校验通过\` / \`前缀守卫：首差异位置 N\` / \`前缀守卫：-\`（无编译统计时不谎报"通过"）；\`缓存：命中率 N%（近 N 轮）\` / \`缓存：命中率 -\`（本会话暂无数据）。
- **新增 \`.ai ctx debug\`**：切换前缀漂移探针（默认关闭、零成本）。开启后每轮比对上轮已发送区的消息哈希，状态里报告首个差异位置 —— 这是排查"缓存突然没命中"的入口。
- **前缀重建原因**（\`.ai ctx\` 里显示的那个 X，共 12 个）：\`archive\`（归档推进水位）、\`purge\`（\`.ai ctx purge --yes\` 清空）、\`edit\`（编辑/替换历史正文）、\`redact\`（\`.ai ctx hide\` 隐藏）、\`config:<键名>\`（改了会影响提示词的配置）、\`reload\`（重载 JS）、\`upgrade\`（版本升级）、\`tools\`（工具 schema 变化）、\`summary-stale\`（摘要区间被编辑污染）、\`inject-overflow\`（注入总量超过硬上限，触发归档腾位）、\`prefix-drift-freeze\`（冻结守卫发现已发送前缀被改写，用上轮快照覆盖回去并记账；正常情况不出现）、\`epoch\`（重置纪元，当前仅测试路径产生，留作后续 repair 复用）。
- **不跳注**：注入块在预算紧张时**先归档腾位**再写入，不会因为"这轮装不下"就跳过；只有"内容已在活动块里"才不重复写。
- **\`.ai status\` 同步展示缓存率**：在「上下文轮数」后新增一行 \`缓存率: 73.5%（近 8 轮）\`，与 \`.ai ctx\` 的「缓存」行**同一份实现、同一口径**（新增叶子 \`src/utils/cache_rate.ts\`；本会话主对话近 100 轮，只算 \`prompt_tokens > 0\` 的成功请求，不含子代理 / 评分 / 辅助模型请求）。无样本时显示 \`-（本会话暂无数据）\`，不会用 \`0.0%\` 冒充；与 \`.ai prompt sections\` 的 \`cache\` 列（本地段级缓存，30s TTL）无关。纯只读：不写存储、不改会话状态、不触发编译/归档。顺带收紧两处畸形输入的展示：\`prompt\` 为 0 时不再显示 \`0.0%\` / \`700.0%\` 而显示 \`-\`，\`read > prompt\` 时夹紧为 \`100.0%\`。

## \`.ai status\` 精简

- **模型区只留模型名**：删掉「模型连接」行（连接条数/可用/失败 + 每条连接的 \`provider · baseUrl · 自动|钉住 · N 个模型\`）。连接与模型列表改看 \`.ai model\` / \`.ai model list\`（骰主）。顺带不再向该命令的可见人群（\`.ai status\` 是 \`U\` 级，群里任何人可发）展示后端地址。
- **标签去括号**：\`AI 总闸(aiEnabled)\` → \`AI 总闸\`，与 \`.ai trg\` 总览口径一致。
- **删「活跃时间段(旧)」行**：那是 4.30.0 之前的单段活跃时间（旧版 \`.ai on --a=09:00-18:00-5\` 写入的 \`activeTimeInfo\`）。4.30.0 起活跃时间只认触发页「触发活跃时间」多段配置，本字段**已没有任何代码路径写入非零值**（\`.ai off\` 仍会把它重置为 0），对新会话恒为「未设置」。**旧存档的该字段仍被兼容（定时器行为不变），无需迁移**。
- **删底部「触发域 / 判定」观测块**（规则数/损坏数、delay 挂起、评分在飞/排队、判定配置、WAIT 剩余、最近决策）：这些信息**没有等价的命令出口**。触发域与规则清单看 \`.ai trg\`（\`.ai trg rule lst\` / \`.ai trg timer lst\`）、会话运行与请求排队看 \`.ai live\`（口径是请求限流，不是判定调度），判定决策看日志 \`[judge-decision]\`、判定参数非法看 \`评分触发参数无效\`（5 分钟节流）；**规则损坏条数看日志 \`规则库有 N 条校验失败\` 或存储键 \`aitrig:rules:bad\`**。顺带 \`.ai status\` 变成更纯的只读：不再触发规则库首次加载。
- **输出行数**：29 行 → **17 行**；字段缩进与「一行一字段」窄屏契约不变。

## 用量限制：三窗口预算、峰时百分比与只统计模式

- **新增「用量限制」配置页（12 键，默认关闭）**：5 小时 / 自然周 / 自然月三窗口对话 token 上限，\`0\`=不限；会话/个人/四个辅助用途按**有效总预算**（= 总限制 × 时段百分比）折算百分比；默认 200 万 / 1000 万 / 4000 万，百分比全 100。
- **峰时百分比**：「限制时段及百分比」每框 \`[周几 ]HH:mm-HH:mm-百分比\`（1=周一…7=周日，支持 \`1-5\`/\`1,3,5\`，跨 0 点按起始日，空=不收紧）；默认工作日 9-12、14-18 点 30%。
- **只统计不拦截**：总开关关闭时仍累计（可用 \`.ai tk quota\` 观察），开启后按预算拦截对话请求；超限提示每「会话×窗口×维度」最多一次，可关。
- **新增命令**：\`.ai tk quota\`、\`.ai tk me\`、\`.ai tk rank [5h|week|month] [n]\`（默认 Top10、n≤50）、\`.ai tk quota clear\`（清窗口计数、不清历史）；\`.ai tk use\` 追加当前窗口各用途用量/上限。
- **降级而非报错**：摘要/归档被拒走确定性降级、识图按文本标签、嵌入回退关键词检索、judge 保守不发言；用途请求不占对话总量，但全部用途合计以有效总预算兜底。
- **数据独立**：新存储键 \`quotaUsage\`（窗口实时状态，启用 5s / 关闭 60s 合并写，31 天裁剪），与 \`usageMap\`（历史报表）分离，数字不一致属预期。

## 图片 URL→base64 改为插件直连（移除 image-url-to-base64 后端）

- **移除 \`image-url-to-base64\` 后端**（配置格式未变）。图片 URL 转 base64 现在由插件自己下载完成：\`fetch\` 拿到原始字节串后一次性交给 \`btoa\`，**字节无损**，不再需要外部转码服务。老配置里残留的该条目**不再注册、不再读取**（按未知后端名忽略，流程与其它未知后端名一致），可自行删除；不影响其它后端。
- **不需要额外升级海豹**：全局 \`btoa\` 自海豹 v1.2 起就有（\`sealpack/info.toml\` 的 \`min_version\` 本就是 1.6.0，本次未提高门槛）。
- 新增直连兜底：未配图床、或图床熔断/失败时，插件直接下载图片；识图、工具/外部消息、QQ 发送等路径可用它兜底（主对话 v2 compile 仍沿用稳定 URL）。
- 图床新增 60s 熔断：图床网络错误/5xx 后短时间内不再尝试，直接走直连，避免每张图白等一次超时（\`/api/health\` 探测与清理对账不受影响，但控制面失败会续期熔断）。
- 下载补齐：跟随重定向（≤3 次）、30s 超时、20MB 上限、2 并发上限；HTTP 404/403 等 4xx 判为 URL 永久失效，408/425/429/5xx 仍可重试；**200 但响应不是图片（HTML/JSON/WAF 页）按可重试失败处理**（不判 URL 死链）。
- **超时不再立刻归还并发槽位**：goja 没有 \`AbortController\`，\`withDeadline\` 超时只让调用方不再等待，底层 HTTP 可能仍在跑并持有 body。若此刻就还槽，"20MB × 2 并发"的内存上界不成立。现在超时把槽位**移交**给底层请求（它 settle 才归还），另设 \`2×超时\`（上限 60s）宽限强制回收并 warning —— 避免极端情况下下载能力被永久吃掉 2 个槽。
- 文档修正：\`text()\` 并非「UTF-8 解码破坏二进制」，真正的问题是**派生字符串**（拼接/切片/JSON 化）会触发 UTF-8 扫描；整体传给 \`btoa\` 是安全的。
- **回滚提示**：配置格式未变，可直接回退 4.30.1；回退后旧版会重新请求 46678——想保留回滚能力请先别卸载该后端（已卸载则转 base64 失败，图片按 1 小时冷却/连续 3 次放弃降级为文本标签，不丢数据）。

## OB11 核心桥改为独立协议端（插件侧适配）

配套后端 \`ob11-core-bridge\` 升级到 3.0.0：形态从"relay 中转站"变成**纯粹的独立 OB11 协议端**——海豹用一条普通的 OB11 正向 WS 连上桥，就得到一个稳定持久的虚拟账号世界，23 个 OB11 action 全部本地应答。桥**不拦截、不注入、不出站**：没有任何出站连接，也没有"协议端地址"可填。插件侧本版做了对应适配，老桥照常可用：

- **新增 \`hello\` 握手**（\`src/integration/core_bridge/ws_client.ts\`）：连上 \`/plugin\` 后立即发 \`{type:'hello', requestId}\`，缓存桥回的 \`mode\`/\`platform\`/\`corePort\`/\`virtualSelfId\`/\`virtualNickname\`/\`capabilities\`/\`bridgeVersion\`。超时 3 秒、与 \`core_command\` 的 10 秒超时解耦（不进 pending 队列），失败只降级不报错——**老桥（无 \`hello\` 应答）行为完全不变**。
- **\`core_command\` 增发 \`source\`**（\`tool_core_command.ts\`）：\`mode=standalone\` 时 payload 额外带 \`source{endpointId, messageType, groupId, userId, groupName, userRole}\`（**真实** ID，只作桥侧投影输入），由桥换成虚拟 ID；\`mode\` 缺失或非 \`standalone\`（老桥）时报文与 1.1.x 完全一致。\`mode\` 现在是桥侧的**恒定值**，不再是用户可配的运行模式。
- **\`actor.role\` 真实化**（\`command_target.ts\` 的 \`commandActorRole\`）：原先硬编码 \`'member'\`，导致 owner 专属指令（\`.dismiss\` 等）永远不可用。现在按 \`ctx.privilegeLevel\` 映射（\`>=60\` → \`owner\`，含骰主 100 / 白名单 70 / 群主 60；\`>=50\` → \`admin\`；否则 \`member\`），核心侧 \`fillPrivilege\` 据此上权限。
- **结果字段只增不改**（\`types.ts\` / 结果渲染）：新增可选 \`mode\`、\`deliveredCount\`、\`virtualTarget\`。\`ambiguous\` 恒 \`false\`、\`forwardedCount\` 与 \`interceptedCount\` 恒 \`0\`（"转发到协议端"与"从协议端拦截"这两件事都随真实协议端一起消失，真实条数统一看 \`deliveredCount\`），插件渲染改读 \`deliveredCount\`（缺失时按 \`messages.length\` 兜底）并**不再向 AI 展示 ambiguous/completedBy 这类干扰信息**。顺带删掉从未使用的 \`CoreBridgeInvocation\` 类型。
- **行为边界（写进文档，避免误判）**：桥**没有真实投递**——核心指令的文本结果只回给 AI，不会真的发到 QQ；图片/语音/文件只有文本占位；一个桥只服务一个核心（第二条连接被 \`1013\` 拒绝）。想要真实 QQ 群请另接真协议端，桥不承担转发职责。
- **部署侧必做一步**：把虚拟号加进海豹 \`DiceMasters\`（条目形如 \`QQ:10001\`，取值看桥启动日志或 \`/healthz.virtualSelfId\`），否则 \`MasterCheck\` 永不命中、\`PrivilegeLevel\` 上不到 100。桥的 \`/healthz\` 现为 15 字段。
- **桥的配置只剩三项**：\`platform\` / \`virtual_self_id\` / \`virtual_nickname\`。删掉了「运行模式」「协议端地址/ token」「核心端 token / 插件端 token」「默认虚拟群 / 默认私聊对象 / 机器人角色 / 群人数上限」这些冗余项——群与私聊对象改为惰性生成（第一次见到真实 ID 才分号），角色与人数上限是协议常量。**token 只有一个**：就是启动器给每个后端注入的通用 token，海豹「连接」页与插件「核心桥Token」填同一个值即可（桥不再读 \`core_token\`/\`plugin_token\`）。
- **文档同步**：docs/04（工具系统）、docs/05（后端配置键说明）、docs/08（后端清单与 token 例外）、docs/09（捕获/转发语义与 token）、docs/11（全篇重写：端口为表述中心、核心端不占路径、三项配置、虚拟世界与骰主列表、\`/healthz\` 字段表、排障）、docs/README、README（配置/工具章节）。**两个易踩的坑已写进文档**：海豹面板「目标地址」必须带 \`ws://\`（只填端口会静默 \`connect_fail\`，但**路径不用写**——桥把除 \`/plugin\`、\`/healthz\` 外的一切连接都当核心端），插件 \`backends.ob11-core-bridge.url\` 则必须是**完整 URL**（它连的是 \`/plugin\`，桥的端口在启动器里改，默认 \`46880\`）。

### 新增测试入口

- \`scripts/unit-test-core-bridge.ts\`：\`hello\` 握手三分支（standalone / 老桥无应答 / 超时降级）、\`source\` 投影条件、\`commandActorRole\` 三档映射、结果字段缺失兜底等 12 条用例，登记在 \`npm run test:unit\` 的 coreBridge 域。

## 开发与工程

- **新增模块**：\`src/context/injections.ts\`（注入块载体与纯函数：\`splitInjections\`/\`activeInjectTokens\`/\`releaseBoundaryOf\`/\`slot\`/\`compareBlocks\`）、\`src/context/injection_dedup.ts\`（\`new\`/\`dup\`/\`dup-text\`/\`updated\`/\`re-inject\` 五类判定）、\`src/context/injection_writer.ts\`（收集→合并→去重→三层额度→预算闸→先归档后写块的唯一写入口）、\`src/context/injection_plan.ts\`（每轮规划入口，L3）、\`src/prompt/injection_registry.ts\` + \`src/prompt/injections/\`（\`core:time\`/\`core:memory\`/\`core:mcp\` 三个内置 provider 与键/哈希工具）、\`src/core/prefix_boot.ts\`（L0，引导期前缀重建归因：\`upgrade\`/\`tools\`/\`reload\`）、\`src/session/quote.ts\`（引用展开）、\`src/utils/cache_rate.ts\`（缓存命中率格式化叶子，零 import 的纯函数，\`.ai ctx\` 与 \`.ai status\` 共用同一口径）、\`src/quota/\`（L2，用量限制：\`types\`/\`window\`/\`store\`/\`manager\`）与 \`src/config/configs/quota.ts\`。
- **新增脚本**：\`scripts/check-prefix-purity.mjs\` + \`npm run lint:prefix\`（宽松：报告可疑点）/ \`npm run lint:prefix:strict\`（CI：白名单失效也算失败）/ \`npm run lint:prefix:selftest\`（自测守卫本身：每条规则喂坏样本必红、白名单上下文锚外的同形代码必红、陈旧白名单可检出）。扫描 \`src/context/view\` 与 \`src/utils/message.ts\`，禁止在请求体渲染路径上出现 \`Date.now()\`、\`new Date()\`、\`performance.now()\`、活读会话/用户状态、模板拼接动态段等前缀污染源。CI 的 \`_check.yml\` 已接入 strict 模式。\`scripts/lib/deps.mjs\` 补 \`src/quota/\` 的 L2 规则。
- **新增测试入口**：\`scripts/unit-test-prefix-obs.ts\`（rebase 记账/白名单原因/缓存窗口滚动/漂移探针/注入块状态视图/\`config:<key>\` 指纹基线语义）、\`scripts/unit-test-time-inject.ts\`（时间注入格式与偏移换算）、\`scripts/unit-test-quote.ts\`（引用 ID 解析口径）、\`scripts/unit-test-injection-providers.ts\`（注入预算三值与 provider 行为）、\`scripts/unit-test-injection-contract.ts\`（渲染位置/去重判定/索引 memo/释放 token 扣减/写块顺序的纯函数契约）、\`scripts/unit-test-injection-plan.ts\`（每轮接线层：四种早退/写块/稳态零注入/provider 异常分流）、\`scripts/unit-test-archive-tools.ts\`（工具面恒定逐字节相等 / 归档注入口径 / \`L\` 单一实现）、\`scripts/unit-test-quota.ts\`（三窗口预算/峰时百分比/只统计与拦截/降级路径）。
- **新增工具**：\`get_time\`（返回当前时间，含时区偏移；工具组 Timers）—— 历史消息不再带 \`[time]\` 后，模型需要"现在几点"时用它，也可用于算时间间隔。原生 function calling 下它仍通过元工具（\`list_tools\`/\`search_tools\`/\`call_tool\`）发现与调用，不进 \`tools\` 数组，所以不破坏工具 schema 恒定性。
- **新增常量**：\`src/utils/context_limits.ts\` 的 \`HISTORY_EVENT_MAX_TOKENS\`（单条历史事件固定展示上限 8192 token，不随窗口比例变化）与 \`INJECT_ACTIVE_WINDOW_TOKENS\`/\`INJECT_PER_TURN_MAX_TOKENS\`/\`INJECT_COLD_START_MAX_TOKENS\`/\`INJECT_ACTIVE_MAX_TOKENS\`（注入三层额度）；\`TAG_ANCHOR_GAP_SEC\`/\`TAG_ANCHOR_EVERY_MESSAGES\` 随标签分级一起删除。
- **层归属**：\`prefix_boot.ts\` 必须放 L0 —— 读者是 \`utils/message.ts\`（L2）与 \`index.ts\`（L4），放 \`session/\`（L3）会造出 L2 → L3 的反向依赖，\`npm run deps:check\` 会拒绝。
- **验收口径修正**：\`npm run sim\` 的「session 体积与消息总量解耦」原来比两个**瞬时** blob，而 blob 实际是**锯齿**（窗口移出成批砍掉最旧一段），采样点落在齿谷还是齿峰纯看运气。本版历史每条约短 20 字（\`[time]\` 去掉）⇒ 窗口塞进约 3 倍条目，恰好第二批采到齿峰，断言假红。现在改成全程记**峰值**再比（峰值口径对锯齿免疫），两版都是平的。
- **单测基础设施重构**：\`npm run test:unit\` 从 **75s 降到 ~20s**（≈3.8×）。改为「一次 esbuild 多入口构建 → 一次性加载 → 显式 \`process.exit\`」：原实现 54 个入口逐个 \`build\`+\`require\` 交错执行，实测把 \`require\` 拖慢近 10 倍（load 37.7s → 2.8s），且 src 残留的定时器句柄让进程空等 26s。顺带清掉 81 个已被正则永久跳过的僵尸用例，把 14k 行的 \`scripts/unit-test-entry.ts\` 按域拆成 10 个 \`unit-test-*.ts\`（共享前置抽到 \`unit-test-helpers.ts\`），拆分前后用例集合逐字一致；本版另补 #163 注入块与用量限制、核心桥等新入口，发布时全量为 **64 入口 / 1108 例**。
- **单测顺序无关性**：新增 \`UNIT_ORDER\`（\`reverse\`/\`shuffle:<seed>\`/\`files-reverse\`/\`files-shuffle:<seed>\`/\`inner-reverse\`）、\`UNIT_FILES\`、\`UNIT_TESTS\`、\`UNIT_ORDER_LOG\` 等巡检开关，并修掉 11 处跨文件/文件内全局状态污染（\`TokenCalibration.resetAllForTest\`、\`resetBtoaWarnForTest\`、\`getAgentResolver\`、\`getAuxLlmImpl\`、\`Config.registerConfig\` 幂等、\`Tool.getNativeRequestTools\` 空结果不缓存等），现在任意文件顺序、任意用例顺序全部绿。
- **修掉一处注入静默失效**：\`injection_dedup\` 的活动索引 memo 键只含「块数 / 最大 seq / 释放水位」，不含会话身份 ⇒ 两个会话这三项恰好相同时会串用索引，后一个会话的新条目被判 \`dup\` 而**不注入**（并发两个群同时说话时真实可达）。现在把调用方 \`ContextService\` 一并纳入命中条件。
- **释放判定修正为严格小于**（\`isReleased\`）：块锚点 \`afterSeq = A\` 的语义是「插在 \`seq ≤ A\` 的单元之后」，水位推进到正好 \`A\` 时可见区从 \`A+1\` 起，块仍落在可见区最前面 —— 有效。初版误用 \`afterSeq ≤ 水位\`，撞上两个**必然**边界（预算闸归档后新块锚点恒等于归档水位、新会话/每次重载首轮锚点与水位同为 0）⇒ 注入块"写完即判已释放"，模型整轮看不到记忆/时间/说明（且 \`.ai ctx\` 显示「活动 0 块」，看不出是丢了）。\`releasedInjectTokens\` 的扣减区间同步改为「\`before ≤ 锚点 < after\`」，两处口径一致。
- **修复子命令短别名在权限链中失效**（\`.ai tk/memo/md/priv\` 被当作未知命令）：\`resolveCmdChain\` 第 1 段改按命令表归一。
- **单测分域与增量**：\`npm run test:unit\` 新增 \`--domain=<域>\`（15 个域，见 runner 内 \`DOMAINS\` 表；新增入口不归域会启动即报错）、\`--changed[=<ref>]\`、\`--only\`、\`--list\`，并配 \`test:unit:list\` / \`test:unit:changed\` / \`test:unit:only\` 三个脚本。影响面不是手写表，而是从 esbuild metafile 抽「每个产物实际内联了哪些 \`src/\` 文件」（缓存在 \`node_modules/.cache\`，按 \`git diff\` 判失效）。实测内循环：改 1 个测试文件 0.5s、\`--domain=context --only\` 2.1s、\`--domain=media --only\` 4.0s，全量约 20s；CI 口径不变，仍是全量（当前 64 入口 / 1108 例）。
- **文档同步**：docs/02（Prompt 组装与上下文构建）、docs/03（上下文 / 智能体 / 提示词）、docs/05（\`.ai ctx\` 子命令与用量限制命令）、docs/06（quotaUsage 存储键）、docs/13（记忆增量注入）、docs/README、AGENT.md（工程约定与检查清单）、README（上下文与提示词章节、\`.ai ctx\`、\`get_time\`、新增「用量限制」配置小节与 4 条命令）。

## 配置项更改

- 新增「用量限制」页 12 键，默认值：启用用量限制 \`false\`、5小时限制 \`2000000\`、一周限制 \`10000000\`、一个月限制 \`40000000\`、会话限制百分比 \`100\`、个人限制百分比 \`100\`、限制时段及百分比 \`["1-5 09:00-12:00-30","1-5 14:00-18:00-30"]\`、摘要/判定/识图/嵌入用途百分比各 \`100\`、超限提示 \`true\`。
- **默认关闭、升级不受影响**：开启前行为与 4.30.1 一致（只统计、不拦截、无提示）；既有 \`usageMap\` 与 \`.ai tk\` 既有输出不变（只追加）。本页不参与配置生成器（无 JSON 键），旧配置无需迁移。
- 除「用量限制」页外，本版无其它配置项增删，存储键与默认值原样生效，升级无需改配置。
- 两处**说明文案**更新（不影响取值，也不需要你动手）：「图片 → 图床提示注入」「资源 → 资源清单注入」的说明改为"只控制该段是否注入"，并明确与后端图床/MCP 是否连接无关 —— 段内容已常量化（不再渲染图库数量、最近宿主 ID、\`resource:<name>\` 清单），这些信息改由 \`list_resources\` / 图片工具现场查询。这样"图床掉线"不再改写 system 提示词。
- 「上下文 → 保留强度」的说明里删掉了"该比例同时作为 \`[msg_id]\`/\`[time]\` 标签边界"一句（标签分级已移除），保留强度现在只表示"归档后保留多少比例的最新原文"。
`;
