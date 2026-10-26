# 记忆方案冗余 / 单一事实源审查（01·03·04 + 现有代码）

> 审查对象：`01-认知层重写方案.md`（557 行）、`03-全局记忆与三层自动链路方案.md`（481 行）、`04-记忆抽取与心智模型更新时机方案.md`（492 行），以及 `src/memory/**`、`src/agent/context_bridge.ts`、`src/agent/agent.ts`、`src/context/archiver.ts`、`src/context/service.ts`、`src/timer.ts`、`src/prompt/memory_source*.ts`、`src/prompt/templates.ts`、`src/cmd/sub_cmd/memory.ts`、`src/tool/tools/memory/tool_memory.ts`、`src/config/configs/memory.ts`、README、docs/03、docs/05。
> 性质：只读审查，未改 `src/` 与既有 docs。未跑构建；行数以 `Get-Content` 实数核对。

## 0. 结论速览

1. **三份方案对同一行为的定义确实重叠**：抽取/路由、观察更新、MM 刷新、注入、命令工具、配置默认值/命名六类各写了 2–3 份，其中 5 处直接冲突（见 §1）。
2. **代码侧真正的冗余不是“文件多”，而是同一语义有多条物理路径**：观察双份、抽取双实现 + 四入口、三个门面、两套限流、三处渲染、两处端口、两套权限判定（见 §2）。
3. **“删除清单”基本覆盖了显性双份，但漏了 14 类**会留下第二路径的残留（docs/03 §9、docs/05 配置行、README 配置/工具表、`SUMMARY_TEMPLATE`、`migrate.ts` 实况、测试耦合、`lastVerifiedAt` 读者等，见 §3）。
4. **四个新文件不是都必要**：`structured.ts` 必要；`scheduler` 可压到一半并复用已有 `Backoff`；`service.ts` 与 03 的改名 `MemoryService` 撞名，应降为纯函数 `access.ts`；`memory_work` 端口在 v2 下对应的 archiver 根本不会执行（`context/context.ts:684-695`），可降级或合并进现有 `memory_source` 端口（见 §4）。
5. **代码预算表算术自洽，但范围不完整**：漏了 scheduler≈250、port≈20、retention 拆分、context/agent/builder/config 改动与既有测试改造，`净减 350` 不成立（见 §7）。
6. **建议的单一事实源**：数据模型与算法归 01、bank/标签/可见性/全局归 03、时机与默认值/队列/配置 key 归 04；配置面板描述只在 `config/configs/memory.ts`，抽取 schema 只在 `prompt/templates.ts`。

## 1. 方案内部重复与冲突（应“留一份、其余引用”）

