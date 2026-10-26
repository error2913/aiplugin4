# 01 端到端行为链路审查（只读）

- 审查对象：`test-reports/memory-audit/00~04` 与当前仓库 `src/**`（版本 4.28.0，未提交改动未知）
- 审查方式：**静态阅读 + 符号检索**（`read`/`grep`）。按要求**未跑构建/单测/deps:check**，凡依赖运行才能断言的结论标「未验证」。
- 判定口径：**P0** = 按方案实现后链路仍不通、或文档承诺与代码行为直接冲突；**P1** = 明确缺口/口径矛盾；**P2** = 一致性/优化。
- 结论先说：**当前代码只有"AI 触发的单 bank 抽取 + 归档内同步巩固"，没有"队列/调度/跨层路由/全局 bank/MM 自动演化"**。04 的调度器与 03 的三层链路在代码中**零实现**；01/03/04 之间关于"MM 是否自动刷新""stale 如何判定""注入顺序与预算"存在 4 处硬矛盾。

---

## 1. 端到端行为图（现状，实线=已接线，虚线=方案要求但代码不存在）

```
[触发源]                                [任务]                                   [状态/持久化]
A. AI run 开始（唯一自动入口）
   agent.ts:259(runInternal 每轮请求前)
   agent.ts:536(runStreamInner 建流前)
   └─ settleBacklog(agent.ts:119-130)
       ├ consumeContextV2(context_bridge.ts:128-188)
       │   读 contextV2 事件 e:from-to（readRaw，≤200 items/轮）
       │   ├ 水位 gate：min(摘要水位,6000) tok（:131-134，实际≈6000）
       │   ├ 游标持久化 mem_cursor:<sid>{epochStart,consumed,readSeq,offset,pending}（:31-68）
       │   └ await summarizeChunkWithRetry（:179）──────────► 阻塞点①
       │        ├ aux LLM summarize_agent（manager.ts:355）
       │        ├ facts[] → engine.addMemory(verbatim)（:376-385） ──► units[cs=pending]
       │        └ engine.consolidate(bank)（:390）
       │             ├ LLM 合成观察（默认开，v2/index.ts:32；consolidation.ts:117-127）
       │             ├ observations[] + 同步 unit(factType=observation)（:129-156）
       │             ├ 90 天未验证观察**物理删除**（:27,102-115）
       │             └ pruneBank cap=100 物理淘汰（engine.ts:272,439-453）
       └ compactContextV2（摘要，与记忆无关）

B. 命令/工具（人/模型显式）
   .ai memo obs            → summarizeChunk(projection)        不刷新 MM（cmd/memory.ts:445）
   .ai memo consolidate    → MemoryManager.consolidateMemory   [gate]refresh(consolidate)（manager.ts:302-314）
   memory_consolidate      → engine.consolidate                [gate]refresh(consolidate)（tool_memory.ts:511-528）
   .ai memo mm add         → create(pending)+refresh(force,create)（cmd/memory.ts:550-568）
   mm refresh / memory_mm_refresh → refresh(force,manual)（cmd:588 / tool:674）
   reflect / memory_reflect→ engine.reflect（reflection.ts:24-93，每次必调 LLM）

C. 归档（v2 下不可达）
   archiver.ts:95/377/414 → summarizeChunkWithRetry
   但 context.ts:684-695 在 v2 一律短路返回 0/'converged' → **生产死路径**

D. 定时/空闲/启动 —— **全部不存在**
   无 agent/memory_scheduler.ts；无 mem_sched_v1；tick/reconcile/idle flush/熔断均无
   启动装配（index.ts:36-60）只 init Timer/Media/ImageGC/Knowledge，无记忆

[消费者]
注入 prompt/builder.ts:188-203
  ├ buildLongTermPrompt（manager.ts:108-224）：MM(固定模板+语义) + 群/个人 recall(tags=最近发言者+群, tagsMatch=any)
  │     └ recall 过滤 units（engine.ts:300-301 + scoring filterByTags）
  └ buildObservationPrompt（manager.ts:227-239）：观察 scope any + 90 天 + ≤20，**无预算、不看 obs on/off**
  └ ✗ 无「本体/global」段；✗ 无全局预算；✗ 无文本去重
```

**一句话**：`run 首 → 抽取 → 写事实 → 同步巩固 → 下一次注入` 这条链是通的（除标签契约 B5）；`巩固 → MM 刷新`、`无 AI 触发 → 兜底推进`、`跨 bank/全局`、`定时/重载恢复` 全部断开。

