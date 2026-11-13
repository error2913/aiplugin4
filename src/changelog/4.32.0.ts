// 版本更新日志（数据文件）：4.32.0。正文为 Markdown；行内反引号写作 \`（模板字符串转义）。
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

- **新增四行状态**：\`前缀：稳定\` / \`前缀：已重建 N 次（最近原因：X）\`；\`注入：活动 N 块 / N token / 跳过 N\`；\`前缀守卫：上次校验通过\` / \`前缀守卫：首差异位置 N\` / \`前缀守卫：-\`（无编译统计时不谎报"通过"）；\`缓存：命中率 N%（近 N 轮）\` / \`缓存：命中率 -\`（本会话暂无数据）。
- **新增 \`.ai ctx debug\`**：切换前缀漂移探针（默认关闭、零成本）。开启后每轮比对上轮已发送区的消息哈希，状态里报告首个差异位置 —— 这是排查"缓存突然没命中"的入口。
- **前缀重建原因**（\`.ai ctx\` 里显示的那个 X，共 12 个）：\`archive\`（归档推进水位）、\`purge\`（\`.ai ctx purge --yes\` 清空）、\`edit\`（编辑/替换历史正文）、\`redact\`（\`.ai ctx hide\` 隐藏）、\`config:<键名>\`（改了会影响提示词的配置）、\`reload\`（重载 JS）、\`upgrade\`（版本升级）、\`tools\`（工具 schema 变化）、\`summary-stale\`（摘要区间被编辑污染）、\`inject-overflow\`（注入总量超过硬上限，触发归档腾位）、\`prefix-drift-freeze\`（冻结守卫发现已发送前缀被改写，用上轮快照覆盖回去并记账；正常情况不出现）、\`epoch\`（重置纪元，当前仅测试路径产生，留作后续 repair 复用）。
- **不跳注**：注入块在预算紧张时**先归档腾位**再写入，不会因为"这轮装不下"就跳过；只有"内容已在活动块里"才不重复写。

## 配置项更改

- **本次无配置项变更，升级无需改配置**。存储键、配置键、默认值均未增删，旧配置原样生效。
- 两处**说明文案**更新（不影响取值，也不需要你动手）：「图片 → 图床提示注入」「资源 → 资源清单注入」的说明改为"只控制该段是否注入"，并明确与后端图床/MCP 是否连接无关 —— 段内容已常量化（不再渲染图库数量、最近宿主 ID、\`resource:<name>\` 清单），这些信息改由 \`list_resources\` / 图片工具现场查询。这样"图床掉线"不再改写 system 提示词。
- 「上下文 → 保留强度」的说明里删掉了"该比例同时作为 \`[msg_id]\`/\`[time]\` 标签边界"一句（标签分级已移除），保留强度现在只表示"归档后保留多少比例的最新原文"。

## 开发与工程

- **新增模块**：\`src/context/injections.ts\`（注入块载体与纯函数：\`splitInjections\`/\`activeInjectTokens\`/\`releaseBoundaryOf\`/\`slot\`/\`compareBlocks\`）、\`src/context/injection_dedup.ts\`（\`new\`/\`dup\`/\`dup-text\`/\`updated\`/\`re-inject\` 五类判定）、\`src/context/injection_writer.ts\`（收集→合并→去重→三层额度→预算闸→先归档后写块的唯一写入口）、\`src/context/injection_plan.ts\`（每轮规划入口，L3）、\`src/prompt/injection_registry.ts\` + \`src/prompt/injections/\`（\`core:time\`/\`core:memory\`/\`core:mcp\` 三个内置 provider 与键/哈希工具）、\`src/core/prefix_boot.ts\`（L0，引导期前缀重建归因：\`upgrade\`/\`tools\`/\`reload\`）、\`src/session/quote.ts\`（引用展开）。
- **新增脚本**：\`scripts/check-prefix-purity.mjs\` + \`npm run lint:prefix\`（宽松：报告可疑点）/ \`npm run lint:prefix:strict\`（CI：白名单失效也算失败）/ \`npm run lint:prefix:selftest\`（自测守卫本身：每条规则喂坏样本必红、白名单上下文锚外的同形代码必红、陈旧白名单可检出）。扫描 \`src/context/view\` 与 \`src/utils/message.ts\`，禁止在请求体渲染路径上出现 \`Date.now()\`、\`new Date()\`、\`performance.now()\`、活读会话/用户状态、模板拼接动态段等前缀污染源。CI 的 \`_check.yml\` 已接入 strict 模式。
- **新增测试入口**：\`scripts/unit-test-prefix-obs.ts\`（rebase 记账/白名单原因/缓存窗口滚动/漂移探针/注入块状态视图/\`config:<key>\` 指纹基线语义）、\`scripts/unit-test-time-inject.ts\`（时间注入格式与偏移换算）、\`scripts/unit-test-quote.ts\`（引用 ID 解析口径）、\`scripts/unit-test-injection-providers.ts\`（注入预算三值与 provider 行为）、\`scripts/unit-test-injection-contract.ts\`（渲染位置/去重判定/索引 memo/释放 token 扣减/写块顺序的纯函数契约）、\`scripts/unit-test-injection-plan.ts\`（每轮接线层：四种早退/写块/稳态零注入/provider 异常分流）、\`scripts/unit-test-archive-tools.ts\`（工具面恒定逐字节相等 / 归档注入口径 / \`L\` 单一实现）。
- **新增工具**：\`get_time\`（返回当前时间，含时区偏移；工具组 Timers）—— 历史消息不再带 \`[time]\` 后，模型需要"现在几点"时用它，也可用于算时间间隔。原生 function calling 下它仍通过元工具（\`list_tools\`/\`search_tools\`/\`call_tool\`）发现与调用，不进 \`tools\` 数组，所以不破坏工具 schema 恒定性。
- **新增常量**：\`src/utils/context_limits.ts\` 的 \`HISTORY_EVENT_MAX_TOKENS\`（单条历史事件固定展示上限 8192 token，不随窗口比例变化）与 \`INJECT_ACTIVE_WINDOW_TOKENS\`/\`INJECT_PER_TURN_MAX_TOKENS\`/\`INJECT_COLD_START_MAX_TOKENS\`/\`INJECT_ACTIVE_MAX_TOKENS\`（注入三层额度）；\`TAG_ANCHOR_GAP_SEC\`/\`TAG_ANCHOR_EVERY_MESSAGES\` 随标签分级一起删除。
- **层归属**：\`prefix_boot.ts\` 必须放 L0 —— 读者是 \`utils/message.ts\`（L2）与 \`index.ts\`（L4），放 \`session/\`（L3）会造出 L2 → L3 的反向依赖，\`npm run deps:check\` 会拒绝。
- **验收口径修正**：\`npm run sim\` 的「session 体积与消息总量解耦」原来比两个**瞬时** blob，而 blob 实际是**锯齿**（窗口移出成批砍掉最旧一段），采样点落在齿谷还是齿峰纯看运气。本版历史每条约短 20 字（\`[time]\` 去掉）⇒ 窗口塞进约 3 倍条目，恰好第二批采到齿峰，断言假红。现在改成全程记**峰值**再比（峰值口径对锯齿免疫），两版都是平的。
- **单测基础设施重构**：\`npm run test:unit\` 从 **75s 降到 ~16s**（≈4.8×）。改为「一次 esbuild 多入口构建 → 一次性加载 → 显式 \`process.exit\`」：原实现 54 个入口逐个 \`build\`+\`require\` 交错执行，实测把 \`require\` 拖慢近 10 倍（load 37.7s → 2.8s），且 src 残留的定时器句柄让进程空等 26s。顺带清掉 81 个已被正则永久跳过的僵尸用例，把 14k 行的 \`scripts/unit-test-entry.ts\` 按域拆成 10 个 \`unit-test-*.ts\`（共享前置抽到 \`unit-test-helpers.ts\`），用例总数 1085 与拆分前逐字一致。
- **单测顺序无关性**：新增 \`UNIT_ORDER\`（\`reverse\`/\`shuffle:<seed>\`/\`files-reverse\`/\`files-shuffle:<seed>\`/\`inner-reverse\`）、\`UNIT_FILES\`、\`UNIT_TESTS\`、\`UNIT_ORDER_LOG\` 等巡检开关，并修掉 11 处跨文件/文件内全局状态污染（\`TokenCalibration.resetAllForTest\`、\`resetBtoaWarnForTest\`、\`getAgentResolver\`、\`getAuxLlmImpl\`、\`Config.registerConfig\` 幂等、\`Tool.getNativeRequestTools\` 空结果不缓存等），现在任意文件顺序、任意用例顺序全部 1085 例绿。
- **修掉一处注入静默失效**：\`injection_dedup\` 的活动索引 memo 键只含「块数 / 最大 seq / 释放水位」，不含会话身份 ⇒ 两个会话这三项恰好相同时会串用索引，后一个会话的新条目被判 \`dup\` 而**不注入**（并发两个群同时说话时真实可达）。现在把调用方 \`ContextService\` 一并纳入命中条件。
- **文档同步**：docs/02（Prompt 组装与上下文构建）、docs/03（上下文 / 智能体 / 提示词）、docs/05（\`.ai ctx\` 子命令）、docs/13（记忆增量注入）、AGENT.md（工程约定与检查清单）、README（上下文与提示词章节、\`.ai ctx\`、\`get_time\`）。
`;