| # | 主题 | 01 的说法 | 03 的说法 | 04 的说法 | 冲突点 | 唯一规范 |
|---|---|---|---|---|---|---|
| 1 | 抽取与路由 | §3.1 `retain` 由 command/tool/media/归档共用 | §3.1 归档→`summarizeChunk`→确定性 `routeFacts` | §3.2 五个触发点 + scheduler `extract` job | 没人定义“谁抽、谁路由、谁写”、路由算不算抽取的一部分 | 04 §3.2 触发 + 03 §3.3 路由；函数上只保留 `extractFacts`（纯 LLM）与 `applyFacts`（校验+路由+写） |
| 2 | 观察更新 | §3.3 consolidate 内 LLM 决策（create/reinforce/refine/contradict/merge/split/none） | §3.4 update→invalidate→“下次 consolidate 改写” | §1.2/§3.3 与 01 同义 | 决策枚举三套；现有代码只接了 created/refined/merged | 01 §3.3 为算法唯一源；03/04 只引用 |
| 3 | MM 刷新触发 | §3.4 consolidate `touchedTags` 后自动刷新 | §3.4 归档后“**必须**调用 refresh” | §3.4 **默认关闭**，开启后才 tag 重叠+stale+限频 | 默认值/触发条件直接对立 | 04 §3.4；01 §3.4 与 03 §3.4 改为“见 04” |
| 4 | MM 限流/冷却 | §3.4 per-bank 最小间隔 + failed 冷却 | 未定义 | per-model 单 pending、min interval 默认 0、冷却 30min | 粒度冲突；代码把同一配置兼作失败冷却（`mental_models.ts:311`） | 04：per-model；配置拆成“最小间隔”和“失败冷却”两个 key |
| 5 | 注入 | §3.6 `buildMemoryPrompt` 单入口（观察并入） | §5.2 “单渲染器”再定义一次 | §3.5 只讲 reflect | “单渲染器”写两遍，且现有 builder 仍是长期/观察两段独立缓存 | 01 §3.6；03 §5.2 删除并引用 |
| 6 | 可见性/标签 | §3.1 仍用 `vis:private:<sid>`/`vis:public`，keywords 原样 | §7.3 改为 `vis:public|vis:origin:<scopeId>|vis:owner`、`kw:` 前缀、保留前缀拒绝 | 未定义 | **两套词表**：按 03 迁移后 01 的 `vis:private` 判定全部失效 | 03 §7.3；01 §3.1 改为调用 03 的 `visibilityTag/scopeTagsOf` |
| 7 | 全局 bank 与命名 | 未展开 | §4.1/§7.3 `global_<agentName>`、主 agent `*`→`main` | 未展开 | 01 §0 说“不新增目录/抽象”，但全局 bank 需要写入/注入/命令入口，预算表未计 | 03 §4/§7.3 |
| 8 | 命令/工具表面 | §4.1/§4.2 完整表 | §6.1/§6.2 又写一遍，参数名改 `memory_scope/fact_kind` | §4.5 status/ops | 01 的工具参数仍是 `scope: current|user|group` 与 `related_*`，与 03 未对齐 | 01 §4 唯一；03 §6 只留 `--self`、`memory_scope` 增量 |
| 9 | 配置默认值/命名 | §3.7/§9 `MEMORY_CAP=300`、`MEMORY_REFRESH_AFTER_CONSOLIDATE` | §6.3 新增 3 项并改名 `MENTAL_MODEL_*`/`MEMORY_MAX_FACTS`；标题写“新增 **2** 项”但表里 3 项 | §6 另一张 20+ 行默认值表，**没有 key 名** | 三套 key/默认值；03 自身数字不自洽 | 04 §6 为唯一默认值表；key 命名用 03 §7.5；01 改引用 |
| 10 | 产品决策状态 | §12 “三个决策已确认” | §9 同 | §9 又列 5 个“需要确认”（含 MM 自动刷新默认） | 已确认/待确认并存 | 决策只留一处（建议 01 §0 决策记录），04 §9 删除 |
| 11 | 抽取 schema | 未涉及 | §3.2 新增 `owner/target_user_ids/target_group_ids/fact_kind/confidence` | 未涉及 | **现有 `prompt/templates.ts:136-228` 已定义 `op/memory_type/target_id/related_user_ids/related_group_ids/related_memory_ids/visibility/summary`**；03 没发现它，另造一套字段 | `templates.ts` 唯一；03 只补 `confidence` 并删除 `summary` |
| 12 | staleness | §3.3 90 天 `lastSupportedAt`→`status(active/stale/invalidated)` | 未定义 | §3.3 积压 0/<10/≥10→up_to_date/slightly_stale/stale；§5 A.5 说“标 stale” | 两套 stale 定义、两套枚举；一个要求落库，一个只读 | 拆成两个**派生**概念：observation 过期（时间）+ 巩固积压（计数）；`status` 只存 active/invalidated |
| 13 | 迁移 | §5 说 `migrate.ts` 在 `repository.getBank` 按 `schemaVersion` 惰性执行 | §8 P1 引用 01 | 未定义 | 现有 `v2/migrate.ts` 是 `memoryMap/summaries/persona` 旧档导入器（74 行、仅测试调用），**不是** v2→v3 迁移；`schemaVersion` 现在不存在 | 01 §5 改为“新增 v2→v3 迁移”；旧 `migrate.ts` 删除或降为一次性导入 |

**改写动作（最小）**
- 01 删除：§3.4 的自动刷新触发细节、§4.1 status 中的生效配置展示、§9/§12 的默认值断言 → 改为引用 04。
- 03 删除：§3.4 刷新段落、§3.5 触发/预算、§6.3 配置表 → 引用 04；§3.2 的 schema 改为 `templates.ts` 的增量 diff。
- 04 删除：L1/L2/L3 的语义细节（观察如何改写、MM 如何 delta）→ 引用 01；只保留时机、队列、默认值、可观测。

## 2. 代码层冗余设计（按“是否删/并”判定）