---

## 2. 节点表：上游触发 / 下游消费

| 节点 | 上游触发（代码事实） | 下游消费 | 判定 |
|---|---|---|---|
| extract（summarize_agent 抽事实） | 仅 `settleBacklog`（agent.ts:259/536）；命令 `obs`（cmd:445） | `engine.addMemory` | ✅ 通；⚠ 同步阻塞、无队列、无合批 |
| consolidate（事实→观察） | summarizeChunk 内同步调（manager.ts:390）；命令/工具 | 观察表 + 同步 unit + 注入段 | ✅ 通；⚠ 双份存储、stale 物理删 |
| consolidate_targeted（写时失效） | **无**（`op=update/delete` 被忽略：manager.ts:374） | — | ✗ 断 |
| mm_refresh（自动） | 仅 `consolidateMemory`（manager.ts:308）与工具（tool:520），受配置 gate | 注入（ready 才注入，prompt.ts:58） | ◐ 命令/工具路径通；**归档路径不通** |
| mm_full | `mm add`（force/create）、`mm refresh`（force/manual） | 同上 | ✅ 通 |
| reflect | 命令/工具/`refreshMentalModels`（mental_models.ts:354） | 返回值 + MM 答案 | ✅ 通；✗ 无快路径、basedOn 不落库 |
| reconcile / tick / idle flush | **无** | — | ✗ 断 |
| MM 模板播种 | `buildLongTermPrompt` 懒补建（manager.ts:119-124） | 生成 pending 模型 | ✗ **pending 无 owner**（见 B1） |
| 全局 bank 写入/注入 | **无**（resolveGlobalBank 全仓 0 调用） | — | ✗ 断 |

---

## 3. 三个 bank 的路由（现状）

| bank | 谁写 | 谁读 | 路由规则 | 判定 |
|---|---|---|---|---|
| 个人 `user_<sid>` | 私聊归档（manager.ts:22-25,367-370）；命令/工具（须 `--u`） | 私聊注入；**群聊注入时按最近发言者逐个召回**（manager.ts:172-215） | 按 `session.sessionType` 二选一，**无跨层** | ◐ 读有跨群；写无"群内关于某人的事实进个人库" |
| 群聊 `group_<sid>` | 群归档；命令/工具 `--g` | 仅本群注入 | 同上 | ✅ 单 bank 隔离成立 |
| 全局 `global_<agent>` | **无**（bank_resolver.ts:23-25 无调用；meta.kind 默认 global 只是标签：repository.ts:40-48） | **无**（无注入段、无 `--self`、无工具 scope） | — | ✗ 名义存在、功能为零 |

> 03 §3.3 的 `routeFacts()`（owner=user/group/bot + `src:` + `vis:` 标签 + 多 bank 写）在代码中不存在；现有 `summarizeChunk` 只写当前会话 bank，且 `fact.memory_type/target_id/related_*` 全部丢弃（manager.ts:372-386），与 03 §1.1 描述一致。

---

## 4. pending / 失败 / 重载恢复矩阵（现状）

| pending 类型 | 存放 | 唯一推进者 | 无后续 AI 触发时 | 重载后 |
|---|---|---|---|---|
| 已读未抽原文 | `mem_cursor:<sid>.pending`（context_bridge.ts:31-68） | 下一次 `consumeContextV2`（仅 AI run） | **永久滞留**（不丢） | ✅ 可恢复（游标含 pending） |
| 事实 `consolidationState=pending` | bank `units` 分片（engine.ts:217） | 下一次 summarizeChunk 内 consolidate；命令/工具 | **永久滞留**（无扫描者） | 状态在，无扫描者 |
| MM `status=pending`（模板播种） | bank `obs` 分片 | 仅 `consolidateMemory`（命令/工具）内的 refresh | **永久 pending，永不注入** | 同左 |
| MM `status=failed` | 同上 + `lastFailedAt` | 冷却后仍需命令/工具触发 | 永久 failed | 同左 |
| 后台 job | **不存在**（无 `mem_sched_v1`） | — | — | 04 §4.3"job 保持 pending/attempts"无落点 |