| # | 冗余 | 证据 | 判定 | 处理 |
|---|---|---|---|---|
| 1 | 观察双份存储 | `v2/consolidation.ts:129-156` `syncObservationUnit`；`types.ts:5` `factType='observation'`；`engine.ts:300,383-397` | 删 | 01 已列；注意删除时同步清理 observation 的同步 unit 与 evidence 引用 |
| 2 | 观察双注入 | `manager.ts:131` 注释 + `227-239` 观察段；长期段 `engine.recall(...preferObservations)` 也会把观察当 unit 注入；`prompt/builder.ts:182-195` 两段独立缓存 | 删双入口 | 01 §3.6 说了单入口，但删除清单没有 `prompt/builder.ts` 行；需把两 cache 合一 |
| 3 | 抽取双实现 | `manager.summarizeChunk`（LLM+解析+写+巩固）与 04 的 scheduler `extract` job（又一套 LLM+写）；另有 `v2/llm.ts:13-31` 第二份抽取提示词 | 合并 | 拆 `extractFacts`（只调 LLM 返回 facts）与 `applyFacts`（路由/写/失效）；scheduler 只排队调用这两个函数 |
| 4 | 抽取四入口 | `agent/context_bridge.ts:179`；`context/archiver.ts:95/377/414`；`cmd/sub_cmd/memory.ts:445`；上下文超长的 `agent.ts:416`→archiver | 保留 1 个自动入口 | `consumeContextV2` 是唯一自动入口；archiver 与手动命令调同一 `extractFacts`，不各自建管线 |
| 5 | archiver 直接依赖 memory | `archiver.ts:6`，但 `context/context.ts:683-696` 在 v2 下 `settleWindowIfNeeded/archiveByTokenIfNeeded` 直接 return | 新 port 非必要 | v2 时代 archiver 永不写记忆；若 v1 仍支持，最多保留一个“legacy 例外”，不必为它新增端口+静态守卫 |
| 6 | 三个门面 | `MemoryManager`（431）+ `SessionMemoryService`（233）+ 01 新增 `memory/service.ts`（200）；03 §7.5 又把 `MemoryManager` 改名 `MemoryService` | 合并成 2 层 | `MemoryService`（原 manager，唯一引擎门面）+ `SessionMemoryState`（仅持久化字段/getter）+ `access.ts`（纯函数，不叫 Service） |
| 7 | 命名撞车 | 01 §4.2 的 `service.ts` 与 03 §7.5 的 `MemoryService` 同名不同物 | 必须改名 | `memory/access.ts`（或 `memory_access.ts`） |
| 8 | 引擎↔MM 服务穿透 | `engine.ts:481-519` 5 个 1:1 委派 + `getLastAutoRefreshAt` | 保留委派但删死项 | 删 `getLastAutoRefreshAt`（随 tick 配置一起）；`setRefreshMinInterval/setMentalModelDefaults` 可合并进构造函数 options |
| 9 | 三套后台调度 | `timer.ts`（430，5s loop）、`context/compact/runtime.ts`（186，throttle/hourly/backoff）、04 新增 scheduler（250，又一套 30–60s tick、hourly、backoff）；`context_bridge` 还自管 cursor 进度 | 新建了第 4 套 | scheduler 只保留“持久队列+优先级+去重+派发”；复用 `compactor.Backoff` 与现成 `HourlyCap` 逻辑，不再写第二份 per-bank 锁（engine 已有 `consolidatingBanks/refreshingBanks`） |
| 10 | 端口两个家 | `prompt/memory_source.ts`（已在用，L0 但放在 prompt/）与新 `core/ports/memory_work.ts` | 一个边界两个文件 | 合并为 `core/ports/memory.ts`（读+写两半），`prompt/memory_source.ts` 迁过去；否则端口数量从 5 涨到 7 |
| 11 | documents/chunks | 写入仅当 `input.documentId`（`engine.ts:253-269`），全仓无调用方传；`includeChunks`（`engine.ts:296,403-405`）无调用方；`storage.saveBank` 每次仍写空 `docs` 分片 | 删 | 01 §5.6 只“清理数据、保留字段”，不够；应删类型/仓储方法/存储分片/参数，并迁移时置空 `memv2:<id>:docs` |
| 12 | disposition/directives/missions | `types.ts:18-29` 四个字段只在 `repository.ts:52-53` 初始化，全仓 0 读写 | 删 | 01 §2 还写“保留旧字段只读”，等于永久死字段；迁移丢弃 |
| 13 | consolidateSince | `types.ts:31`、`engine.ts:463-474`，生产 0 调用，但 `scripts/unit-test-entry.ts:4882` 有测试 | 删（含测试） | 01/03 都只在 03 N8 提了一句，删除清单没列 |
| 14 | 观察开关三份 | `Config.memory.SUMMARY`（注入 gate，`builder.ts:191`）、`session.summaryOverride`（只用于 status 显示，注入未读）、`summaryStatus`（`cmd/memory.ts:381/388` 写、无人读） | 合并 | 单一 `observationEnabled(session) = override ?? config`；`summaryStatus` 删；01 §3.6 要求 `obs off` 真正生效，但删除清单无 `builder.ts` 行 |
| 15 | 死方法/死类 | `manager.recallMemory`（286-299，0 调用）；`session_memory.buildObservationPrompt`（177-186，0 调用）、`findImage`（215）、`findMemoryAndImageByImageIdPrefix`（219）、`reviveMemoryMap`/`migrateLegacyTags`/`accessMemories`（188-198）；`llm.configureDefaultCallbacks`（173-183，0 调用）；`engine.deleteBank`、`repo.deleteUnit/listEntities/getEntity/listLinks` | 删 | 01 漏了 `configureDefaultCallbacks`、`engine.deleteBank`、`repo` 4 个只定义方法，以及被删方法带出的模板 |
| 16 | parseLooseJson 两份 | `session_memory.ts:19-33` 与 `v2/llm.ts:67-81` 完全同构 | 合并 | 移到 `utils/json.ts`（或 `utils/parse.ts`），两处 import |
| 17 | 提示词两处 | `prompt/templates.ts`（含 `SUMMARY_PROMPT_TEMPLATE`）+ `v2/llm.ts:13-65` 四段引擎提示词 | 明确一处 | 引擎提示词移入 `prompt/templates.ts`（README:555 “6 个模板”同步），或显式声明 llm.ts 为私有；不能两套都“可改” |
| 18 | 三渲染器 | `prompt.ts:107 buildMemoryPrompt`（生产 0 调用，仅测试）；`buildGroupedMemoryPrompt`（群聊）；`manager.ts:216-220` 私聊另拼 `buildMentalModelsPrompt+buildLongTermMemoryPrompt` | 合并 | 一个 renderer + 段渲染函数；私聊走同一段列表（sections 长度 1） |
| 19 | 未接线枚举/字段 | `MemoryState.invalidated`、`ConsolidationState.failed`、`RetainResult.updated`、`ConsolidationResult.skipped`、`LinkType` 中 causes/caused_by/enables/prevents、`RetainInput.context`、`metadata.importance`（与 `unit.importance` 重复）、`ObservationHistoryEntry.reason` 只有 created/refined/merged 被写 | 删或接线 | 03 的 update/delete 会接 `invalidated`；其余先删，避免“定义了却永远不出现”的第二语义 |
| 20 | MM 固定模板 pending | `ensureDefaultMentalModels` 造 `pending` 占位，`buildLongTermPrompt` 只注入不刷新→占位永不变 ready（除非用户手动 mm refresh） | 功能缺口+两套体系 | 若保留固定模板，就在 scheduler 里排 `mm_refresh(reason='seed')`；否则删掉自动播种 |
| 21 | 双套 tags 拼装 | `manager.tagsForSession` 与 03 §3.3 `routeFacts` 各自拼 `user:/group:`；`scopeTagsOf/scopeTagOf` 尚未存在 | 合并 | 统一到 `access.ts` 的 `scopeTagsFor(session|bank)`，01/03 共用 |
| 22 | 双份去重语义 | 01 §3.2 按 id Set、§3.6 按 text hash；03 §3.3/§5.2 按 text hash 跨 bank 去重 | 保留但只定义一次 | 去重只属于渲染层（01 §3.6），recall 内不做跨 bank 去重 |

## 3. “删除清单”缺口（会留下第二路径）

| # | 漏项 | 位置 | 后果 | 建议 |
|---|---|---|---|---|
| 1 | docs/03 记忆章仍描述 `syncObservationUnit`/`buildObservationPrompt`/`summarizeChunk` | `docs/03-核心模块详解.md:202,209,214` | 代码删了文档还在教旧路径 | 01 §6 增加 docs/03 行（与 README 一起） |
| 2 | docs/05 配置行含死配置 | `docs/05-命令与配置.md:139`（定时刷新间隔） | 用户仍能看到/以为生效 | 配置删除时同步 |
| 3 | README 配置表未同步 | `README.md:480-494`（默认 100、死配置） | 与 01 的 300 矛盾 | 01 只列了 `README:607-630` 命令表，漏配置表 |
| 4 | README 工具表仍 12 个 | `README.md:738`（含 `memory_clear`、5 个 mm） | 7 工具后文档仍是 12 | 增加一行 |
| 5 | `SUMMARY_TEMPLATE`/「观察记忆prompt模板」 | `prompt/templates.ts:78-86,234`，唯一使用点是被删的 `session_memory.buildObservationPrompt` | 删方法后成死模板，README:555 仍称 6 模板 | 删模板并改 README 为 5 |
| 6 | `migrate.ts` 现状 | `v2/migrate.ts`（74 行，仅测试调用） | 01 把它当 v2→v3 迁移扩到 150 行，等于扩写死代码 | 先降级/删除，再新写 v2→v3 迁移 |
| 7 | 测试改造未计 | `scripts/unit-test-entry.ts:3000+`（提示词/MM）、`:4882`（consolidateSince）、`scripts/unit-test-context-bridge.ts:10,59`（stub `summarizeChunkWithRetry`）、`scripts/test-unit.cjs` 手工 bundle 列表 | 删/改名会直接红；01 预算只算“新增 500 行测试” | 预算加“修改现有测试”；不要新建 `unit-test-memory.ts` |
| 8 | “当前记忆模块 0 测试”前提错误 | 01:496 | 决策依据错，导致低估改造面 | 改为“现有测试需迁移/补缺” |
| 9 | `lastVerifiedAt` 的读者 | `cmd/memory.ts:399,418-421`；`v2/prompt.ts:51-53`；`v2/consolidation.ts:107` | 01 删字段但没有迁移/替换这些读取 | 统一改派生函数 `observationFreshness()` |
| 10 | `selectInjectionCandidates` 去留 | `v2/prompt.ts:39-62`，被 manager 与 cmd 使用 | 01 §3.6 说“状态估算调用同一选择函数”，但没定签名/位置 | 迁到 `access.ts`，manager/cmd 共用 |
| 11 | observation 同步 unit 的迁移 | 01 §5.2 只写“删除 factType=observation 的 unit” | 旧 evidence 指向这些 unit、合并后的 orphan 未说明 | 迁移时按 `observations[].id` 反查，级联清 links/evidence |
| 12 | `migrateLegacyPersona` 字段耦合 | `manager.ts:98-101` 用 `m.question` 查重 | 03 改名 `sourceQuery` 后失效 | 01 §5 增补调用点 |
| 13 | `obs off` 未接注入 | `prompt/builder.ts:191` 只读 `Config.memory.SUMMARY` | 01 声称修复，但没有对应改动行 | 在 §6 增 `builder.ts` + 有效开关函数 |
| 14 | 工具 `memory_update` 反向权限 | `tool_memory.ts:450` 判的是“unit 带调用方自己的 private 标签”而非“对调用方不可见” | 越权仍存在，与 01 声称的修复不符 | 删除该工具实现，统一走 access 的 `canMutate` |