失败行为（现状）：桥抽取失败 = **立即 3 次同步重试**（manager.ts:403-411，无退避、无熔断）；事实已写但 consolidate 失败 = 记日志后 `return true` 并推进水位（manager.ts:392-395）→ 事实留 pending 等下一次；观察合成失败 = 直接拼接（consolidation.ts:117-127），无标记、无重试；MM 刷新失败 = `failed` + 冷却（mental_models.ts:310-313，冷却取 `refreshMinIntervalSec` 或 1800s）；单飞锁 `refreshingBanks` 命中时**直接返回空 summary**（:251）而非 04 §3.4 要求的"合并为标记、完成后再跑一次"。

---

## 5. 断点清单（11 处：P0×5 / P1×6）

### P0 级

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| **B1** | `consolidate → MM 刷新` 在归档/桥路径缺失，模板 pending 无生命周期归属 | manager.ts:388-394（只 consolidate，无 refresh）vs 302-314（命令/工具才 refresh）；mental_models.ts:217-224（有源才播种、`answer=''`→pending）、152；prompt.ts:58（只注入 ready） | 默认配置下，正常聊天产生的"内置心智模型"永远停留在"生成中…"，用户 `.ai memo mm list` 能看到却永不生效；01 §9"巩固后刷新"与 03 §8 验收"归档后自动刷新"均不成立 |
| **B2** | 自动记忆 LLM 在回复关键路径上被 `await` | agent.ts:259（请求前）与 536（建流前）；context_bridge.ts:179；manager.ts:355+390；v2/index.ts:32（观察合成默认开） | 与 04 设计约束①"任何后台记忆 LLM 都不在回复路径"直接冲突：抽取 1 次 + 每簇 1 次观察 LLM 都计入本轮延迟；模型慢时用户可见卡顿 |
| **B3** | 无调度器/队列/reconcile/启动装配 → 三类 pending 无兜底推进者 | 全仓无 `agent/memory_scheduler.ts`；consolidate 调用点仅 manager.ts:305/390、cmd:459、tool:516；index.ts:36-60 无记忆装配；04 §4.3/§5F 的"重载恢复"无存储键 | "无 AI 触发不烧 token"成立，但代价是"AI 停了工作也停了"；04 §7 验收"重载后 pending 最终处理"**当前不可能通过** |
| **B4** | 默认值三方互斥（MM 自动刷新） | 04 §0/§3.4/§6="默认关、min interval 0、对齐 Hindsight"；代码 config/configs/memory.ts:21=`true`、:22=30 分钟；03 §3.4+§8="归档后自动刷新（受间隔限制）"并列为验收项 | 按 04 实现则 03 验收失败；按 03 实现则 04"完全对齐"失效；现状又有一半（命令/工具生效、归档不生效）——必须先定一个默认值并写迁移 |
| **B5** | 写入标签契约断裂（R1）：写入不带 scope tag → 注入永远看不见 | manager.ts:265-269 与 session_memory.ts:97-102（tags 只来自 related_*/kws/vis）；注入 recall 先按 tags 过滤（manager.ts:116,125-130；engine.ts:301；scoring `filterByTags`）；对照 `memory_recall` 工具不传 tags（tool_memory.ts:326→session_memory.ts:118-123） | `.ai memo add` / `memory_add` / 媒体入库的默认写入**列表可见、注入不可见**；且 `memory_recall` 能查到 → 用户与模型都无法自诊。这是当前"打通"唯一的硬断点，01 §3.1 已给出修法 |

### P1 级