## 4. 新增文件是否必要

| 文件 | 计划量 | 发现 | 结论 |
|---|---:|---|---|
| `agent/memory_scheduler.ts` | 250 | 与 `TimerManager`、`CompactionRuntime` 的“持久化+空停+限流+退避+单飞”重复；per-bank 锁又和 engine 内锁重复 | 保留但压到 ~150：只做持久队列/优先级/去重/派发；限流复用现成 `Backoff`，删掉“每 bank 最小间隔”这个第三闸 |
| `memory/service.ts` | 200 | 与 03 改名后的 `MemoryService` 撞名；内容是纯函数 | 改名 `access.ts`，目标 ≤120；只放 `resolveScope/canSee/canMutate/format/parseId` |
| `memory/v2/structured.ts` | 90 | delta 的字节级基线确实需要 AST，无替代 | 保留；delta 默认关，可放 P2，先做 full |
| `core/ports/memory_work.ts` | ~20 | v2 下 archiver 三个记忆调用都不可达（`context.ts:684-695`） | 与 `prompt/memory_source.ts` 合并为 `core/ports/memory.ts`；若同版本下线 context v1，则两个都不需要 |
| `memory/v2/retention.ts`（01 §7 提“拆”） | 未给 | 预算表没有这一行；`pruneBank` 已在 consolidation.ts | 不新建，留在 consolidation.ts |
| `scripts/unit-test-memory.ts` | 500 | 已有 `unit-test-entry.ts` 记忆测试 + `unit-test-context-bridge.ts`；`test-unit.cjs` bundle 是手工列表 | 不新建，续写现有 entry；预算改为“新增用例数” |
| 新 scheduler 的测试 | 未计 | 04 §7 要求假时钟/重载/熔断一堆用例 | 补进预算，否则隐藏 +150~250 行 |

## 5. 配置：重复、同义与最终表

### 5.1 冲突清单

| 现有配置（面板） | 方案中的叫法 | 默认冲突 | 结论 |
|---|---|---|---|
| 长期记忆条数上限 | `MEMORY_CAP`(01) / `MEMORY_MAX_FACTS`(03) | 100 现网 vs 300（01/03 已确认） | 改名 `MEMORY_MAX_FACTS`，默认 300 |
| 巩固后自动刷新心智模型 | `MEMORY_REFRESH_AFTER_CONSOLIDATE`(01) / `refreshAfterConsolidation`(03/04) | 配置 true、模型 per-model 默认 true、04 说 false、03 说“必须” | **删全局开关**，只留 per-model `refreshAfterConsolidation=false` |
| 心智模型刷新最小间隔 | `MEMORY_REFRESH_MIN_INTERVAL` / `MENTAL_MODEL_MIN_REFRESH_INTERVAL_SECONDS` | 30 分钟（现网）vs 0（04） | 改 per-model，默认 0；30 只作为 UI 建议值 |
| 心智模型定时刷新间隔 | `MEMORY_MM_TICK_INTERVAL` | 0，全仓无消费（`config/memory.ts:26,42`、`engine.ts:133-136`、`mental_models.ts:71`） | 删 |
| 用LLM抽取记忆 | 04 的“自动记忆抽取” | false，但为 true 时会与归档抽取叠加（每事实再抽一次，`index.ts:30`+`manager.ts:384`） | 删；抽取恒为归档级一次 |
| 新增自动抽取开关 | 03 三个（全局/个人/全局本体）vs 04 一个“自动记忆抽取” | 03 §6.3 标题写 2 项、表里 3 项 | 1 个总开关 + 2 个“来源”子开关 |
| 观察开关 | `SUMMARY` + `summaryOverride` + `summaryStatus` | 三份，且后两者不参与注入 | 合并为 `observationEnabled(session)` |
| MM 输出上限 | 04 默认 2048 vs 刷新实参 4096（`mental_models.ts:363`） | 代码与文档冲突 | 统一 2048，可配 |
| 注入预算 | 01 3000（无 key）；03 3000 + 全局 300 | 都只是文字 | 落成两个 key |