| # | 断点 | 证据 | 影响 |
|---|---|---|---|
| **B6** | 全局 bank 全链路 0 入口 | bank_resolver.ts:23-25 无调用；manager.ts:22-25 只 user/group；无 `--self`（cmd/memory.ts:197 子命令表无 self）；无全局注入段（builder.ts:188-203 只有两段） | 03 的核心新增（本体记忆/`self_rules`/`self_experience`）100% 未接线；03 自己已承认，但 03 §8 P3 阶段之外仍需补"路由 + 注入 + 命令 + 配置"四项 |
| **B7** | 跨 bank 路由 0 实现 | manager.ts:367-386 只写当前 bank；`fact.memory_type/target_id` 丢弃（:374 单行 `continue`） | 03 §8 验收"群聊里说 A 喜欢猫 → A 的个人 bank"当前不可能；`op=update/delete/noop` 全部未接线（update 当新增） |
| **B8** | reflect 无快路径，且与注入选择器不同源 | reflection.ts:42-61（无条件全量 MM+观察+事实，无 score、无 staleness）；engine.ts:536-568 `searchMentalModels` **只返回模型、不返回分数**；注入选择器是"模板优先+语义"（manager.ts:141-152） | 01 §3.5 的 `score(m)>=0.5 && !isStale(m)` 无 API 支撑，需先扩签名；若快路径与注入各写一套排序，同一条模型"能注入但 reflect 不命中"，正是 00 批评的"两套口径" |
| **B9** | 观察层双份 + stale 物理删 + 注入不看开关 | consolidation.ts:27,102-115（删）、129-156（同步 unit）；manager.ts:227-239（独立注入段，不看 `summaryOverride`）；prompt.ts:135 注释仍写"由独立 buildObservationPrompt 注入" | 观察一次出现两处；`.ai memo obs off` 装饰性（I5 未修）；注入无预算（I1）；`obs clr` 不重置源事实标记（O1 未修） |
| **B10** | 失败/熔断/重载恢复无支撑 | 无熔断（04 §3.3/§6 的"连续 3 次暂停 30min"无实现）；桥重试无退避（manager.ts:403-411 vs 04 §6 的 1s→60s）；单飞是"丢弃"（mental_models.ts:251） | 模型不可用时每轮烧 3 次；04 §7 验收"熔断生效"无法通过 |
| **B11** | 归档路径在 v2 是死代码，且 `context_too_long` 兜底失效 | context.ts:684-695（v2 下 settle/trim/archive 全部短路）；agent.ts:416 仍按返回值判定，`'converged'` → `handled.archived=true` 后再失败即 `giveup` | 04 §4.6 为"旧回退"新建 L0 端口 + 改 archiver 的收益接近 0（只需保留静态守卫）；同时暴露一个与记忆无关但严重的既有行为缺陷（超长兜底空转） |

---

## 6. 文档间矛盾（D1–D9）

| # | 矛盾 | 双方原文/位置 | 建议裁决 |
|---|---|---|---|
| **D1** | MM 是否随巩固自动刷新 | 04 §3.4/§6：默认关、min 0；03 §3.4+§8 验收：归档后自动刷新；01 §9：默认不自动刷新但"开启后受间隔" | 以 04 为准（对齐 Hindsight），则 03 §8 验收句必须改写，并在 01 §8 增加"默认值迁移（true→false）"步骤 |
| **D2** | 触发源清单 | 03 §2/§3.5：仅归档结算+手动，tick 只扫元数据、"**不新增定时 LLM 任务**"；04 §3.2 增加"轮末 + 兜底有界抽取"、§4.4 增加"空闲 flush" | 合并为一张"触发源表"，明确 idle flush 是否算"定时 LLM" |
| **D3** | 观察 stale 口径 | 01 §3.3：90 天 `lastSupportedAt` 惰性降级；代码 prompt.ts:5（90 天）+ consolidation.ts:27（物理删）；04 §3.3/§0：0/<10/≥10 backlog 且称"完全对齐" | 二选一。若採 backlog，则 01 §3.3 的 `OBSERVATION_STALE_DAYS` 与 03 §4.4"stale 不注入"都要改 |
| **D4** | 注入顺序/预算 | 01 §3.6：先模型/观察、后事实，全局 3000 tok；03 §5.2：本体→会话→事实、全局段 300 tok、"不足时优先保会话记忆"；03 §4.4：本体 facts≤5/400 字 + MM≤2/400 字 + obs≤3 | 300 tok 与"400 字×3 类"不自洽（中文约 1 tok≈1.5–2 字）；且"本体在前"与"优先保会话"冲突 |
| **D5** | 空闲语义 | 04 §3.6 门6：待机/空闲"暂停自动任务、空闲期零成本"；04 §4.4：空闲 flush"静默 5min 且有 pending → 排 consolidate" | 明确"待机暂停"是停止扫描还是禁止 LLM；否则两句话互相取消 |
| **D6** | 调度器位置与代码预算 | 01 §8 引用 `agent/memory_scheduler.ts`+`core/ports/memory_work`；01 §7 的 16 文件预算表**未列**两者（04 自估 scheduler≈250 行） | "净减 350 行"与 01 §9"生产代码净减"验收不成立，预算表需补 2~3 项 |
| **D7** | 可见性标签命名 | 01 §3.1 代码片段：`vis:private:${scopeOf(bank)}`；03 §5.1/§7.3：`vis:public|vis:origin:<scopeId>|vis:owner` 并称"取消 private" | 统一为 03 的模型；01 §3.1/§3.6 需同步改写（否则 P0 止血会写出第二套标签） |
| **D8** | 观察注入入口 | 01 §6"删除 `buildObservationPrompt` 双入口"（单渲染器）；03 §5.2 仍描述"观察段/每段带归属行"的独立渲染；代码 manager.ts:227 + prompt.ts:135 注释 | 以 01 为准（并入单渲染器），03 §5.2 改为引用 01 §3.6 |
| **D9** | 全局 bank 命名 | 03 §4.1/§7.3：`global_<agentName>`，`*` 归一 `main`；03 §1.3 承认现状 `safeId('*')='_'`→ `global__` | 补一条显式迁移（`global__`→`global_main`）+ 保留别名读，否则历史数据成孤儿 |

---

## 7. 代码支撑性核验（方案引用 vs 真实钩子）

| 方案引用 | 代码事实 | 是否够用 |
|---|---|---|
| 04 §4.4「轮末 = `agent.ts:189-203` / `500-514` 的 `finally`」 | 两处 finally 只有：activeRuns 递减、`running` 归零、release 限流、`resumePending`、`wakePendingNotices`（agent.ts:189-203, 500-514）；**无任何记忆调用** | 行号准确、可作插入点；但 ①`acquired=false` 时也进入 finally，必须加守卫；②"轮末"时回复已在 runInternal 内发出，此处 `await` 任何 LLM 都会拖住 pipeline 返回 |
| 04 §4.4「上下文结算 = consumeContextV2」 | 真实存在，但调用点是**每轮请求前**（agent.ts:259/536），且内部 `await` 抽取+巩固 | 位置存在、语义是"轮首"不是"轮末"；改造需把 `await` 去掉或只推进游标 |
| 04 §3.2「mem_cursor + 水位」 | 游标含 `pending` 文本并持久化（context_bridge.ts:31-68）；水位=min(摘要水位,6000)（:131-134） | 够用；但**没有 job/队列**，成功后无 enqueue 点 |
| 04 §3.2「结算水位」 | 生产配置「摘要水位」默认 6000（config/context.ts:13）；legacy `SETTLE_*` 从**未注册旧键**读取并 try/catch 归 0（:20-33,47-50）→ `settleWindowIfNeeded` 首行即 `watermark<=0` 返回 | 文档所指"结算水位"在 v2 实为"摘要水位"复用，需在方案里改名，否则实现者会去改 legacy 键 |
| 04 §4.2「后台让路：检测到用户 run 在请求模型」 | `session.running` 是运行时字段（agent.ts:170/181/193；persistence.ts SESSION_RUNTIME_KEYS） | 进程内够用；但从 bankId 回到 session 需 `getSessionById`（core/ports/session_lookup.ts:10-12），它会 `revive(Session)` + `ContextService.openSync`（session_service.ts:44+）→ tick 逐个 bank 调用成本高 |
| 04 §4.1「写穿持久化，仿 TimerManager」 | TimerManager：单键 `timerQueue` 持久化（timer.ts:68-70）、`setTimeout` 链、**队列空即停止**（:404-410）、`init()` 挂装配（:421） | 模式可复用；"不复用其队列"的判断正确 |
| 04 §4.3「reconcile 扫元数据、扫描 banks」；§4.5 status 显示 pending 数 | 存储层：`MemoryStorage{getBank,saveBank,deleteBank}`（storage.ts:17-21）**无枚举**；`HostStorage{get,set}`（core/host.ts:8-11）**无 key 列表**；`saveBank` 恒写 5 分片（:83-89，与 :28 注释不符） | ❌ **不足**：没有 bank 索引就无法"扫元数据补 job/统计 pending"。必须新增索引键（如 `mem_sched_v1:banks` 或 job 表自带 bank 清单），方案未写 |
| 04 §4.4「插件启动 index.ts」 | index.ts:36-60：`TimerManager.init()` 有先例，但**无记忆/调度器初始化**；引擎是首用惰性单例（v2/index.ts:47-52） | 缺装配点（可照 TimerManager 加一行）；注意惰性单例导致 `createMemoryEngine` 只在首用读配置（00 I7） |
| 04 §3.4「只刷新 tag 与 touchedTags 重叠的模型」 | `refreshMentalModels(bankId, id?, {force,reason})` **无 touchedTags 参数**，未给 id 即遍历 bank 全部模型（mental_models.ts:258） | ❌ 签名不够：需新增参数或调用方预过滤，否则"tag 重叠"失效（只能靠 per-model 的 `auto_off` + watermark 间接收敛） |
| 01 §3.5「快路径 `score>=0.5`」 | `searchMentalModels` 返回 `MentalModel[]`，分数在函数内部丢弃（engine.ts:555-567） | ❌ 需改签名返回 score（或新增 `searchMentalModelsScored`） |
| 01 §3.6「全局预算 3000 tok」 | `buildMemoryPrompt` 不存在；现状无预算（manager.ts:33-54 各段独立上限；观察段无上限） | 需新写，属 01 §3.6 范围内，OK |
| 01 §4.2「反馈 `obs off` 真正生效」 | `summaryOverride` 仅被 status 读取（cmd/memory.ts:235-236,380-388），注入与生成都不读 | ❌ 需接线（与 B9 同） |
| 04 §4.6「deps:check 基线 13 违规」 | 层规则：memory=L2、agent/context=L3（deps.mjs:121-125）→ **`context→memory` 不会被 deps:check 判违规**（低层不被高层 import 才违规） | 结论正确：必须加静态守卫；但"基线 13"未验证（未跑 deps:check） |
| 01 §7/§10「记忆无单测」 | 实际存在 `scripts/unit-test-context-bridge.ts` 且注册在 test-unit.cjs（`contextBridge`），覆盖游标/失败不推进/重载幂等 | 00 I8 表述过时；缺的是 consolidate/MM/注入的测试，不是"零测试" |