### 5.2 最终配置表（建议直接作为 04 §6 的唯一表）

| 面板名 | 内部 key | 类型 | 默认 | 说明 / 与现状差异 |
|---|---|---|---:|---|
| 启用记忆 | `MEMORY_ENABLED` | bool | true | 总开关，同时 gate 写入与注入（现状只 gate 注入，`MEMORY` 关闭时归档仍写） |
| 启用观察记忆 | `OBSERVATION_ENABLED` | bool | true | gate consolidate 与注入（现状只 gate 注入，关掉仍花 LLM 巩固） |
| 长期记忆条数上限 | `MEMORY_MAX_FACTS` | int | 300 | 0=不限；安全阀，只在 maintenance 执行（01 §3.7） |
| 召回新近度权重 | `RECALL_RECENCY_WEIGHT` | float | 0.4 | 保留 |
| 召回新近度半衰期 | `RECALL_RECENCY_HALF_LIFE_DAYS` | int | 60 | 保留 |
| 语义相似度下限 | `RECALL_SEMANTIC_MIN_SIM` | float | 0.35 | 01 §3.2 提到“配置项”但无 key，补 |
| 自动抽取 | `EXTRACT_ENABLED` | bool | true | 取代“用LLM抽取记忆”；关闭后只有手动 add |
| 群聊→个人抽取 | `EXTRACT_PERSONAL_FROM_GROUP` | bool | true | 03 §9 决策 5 |
| 本体自动抽取 | `EXTRACT_GLOBAL` | bool | true | 03 §9 决策 4；严格过滤见 03 §4.3 |
| 启用全局记忆 | `GLOBAL_MEMORY_ENABLED` | bool | true | 03 §4；无数据零成本 |
| 巩固批量 | `CONSOLIDATION_BATCH_SIZE` | int | 50 | Hindsight 默认 |
| 巩固派发窗口 | `CONSOLIDATION_DISPATCH_SEC` | int | 30 | 取代“抽取静默窗口/巩固阈值”两个伪配置 |
| 后台并发 | `BACKGROUND_CONCURRENCY` | int | 1 | 安全阀 |
| 后台小时上限 | `BACKGROUND_HOURLY_LLM_CAP` | int | 20 | 安全阀；0=不限 |
| 失败重试/熔断 | `BACKGROUND_MAX_ATTEMPTS` / `BACKGROUND_BREAKER_MIN` | int | 3 / 30 | 退避常量 1s→60s 不暴露 |
| 自动维护固定心智模型 | `MM_TEMPLATES` | bool | true | 保留；但需排 `mm_refresh(seed)` 否则 pending 永不 ready |
| 默认刷新模式 | `MM_DEFAULT_MODE` | option | full | 保留 |
| 巩固后自动刷新 | `MM_REFRESH_AFTER_CONSOLIDATE` | bool | false | per-model 覆盖；**默认对齐 Hindsight** |
| MM 最小刷新间隔 | `MM_MIN_REFRESH_INTERVAL_MIN` | int | 0 | per-model；不再是 bank 级 |
| MM 失败冷却 | `MM_FAILED_COOLDOWN_MIN` | int | 30 | 从“最小间隔”拆出，避免一配置两用 |
| MM 输出上限 | `MM_MAX_TOKENS` | int | 2048 | 修正 4096 实参 |
| MM delta 定期 full | `MM_DELTA_FULL_REBUILD_HOURS` | int | 48 | 需在模型上新增 `lastFullRefreshAt` 字段，否则 48h 无判定依据 |
| 注入预算 | `INJECT_MAX_TOKENS` | int | 3000 | 01 §3.6 |
| 本体注入预算 | `INJECT_GLOBAL_MAX_TOKENS` | int | 300 | 03 §4.4 |
| LLM 重排 / 观察合成 / 推理 | `LLM_RERANK` / `LLM_OBSERVATION_SYNTH` / `LLM_REFLECT_SYNTH` | bool | false / true / true | 保留 |

**删除**：`MEMORY_MM_TICK_INTERVAL`、`MEMORY_REFRESH_AFTER_CONSOLIDATE`（全局）、`MEMORY_LLM_EXTRACT`、`SUMMARY`+`summaryStatus`+`summaryOverride` 三份合并、`consolidateSince`、`抽取静默窗口`、`巩固触发阈值`、`巩固最小间隔`（与派发窗口重复）、`disposition/directives/retainMission/observationsMission`。

## 6. 命令与工具：重复实现与复用边界

| 能力 | 命令侧 | 工具侧 | 重复/差异 | 复用边界 |
|---|---|---|---|---|
| 范围解析 | `cmd/memory.ts:42-105`（--u/--g/骰主） | `session_target.ts` + 每个 solve 里 `normalizeUserId/GroupId+getCtxAndMsg`（84-99、169-186、281-301、357-374）共 4 份 | 3 套解析，错误文案 2 套 | `access.resolveScope({scope,targetId})`，命令/工具只做参数映射 |
| 权限 | `protectedMemoryIds`（只保护 private） | delete/clear 保护全部跨会话；update 判定反了（`tool_memory.ts:450`） | **三套策略** | `canRead/canMutate({caller,target,unit})` 单一策略，命令与工具同源 |
| 列表 | `getLatestMemoryListText`（无序号、固定 5/页） | `buildMemory`（无页码、无序号） | 两种格式 | `formatMemoryList(units,{page,pageSize,withIndex})` |
| MM 列表/详情 | `cmd:489-529`（fmtDate、状态/内置标记） | `tool:531-590`（toISOString、10/页 vs 5/页） | 两种格式/分页 | `formatModelList/formatModel` |
| add | `retainMemory` | `MemoryManager.retainMemory` | 同一函数两处调用 | 合并后 `service.add()` |
| update | 直接改 repo，不重算 embedding、不校验权限 | 直接改 repo+重复文本合并+方向反的权限 | 两套实现 | `service.update()` 内做校验+embedding |
| delete | `deleteMemory` | `deleteMemory` | 相同 | `service.delete()` |
| clear | `clearMemory`（无确认） | `memory_clear`（应删） | 危险操作双入口 | 只留命令 + `--yes`；删工具 |
| consolidate | `MemoryManager.consolidateMemory`（读全局配置） | 手写 consolidate+refresh（8 行重复） | 刷新门控两套 | `service.consolidate()` |
| mm add/refresh | `cmd:530-595`（create+refresh+回复细节） | `memory_mm_create/refresh`（同样 create+refresh） | 各 ~40 行重复 | `service.mentalModelOp(action,args)` |
| reflect | `engine.reflect` | `engine.reflect` | 相同 | `service.reflect()` |

**12→7 评价**：现有 12 个（`memory_add/delete/recall/clear/update/consolidate` + `mm list/view/create/refresh/delete` + `reflect`），删 `memory_clear`（−1）、5 个 mm 合并为 1（−4）= **7，算术正确**。但 01:507 测试计划写“13→7”，需改为 12→7。7 已是合理下限；唯一可再减到 6 的方式是把 `memory_update` 并进 `memory_add`（带 `id` 即 upsert），代价是模型语义变模糊，不建议。工具参数层还有一个隐式重复：每个工具都重复 `memory_type/target_id`，01 已改为 `memory_scope/target_id`，应一次改完。

## 7. 代码预算核算

| 项 | 01 表值 | 核对 |
|---|---:|---|
| 现状合计（16 生产行） | 4831 | **逐文件实数一致**（manager 431、session 233、tool 762、cmd 646、engine 732…） |
| 目标合计 | 4480 | 表内行相加 = 4480，表内 **净减 351**，算术自洽 |
| 遗漏：`agent/memory_scheduler.ts` | — | 04 明写 ~250；未入表 → 目标变 ~4730 |
| 遗漏：`core/ports/memory_work.ts` | — | ~20；未入表 → ~4750 |
| 遗漏：`retention.ts` | — | 01 §7 说 engine 拆 retention，但表无此行；若真拆 +~80 → ~4830 |
| 遗漏：context/agent/builder/config 改动 | — | archiver 换端口（~0/+10）、context_bridge 改入队（+40）、builder 单渲染/单 cache（+10）、config 增删（+20） → ~4910 |
| 测试 | +500（新文件） | 现有 `unit-test-entry.ts`/`context-bridge` 改造未计；若续写现有 entry，至少 +150 改 +300 增 |
| “200+90 换掉 400+ 行重复” | — | tool 目标 762→500（−262）、cmd 646→600（−46），节省已计入目标；新增 290 后再宣称“换掉 400”= **重复计算**，实际这笔替换约 −18 |
| `migrate.ts` 74→150 | — | 现有文件生产 0 调用；扩写等于给死代码 +76 |
| 结论 | 净减 350 | **不可信**。把所有被改文件计入后，实际区间约 **−50 ~ +250**（取决于 scheduler/port 是否合并、v1 是否下线）。建议：① 预算表补 scheduler/port/retention/context/agent/builder/config 与测试改造；② 删除“净减 350”，改“生产代码不增加，且删除双份后净减待实测”；③ 先做先删后加的两个可独立验收的 PR |

## 8. 必须删除/合并的 Top 8