---

## 8. 必须修正项

### P0（建议在动工前先改方案，否则实现必返工）

| 项 | 内容 | 证据 |
|---|---|---|
| **P0-1** | **补"巩固→MM"的触发归属，并给模板 pending 指定 owner**：`summarizeChunk` 成功后按 04 §3.4 的 gate 调 `refreshMentalModels(reason:'consolidate')`；模板播种要么"建即入队 mm_refresh"，要么明确"首次注入前同步生成一次"。同时在 03/04 中二选一定义默认值（B4、D1） | manager.ts:388-394 vs 302-314；mental_models.ts:217-224,152；prompt.ts:58 |
| **P0-2** | **把自动记忆 LLM 移出回复路径**：`consumeContextV2` 只做"读 + 入队"，抽取/巩固交给队列；若暂不建队列，至少把 `engine.consolidate` 从 `summarizeChunk` 中剥离为独立步骤。方案需改写 04 §3.2 的"轮末 finally"为"轮末 enqueue"，并承认现状是轮首同步 | agent.ts:259/536；context_bridge.ts:179；manager.ts:355,390；v2/index.ts:32 |
| **P0-3** | **调度器/队列的存储与枚举方案补全**：新增 bank 索引键或 job 自带 bank 清单（当前 MemoryStorage/HostStorage 无枚举能力），并写清三类 pending 的 reconcile 入口（事实 pending / MM pending / 游标 pending）。同时把 scheduler 与 port 纳入 01 §7 预算表 | storage.ts:17-21；core/host.ts:8-11；index.ts:36-60；01 §7（:421-442）vs 01 §8（:463） |
| **P0-4** | **统一可见性/tag 模型**（D7 + B5）：以 03 §7.3 为唯一口径（`user:|group:|global:|vis:public|vis:origin:<sid>|vis:owner|src:|kw:`），改写 01 §3.1 片段；写入侧由服务层强制注入 scope tag；保留前缀拒绝外部伪造 | 01 §3.1（:158-168）；03 §7.3（:352-373）；manager.ts:265-269；session_memory.ts:97-102 |
| **P0-5** | **统一 stale 定义并同步三份文档 + 代码删除策略**（D3）：若对齐 Hindsight 则改 01 §3.3、prompt.ts:5、consolidation.ts:27（不再物理删）；若保留 90 天则 04 §3.3/§0 的"完全对齐"要删 | 01 §3.3（:229-232）；04 §3.3（:163-167）；prompt.ts:5；consolidation.ts:27,102-115 |

### P1