1. **观察双份 + 双注入**：删 `syncObservationUnit`、`factType='observation'`、`preferObservations`、`SessionMemoryService.buildObservationPrompt`，渲染收成 1 个 entry（含 `prompt/builder.ts` 两 cache 合并）。
2. **抽取双实现/四入口**：拆 `extractFacts`（LLM）与 `applyFacts`（路由+写）；删 `MEMORY_LLM_EXTRACT` + `engine` 级 extractor + `llm.EXTRACT_PROMPT`；`consumeContextV2` 为唯一自动入口，archiver/cmd 只调同一函数。
3. **三个门面 + 命名撞车**：`MemoryService`（原 manager）+ `SessionMemoryState` + `access.ts`；01 的 `service.ts` 必须改名，避免与 03 §7.5 冲突。
4. **死字段/死配置整批删**：`MEMORY_MM_TICK_INTERVAL`、`getLastAutoRefreshAt`、`consolidateSince`+测试、`disposition/directives/retainMission/observationsMission`、`documents/chunks/includeChunks`、`summaryStatus`、`metadata.importance`、`configureDefaultCallbacks`、`engine.deleteBank`、`repo.deleteUnit/listEntities/getEntity/listLinks`、未赋值枚举。
5. **MM 刷新默认值三写**：04 唯一；per-model `refreshAfterConsolidation=false`、min interval 0、失败冷却独立 30min；删 01/03 的重复定义与全局开关。
6. **可见性两套词表**：03 §7.3 唯一；01 删 `vis:private`，统一 `public/origin/owner` + `kw:`；迁移一次完成，别双读。
7. **命令/工具权限与格式化双份**：一个 `access.ts`（`canRead/canMutate` + 2 个 formatter）；工具 12→7；删 `memory_clear`；修 `memory_update` 反向判定（或随工具合并消失）。
8. **预算与端口不实**：`memory_work` 与 `memory_source` 合并（或 v1 下线后全删）；scheduler 压到 ~150 并复用 `Backoff`；预算补全，取消“净减 350”结论。

## 9. 只需保留一个规范的文档/模块

| 内容 | 唯一规范 | 其余动作 |
|---|---|---|
| 数据模型/retain/recall/consolidate/reflect/渲染 | 01 §2–§3 | 03 §3.4/§5.2、04 的语义段改为引用 |
| bank / 标签 / 可见性 / 全局 / 命名 | 03 §2/§4/§5/§7 | 01 §3.1/§3.6 改为调用 03 的 helper；删 01 的 private 词表 |
| 时机 / 默认值 / 队列 / 配置 key | 04 §3/§4/§6 | 01 §3.4/§9、03 §3.5/§6.3 删表改引用 |
| 命令/工具表面 | 01 §4 | 03 §6 只保留 `--self`、`memory_scope` 增量 |
| 面板配置定义 | `src/config/configs/memory.ts` 的 register 文案 | README/docs/05 只引用，不复制默认值 |
| 抽取 schema | `src/prompt/templates.ts`（现有 `SUMMARY_PROMPT_TEMPLATE`） | 03 §3.2 删 `owner/target_user_ids`，只补 `confidence`、删 `summary` |
| 模块边界 | `core/ports/memory.ts`（合并现有 `prompt/memory_source.ts` 与拟新增 `memory_work`） | 04 §4.6 改写为一个端口 |

## 10. 关键路径索引（供整改时定位）

- 方案：[01-认知层重写方案.md](test-reports/memory-audit/01-认知层重写方案.md)（§3.4/§4/§5/§6/§7）、[03-全局记忆与三层自动链路方案.md](test-reports/memory-audit/03-全局记忆与三层自动链路方案.md)（§3.2/§3.4/§6.3/§7）、[04-记忆抽取与心智模型更新时机方案.md](test-reports/memory-audit/04-记忆抽取与心智模型更新时机方案.md)（§3/§4/§6）。
- 观察双份：`src/memory/v2/consolidation.ts:129-156`、`src/memory/v2/types.ts:5`、`src/memory/v2/engine.ts:300,383-397`、`src/memory/manager.ts:227-239`、`src/memory/session_memory.ts:177-186`。
- 抽取路径：`src/agent/context_bridge.ts:128-188`、`src/context/archiver.ts:51-118,314-422`、`src/context/context.ts:683-696`、`src/memory/manager.ts:327-411`、`src/memory/v2/llm.ts:13-31,92-110`。
- 门面与死代码：`src/memory/manager.ts:286-299`、`src/memory/session_memory.ts:188-221`、`src/memory/v2/engine.ts:463-474`、`src/memory/v2/llm.ts:173-183`、`src/memory/v2/migrate.ts`。
- 配置：`src/config/configs/memory.ts:26,38,42`。
- 命令/工具：`src/cmd/sub_cmd/memory.ts:42-105,287-370`、`src/tool/tools/memory/tool_memory.ts:78-126,164-214,276-328,439-487`。
- 既有测试：`scripts/unit-test-entry.ts:3000,4882`、`scripts/unit-test-context-bridge.ts:10,59`、`scripts/test-unit.cjs` bundle 列表。
- 文档缺口：`docs/03-核心模块详解.md:202,209,214`、`docs/05-命令与配置.md:139`、`README.md:480-494,555,738`。