| 项 | 内容 | 证据 |
|---|---|---|
| **P1-1** | 把「archiver 端口化」降级：v2 下 archiver 不可达，只需保留静态守卫（`src/context/**` 不 import memory、不访问 `.memory.`；`context/roster.ts:98` 的 `findImage` 死调用顺手删）；同时另立一条工单修 `context_too_long` 在 v2 的空转（agent.ts:416 + context.ts:693-695） | context.ts:684-695；archiver.ts:95,377,414；roster.ts:98 |
| **P1-2** | reflect 快路径所需的 **score API + 统一 selector**：给 `searchMentalModels` 返回 score，把"注入选择"与"快路径命中"共用同一函数，避免两套排序 | engine.ts:536-568；manager.ts:141-152；01 §3.5（:277-281） |
| **P1-3** | `refreshMentalModels` 增 `touchedTags`/`onlyIds` 参数（04 §3.4 的 tag 重叠依赖它） | mental_models.ts:244-258 |
| **P1-4** | 明确"单飞"语义：当前 running 命中即丢弃（:251），04 要求"合并为标记、完成后仍需则再跑" | mental_models.ts:250-252；04 §3.4（:186） |
| **P1-5** | 全局 bank：补 `--self` 权限、注入小节、配置开关、`global__`→`global_main` 迁移（D9），并写明"仅 record 层 0 调用的现状" | bank_resolver.ts:10-12,23-25；03 §4.1 |
| **P1-6** | 写时失效语义（`op=update/delete`、`state='invalidated'`、`supersedes`）在 01/03 都有，但代码 0 实现；方案需把它标为 **P3 未实现**，避免验收误判为"方案未覆盖" | manager.ts:372-386；types.ts（state 定义）；03 §3.4 |
| **P1-7** | 桥重试加退避/熔断（或明确"桥只重试 1 次，交给调度器退避"），与 04 §6 参数对齐；同时修 00 I8 表述（保留 bridge 测试，补 engine 测试） | manager.ts:403-411；04 §6（:393-395）；scripts/unit-test-context-bridge.ts |
| **P1-8** | `status` 的注入估算、`list` 的观察 unit 混入（U3/U4）仍用旧口径，01 §4.1 已计划改为共用选择函数——把它写进 P1 验收（否则改完仍是两套） | cmd/memory.ts:235-248,274 |

---

## 9. 可选优化（P2）

1. 用 `ContextService.onAppended`（context/service.ts:189-201，现无人订阅）替代"轮首 settle"：天然事件驱动、可去抖，且不阻塞回复（直接解决 P0-2 的一半）。
2. tick/reconcile 只读索引键，不 `getSessionById` 物化会话；需要"忙检测"时用 `session.running` 的内存表，而不是重新 revive。
3. 观察段并入单渲染器时统一预算（现在 group 2048 + 每用户 1024×3 + 观察 20 条无上限，组合 prompt 曾实测≈13.3k tok）。
4. `saveBank` 恒写 5 分片与 `storage.ts:28` 注释不符（00 R4）：要么按分片脏标记，要么改注释。
5. 把 legacy 路径的去留写成显式决策（`context.ts:684-695`、`archiver.ts` 三处调用、`Config.context` 的 legacy 键），否则半年后无法判断"改 archiver 是否还有意义"。
6. `MEMORY_MM_TICK_INTERVAL`（config:26）与 `getLastAutoRefreshAt`（engine.ts:134）已是死配置/死方法：01 §6 已列删除，建议连同 `'tick'` 原因字符串（types.ts:285）一起删，避免新调度器"看起来已接线"。

---

## 10. 未验证 / 留给实现前的确认

1. `npm run deps:check` 的"基线 13 个违规"未运行验证（按要求不跑构建）；层规则本身已确认 `context→memory` 不属违规。
2. 是否有未提交的本地改动影响上述行号（按当前工作区读取）。
3. `ExtInfo.storage.get` 对未注册键的行为（抛错 vs 返回 null）决定 legacy `SETTLE_*` 是否恒 0；两种情况下 v2 都已不走该路径，不影响结论。
4. 真实 QQ 环境下"内置模板多久变 ready"仍建议做一次端到端观测（默认配置 + 正常聊天 20 轮），以确认 B1 的严重度。

---

## 11. 给 lead 的三句话

1. **通的一条**：run → 桥 → 抽取 → 事实 → 同步巩固 → 下一轮注入（含群聊按最近发言者读个人 bank），骨架真实存在。
2. **断的十一条**：最伤的是 B1（模板 MM 永不 ready）、B2（抽取/观察 LLM 挡在回复前）、B3（无调度器 → pending 永远等下一个 AI 触发）。
3. **文档层面**：D1/D3/D6/D7 四处矛盾会让实现者各做一套，建议先改文档再动代码。
