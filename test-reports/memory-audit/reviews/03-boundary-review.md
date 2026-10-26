# 记忆方案边界 / 可行性审查（03-boundary-review）

- 审查对象：`01-认知层重写方案.md`、`03-全局记忆与三层自动链路方案.md`、`04-记忆抽取与心智模型更新时机方案.md`（重点 04 §3.6 / §4.1 / §4.4 / §4.6）
- 审查范围：上下文解耦、调度器可实现性、失败边界、隐私安全、v2→v3 迁移、文档行号/钩子准确性
- 方法：只读通读源码 + `npm run deps:check`（只读，esbuild `write:false`）；**未修改任何 src/docs**
- 基线：`deps:check` 当前 **模块 358 / 边 1152 / 跨层违规 13 / maxCycle 0**；基线文件 332 / 1076 / 13（基线滞后于当前树，但 ratchet 只拦"退化"，结论仍有效）

## 0. 结论先行

| # | 主题 | 结论 | 一句话理由 |
|---|---|---|---|
| 1 | `context/archiver` 直接 import memory 是问题 | **需改（低优先级）** | 违反分层契约，但按 ratchet 规则 L3→L2 不算违规；且该路径只在 `contextV2===null` 的降级会话可达 |
| 2 | `context/roster` 的 `session.memory.findImage` | **可行（更简单）** | 该调用恒返回 null（`session_memory.ts:215-217`）；`Image.resolveRef` 已包含 `Image.get`，直接删行即可 |
| 3 | L0 `core/ports/memory_work` 端口 | **需改** | 依赖方向/注册可行，但布尔"成功"语义与"不阻塞归档"直接冲突；缺 tri-state、缺无口默认、缺禁止 import 约束 |
| 4 | scheduler 放 agent 层 | **可行** | 不新增违规；但"放 memory 层会新增跨层依赖"不是硬约束（可用 L0 `session_lookup` + type-only） |
| 5 | `deps:check` 不新增违规 | **可行（有条件）** | 端口零 import + 调度器不向上依赖即不新增；但**移除 archiver→memory 不会让 13 变 12** |
| 6 | 持久化队列/状态选址 | **需改** | 原文进 job payload 会造成双源 + 叠加式 storageSet 膨胀；single `mem_cursor` 才是 pending 唯一事实源 |
| 7 | tick 生命周期（空停/启动/重载） | **可行** | `TimerManager` 已有同款模式可复用；需 enqueue 唤醒 + `tick(now)` 注入口 |
| 8 | 并发/让路（在线优先） | **按文档实现=不可行** | `requestLimiter.acquire` 是 FIFO 无优先级，后台排队会插到用户请求前面；必须改为"探测 active===0，不排队" |
| 9 | 无 AI 触发门 | **需改** | 仓库没有"AI 已触发"载体；finally 钩子有 `starting`/`resumePending`/headless 三个坑 |
| 10 | 失败/边界状态机 | **需改** | 文档只有 retry+熔断，缺 dropped/degraded/backoff/reload 清锁/purge/bank 删除 |
| 11 | 隐私/安全 | **需改→部分不可行** | 保留前缀可伪造、`memory_add` 可指定他人 target、`meta.kind` 默认 global、全局自动抽取默认开 |
| 12 | v2→v3 迁移 | **需改** | `schemaVersion`、惰性迁移、备份键在仓库中**都不存在**；5 分片写入非原子，无回滚路径 |
| 13 | 文档行号/钩子准确性 | **大部分准确，5 处硬伤** | 见 §7：默认值、schemaVersion、迁移设施、deps 结论、'tick' 行号 |

---

## 1. 上下文解耦审查

### 1.1 现状是否"真问题"

| 位置 | 实情 | 判定 |
|---|---|---|
| `context/archiver.ts:6,95,377,414` | 确为直接 import + 3 处静态调用 | 契约问题成立；但**只在 V2 上下文初始化失败时可达**：`Context.settleWindowIfNeeded`/`archiveByTokenIfNeeded` 在 `v2Service` 存在时直接短路（`context.ts:684,694`），`agent.settleBacklog` 也只有 `!contextV2` 才走旧路径（`agent.ts:121-126`） |
| `context/roster.ts:98` | `host.session.memory.findImage(id)`；`SessionMemoryService.findImage` 恒 `return null`（`session_memory.ts:215-217`） | 死调用成立；且 `Image.resolveRef(id)`（`roster.ts:92`）内部已 `get(parsed.id)`（`image.ts:566`），补 `Image.get` 是冗余 |

**结论**：两处都是真实契约问题，但**不是当前线上功能问题**；修它们的收益是"防止 context 因记忆可选功能加分支"，不是修 bug。这直接影响投入优先级：不值得为一条近乎不可达的降级路径引入新端口 + 注册 + 测试桩 + 静态守卫。

### 1.2 L0 端口方案可行性

| 维度 | 评估 | 说明 |
|---|---|---|
| 依赖方向 | ✅ 可行 | `core/**` 在 `deps.mjs:LAYER_RULES` 中是 L0；context(L3)→port(L0) 合法；port 实现放 `agent`(L3)、`memory`(L2) 或 `index`(L4) 均合法 |
| 端口零依赖 | ⚠️ 必须遵守 | 若端口文件 `import` `Session`/`MemoryUnit`/`memory/**`，会立刻成为**新增**跨层违规（L0→L2/L3），`deps:check` 失败。类型只能内联为原始字段（现方案已是） |
| 注册时机 | ✅ 可行 | `index.ts:32-45` 顺序：`setHost` → `installAuxLlm` → `Config.registerConfig`；端口注册应紧随 `installAuxLlm`，早于任何 `agent.run`/归档 |
| 未注册时语义 | ❌ 方案缺失 | 现有端口两种先例：`aux_llm.getAuxLlm()` 抛错、`judge_wait/media_notice` 静默跳过。archiver 必须在"无口"时视为**成功跳过**（否则 `settledSeq` 永不推进、退避无限重试） |
| 放 agent 层 | ✅ 可行、非必需 | scheduler 需要 `session.running`/`requestLimiter`/`getSessionById`；放 memory 层用 L0 `session_lookup` + type-only `Session` 同样零违规。文档"避免新增跨层依赖"是**理由不充分**，真正理由是"记忆可选、调度属编排" |
| 测试注入 | ⚠️ 需同步 | `scripts/test-host.ts` 目前没有记忆端口；sim/fuzz/sim-matrix/2 个 unit 入口共 5 处**猴补 `MemoryManager.summarizeChunkWithRetry`**（`sim-entry.ts:75-77`、`sim-matrix-entry.ts:75-76`、`fuzz-entry.ts:78`、`unit-test-context-bridge.ts:59-91`、`unit-test-entry.ts:1176-1237`）。端口实现若在注册时**捕获**静态方法引用，这些桩全部失效（fuzz 会打真网） |

### 1.3 更简单 / 更少代码的替代

| 方案 | 改动量 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| A. 直接删除 archiver 的 3 处记忆调用 | ~5 行 | 零新模块；降级会话不沉淀记忆 | 降级模式功能缩水（但本就几乎不可达） | 若接受降级不沉淀，**A 最优** |
| B. `ArchiveHost` 增加可选回调 `summarize?`，由 `Context`/`Session` 注入 | ~15 行 | 无全局可变单例、无注册顺序问题、测试直接给函数 | 静态守卫无法表达"不 import memory"（但可扫 `.memory.`） | **推荐折中** |
| C. L0 端口（文档方案） | 新文件 + 注册 + test-host + 守卫测试 ≈ 60-80 行 | 与 `aux_llm`/`memory_source` 一致；可静态守卫 | 布尔语义坑（见下）、无口默认、测试桩迁移 | 仅当 P0 要"context 永不 import memory"时采用 |

**同步语义缺陷（关键）**：端口注释写"返回是否成功入账（成功才推进 settledSeq）"，但布尔把三种情况压成两种：
- 抽取成功 → `true`（推进）
- 记忆关闭/未配置/端口未注册 → **应为 true（推进，否则死循环）**
- LLM/存储失败 → `false`（不推进，退避）
若 scheduler 入队后立即返回 `true`，则"入队成功 ≠ 抽取成功"，`settledSeq` 已推进而原文分片可能被后续清理（`archiver.ts:161-172` 的 `clearShard` **不看 settledSeq**）→ **静默丢数据**。因此端口必须是 `'done' | 'skipped' | 'failed'` 三态，且 `skipped` 与 `failed` 的推进语义不同。

### 1.4 `deps:check` 是否真的不新增

- 现状 13 条违规中**不含** `src/context/archiver.ts -> src/memory/manager.ts`（L3→L2 是下行，规则只拦"低层 import 高层"，`deps.mjs:findLayerViolations`）。所以 04 §4.6 用它当"解耦收益"的论据不成立；移除它**不会**把 13 降到 12。
- 新增 `src/core/ports/memory_work.ts`（L0、零 import）+ `src/agent/memory_scheduler.ts`（L3→L2）**不会**新增违规/环/动态 import；`scripts/lib/deps.mjs` 只从 `src/index.ts` 建图，因此调度器/端口必须被 `index.ts` 可达，否则测试/守卫覆盖不到。
- 注意基线 332/1076 与当前 358/1152 不一致：`deps:check` 目前是"只拦退化"的 ratchet，**基线过期不报错**；不代表"当前已冻结"。

---

## 2. 调度器可实现性

### 2.1 运行时能力（SealDice goja）

| 能力 | 结论 | 证据 |
|---|---|---|
| 无 Worker | ✅ 文档正确 | 全仓无 `Worker` 使用 |
| `setTimeout`/`setInterval` 可用 | ✅ | `timer.ts:410`、`image_gc.ts:259-261`、`image_host.ts:59`（注释明确"goja 里 setTimeout 也是数字 id"） |
| 无假时钟/假定时器设施 | ⚠️ 需自建 | 单测 runner 无 sinon/fake timers；`engine.ts` 大量用 `Date.now()`。调度器必须暴露 `tick(now)` 纯函数口，测试直接调，不依赖真实等待 |
| LLM 请求超时 | ✅ 已有 | `Config.base.TIMEOUT` 默认 180s（`configs/base.ts:8`），`provider.ts:120` 用 `withTimeout` 包裹 |
| LLM 重试/退避 | ❌ 仓库没有 | 记忆路径只有 `summarizeChunkWithRetry` 的 3 次**无延迟**重试（`manager.ts:403-411`）；scheduler 的 1s→60s 需新写 |

### 2.2 持久化选址

| 方案 | 可行性 | 问题 |
|---|---|---|
| 新 storage key `mem_sched_v1` | ✅ 首选 | 与 `timerQueue` 一致；**必须 catch 读异常**（`storageGet` 缺 key 在真实海豹可能抛错，`archive_store.ts:455-457` 有先例注释）；`storageSet` 是叠加式（`archive_store.ts:6-8`），整队列频繁重写会膨胀 |
| bank `meta.settings` | ✅ 用于游标 | `lastRefreshAt` 目前只在内存 Map（`mental_models.ts:45`），重载丢失；放 `meta.settings` 可行且 meta 分片很小；`nextFactSeq/pendingCount` 也适合 |
| Session 字段 | ⚠️ 不推荐 | session 存档每次 `save()` 重写，且无"删除会话"API |
| `mem_cursor:<sid>` | ✅ 已存在 | 已持久化 `pending` 原文（上限 120k 字符，`context_bridge.ts:120`）。**应作为 pending 唯一事实源**，job 只存 `{sessionId, cursorVersion}` |

**结论**：job payload **不要存原文**。理由：① 双源不一致；② 原文再写一份进 storage 违反"purge/clear 可清除"的隐私预期；③ 叠加式写入放大；④ 120k 字符 × 队列 200 = 巨大 key。代价是：若分片被 `SHARD_LIMIT/TTL` 清掉，job 无法重放——但 V2 路径的 pending 在 `mem_cursor` 里，不受分片清理影响；旧路径（`archiver.settleWindowIfNeeded`）应保持同步语义、不进队列。

### 2.3 tick 生命周期

- 启动点：`index.ts:43-54`（`installAuxLlm` 之后、`Config.registerConfig` 前后均可，建议紧随 `installAuxLlm`）；测试由 `test-host.ts` 注册但**不自动 start**，避免 boot 测试挂起。
- 空队列停止：复用 `TimerManager.executeTask` 模式（`timer.ts:403-411`）；但 `enqueue` 必须显式 `ensureRunning()`（`TimerManager.add*` 均如此），否则任务永远不跑。
- 重载：加载时 `running` 字段必须**重置为 null**（持久化的运行锁是脏锁），并把该 job 视为 `queued`、`attempts+1`；文档未提，这是必改点。
- tick 只读元数据：**当前不成立**——要判断"有无 pending"必须 `repository.getBank()`，会解析 units/links/obs 三个大分片。需在 bank `meta.settings` 增加 `pendingFactCount`/`nextFactSeq`，否则"0 LLM 但 O(全库 JSON)"。

### 2.4 并发 / 让路

| 需求 | 文档写法 | 实际可实现性 |
|---|---|---|
| 后台并发 1 | `running` 单字段 | ✅ |
| 同 bank 单飞 | in-memory 锁 | ✅（`engine.consolidate` 已有 `consolidatingBanks`，`mental_models` 已有 `refreshingBanks`） |
| 在线优先 | "后台 job 开始前检测用户 run，延后 5s" | ⚠️ 可实现：`session.running/starting`、`requestLimiter.getQueueInfo().active/queued` 都是现成信号 |
| 用 `requestLimiter` 抢槽 | 未明说但暗示 | ❌ **不可行**：`acquire` 是全局 FIFO（`concurrency.ts:21-40`），后台请求会排在用户请求前面；`release` 还会把槽"转让"给排队者，后台占槽会直接推迟用户回复。正确做法：后台**不 acquire**，只在 `getQueueInfo().active === 0 && queued === 0` 时执行；否则 `notBefore = now + 5s`，累计让路上限 10min 后强制跑（避免饿死） |
| 用户命令插队 | `runNow` 不进队列 | ✅；但需与后台同 bank 锁互斥，否则双跑（见 4.3） |

### 2.5 无 AI 触发门

- **没有载体**：`session.running` 只在 run 期间为真；`lastRelevantAt` 由 `session.chat` 设置（`session.ts:386`），定时器/主动触发也算，不能区分"AI 已回复"。
- 钩子位置坑：`agent.ts:189-203` / `500-514` 在 `finally` 内，此时 `session.starting` 仍为 `true`（171 置位、198 清除），且 `await resumePending()`（196）会在其中再调 `session.chat`（`resumePending` 在 `starting=true` 时会因 `agent.ts:170` 的闸门直接返回）。因此：
  - 不能在 finally 里直接判"会话空闲"；
  - 不能在 finally 里同步做重活（会延长并发槽释放时间）；
  - 需在 `runInternal` 拿到首个成功响应后置一个 `session.aiTriggeredAt/lastAiSeq`（内存 + 持久化），finally 只做"若 marker 新鲜则 enqueue"。
- 必排：`session.headless || session.subagentDepth > 0`（子代理会话，`child.ts:77-82`），否则子代理每轮都触发主会话记忆抽取。
- standby：`pipeline/events.ts:181-184` 是"待机才入库事件"；与 04 §3.6 门 6"待机暂停自动任务"叠加后会产生"AI 触发过 → 转待机 → job 永远不跑"的卡死。需定义：source=ai 的 job 不受待机暂停，或设最大延迟后丢弃并记日志。文档内部（§3.6 门 1 vs 门 6）自相矛盾。

### 2.6 与现有 L1/L2 接线的冲突（必须改）

| 冲突 | 证据 | 后果 |
|---|---|---|
| L1 抽取在**回复关键路径** | `agent.ts:259,536` 在构建请求前 `await settleBacklog` → `consumeContextV2` → `summarizeChunkWithRetry`（3 次 × 180s 超时） | 最坏 ~9min 不回复；文档"不阻塞"目标与现状相反 |
| 旧路径更重 | `archiver.settleWindowIfNeeded` 对每个 shard 调 3 次重试（`SETTLE_MAX_SHARDS` 默认 2） | 最坏 ~18min，且失败退避只存运行时（`settleBackoffUntil` 不持久化） |
| summarize 内部已 consolidate | `manager.ts:389-394` | 若 04 §4.4 再 `enqueueConsolidate`，同一批事实会巩固两次（第二次空跑但可能重复 LLM 观察合成） |
| 04 §3.2/§4.4 对 L1 的说法不一致 | §3.2"抽取入队" vs §4.4"抽取完成后 enqueueConsolidate" | 实现前必须先定：L1 是否也异步 |

---

## 3. 失败/边界与状态机

### 3.1 状态机（文字图）

```
                     enqueue（key = kind+bank+target 去重，合并 payload）
   [无] ──────────────────────────────────────────────▶ [queued]
                                                          │ tick：通过门控
                                                          │  （未暂停/未熔断/预算内/bank 存在/在线空闲）
                                                          ▼
                                                       [running]
                                                         │ │ │
                       成功 / skipped(空工作/无源) ───────┘ │ └── 不可重试失败（JSON 空、401/参数错）─▶ [degraded]
                                                          │                                                   │
                                              可重试失败（超时/429/5xx/写失败）                                ▼
                                                          ▼                                                [删除+日志]
                                                      [backoff]
                                                          │ notBefore 到 ──▶ [queued]
                                                          │ attempts ≥ 3（或连续失败 3）
                                                          ▼
                                                       [dead] ── 熔断 30min 到期 + reconcile ──▶ [queued]
   [queued|backoff|running] ── ctx purge / bank 删除 / 会话清空 / 配置关闭 ──▶ [dropped]
   [任意] ── 插件重载 ──▶ running 视为 queued 且 attempts+1；backoff 保留；预算/熔断保留
   [任意] ── 队列 > 200 ──▶ 丢 P3 → 合并 P2 → 仍超则丢最旧非 P0
```

### 3.2 故障矩阵

| 故障 | 检测 | 恢复/幂等 | 文档覆盖 |
|---|---|---|---|
| LLM 超时/429/5xx | `withTimeout` + 错误分类 | 退避 1s→60s，最多 3 次；**不推进**水位；不重复写事实 | 部分（无 timeout 接入） |
| LLM 返回非 JSON / 空 | `parseLooseJson` 返回 null | 记 `degraded`，回退简单拼接或丢弃，不重试；不阻塞后续 | ✅ §3.3 |
| Storage 写失败 | `storageSet` try/catch | 内存态保留 + 下次写重试；**不得先推进 settledSeq/水位** | ❌ 未提 |
| 插件重载中断 | 启动加载 | `running` 脏锁清空；attempts+1；按 key 去重；事实已写不回滚 | 部分（未提脏锁） |
| 会话 purge | `ctx purge`（`cmd/sub_cmd/ctx.ts:84-95`） | `mem_cursor` 靠 `epochStartSeq` 自动作废（`context_bridge.ts:139-145`）；**但 scheduler 里该会话的 job 不会自动清** | ❌ |
| 记忆 bank 删除 | `engine.deleteBank`（当前无调用方） | job 执行时 bank 不存在 → 视为 `skipped` 并删除 job，否则无限重试 | ❌ |
| 同 bank 并发（命令 vs 后台） | `consolidatingBanks` 返回空结果 | 空结果**不能当成功**：job 结束后必须复查 `pendingFactCount`，仍有 pending 则保持 queued | ❌ |
| 暂停/无模型 | `Config.memory.MEMORY`、`Model.getChatModel('chat')` | 暂停不消耗 attempts；恢复后只处理仍 pending 的 | 部分 |
| 队列满 | 长度 > 200 | 丢 P3/合并 P2（文档有），但需保证 P1 不丢 → 需要"每会话最多 1 个 extract"的强约束 | ✅ 部分 |

### 3.3 幂等的一致性问题（重要）

- `doConsolidate` 的 pending 快照在 LLM 之前取（`consolidation.ts:29`）；新事实在 job 运行中写入 → 永久 pending，直到下一次 reconcile。reconcile 的判据必须是"bank 内仍有 `consolidationState='pending'`"，而不是"job 已成功"。
- `retain` 命中文本重复时只改元数据、**不重置** `consolidationState`（`engine.ts:184-192`），被 reinvoke 的事实不会重新巩固；这不影响不丢，但影响新鲜度。
- 重载后 `lastRefreshAt`（MM 最小间隔）丢失 → 可能立刻再刷一次；需持久化到 bank meta。

---

## 4. 隐私 / 安全

### 4.1 可见性矩阵 vs 现状

| 归属/场景 | 方案要求 | 现状 | 缺口 |
|---|---|---|---|
| 个人 bank / 本人私聊 | public+origin+owner 全可见 | 只有 `vis:private:<sid>` 与 `vis:public`（`manager.ts:268`、`session_memory.ts:101`） | 无 `origin/owner` 概念 |
| 个人 bank / 该用户发言的群 | public 可见、origin 仅来源群、**owner 不可见** | `canSeeMemoryUnit` 只拦 `vis:private:`（`manager.ts:427-431`） | 私聊 public 事实会进群；无来源 scope |
| group bank / 本群 | 全可见 | 同 bank 内无 scope 过滤 | 群聊内跨用户可见（现状可接受，但 `origin` 无法表达） |
| group bank / 其他群 | 不可见 | bankId 隔离，成立 | ✅ |
| global bank / 任意会话 | 只读 public | **不存在**：`resolveGlobalBank` 全仓 0 调用（`bank_resolver.ts:23`），无写入/注入/命令入口 | 需新建，风险见下 |

### 4.2 具体漏洞

| # | 风险 | 证据 | 严重度 |
|---|---|---|---|
| P0 | **私聊内容默认进群**：归档抽取无论 `isPrivate` 都写 `vis:public`（`manager.ts:367-370`）；群注入会对"最近发言者个人 bank"按 `user:<uid>` 召回，且只拦 `vis:private:`（`manager.ts:125-130,178-183,427-431`）→ 私聊抽出的默认事实会出现在该用户发言的群 prompt。03 §2 的"private 不进群"决策与 03 §5.1 矩阵（public 在群可见）**互相矛盾**，且旧数据全量是 public，迁移无法自动纠正 | 与"已确认决策"直接冲突 | S0 |
| P1 | **外部 tag 伪造**：`memory_add` 的 `keywords` 原样并入 tags，服务层不校验保留前缀（`manager.ts:265-269`、`tool_memory.ts:120`）。模型可写 `vis:public`、`user:<他人>`、`kw:`，V3 的 `vis:origin:*` 一旦生效同样可伪造 | 写路径无白名单 | S1 |
| P2 | **跨用户写**：`memory_add` 的 `target_id` 可指向任意已知用户（`tool_memory.ts:84-97` 仅校验 ID 格式与 `User.get` 存在），不校验"在本次会话中" | 提示注入可向他人个人 bank 写事实 | S1 |
| P3 | **`meta.kind` 默认 global**：`repository.getOrCreateBank(id,'global')`，`addUnit/addObservation/...` 都传默认值（`repository.ts:40-48,93-97`），`user_*` bank 若先经这些路径创建，`meta.kind` 会写成 `global` | 全局/个人判定若信 `meta.kind` 会串库；文档 N9 已指出，但方案未把"按前缀强制"列为迁移门 | S1 |
| P4 | **全局自动抽取默认开**：`owner=bot` 由同一次 LLM 自报，过滤只有 confidence + 正则（03 §4.3）。群成员可用"请记住你以后对所有人群都这样说话"污染全局规则，注入到**所有会话** | 与 03 §2"不把用户内容提升为全局"自相矛盾 | S0/S1 |
| P5 | **pending 原文二次留存**：`mem_cursor` 已存 120k 字符原文；若 job payload 再存一份，`.ai ctx purge`（`context/admin.ts:47-115` 明确"默认不动长期记忆"）与 `.ai memo clear` 都不会清它 | purge/clear 后原文仍可读 | S1 |
| P6 | 群聊 → 个人自动抽取默认开（03 §6.3）：需要 `origin` 正确才不泄露，而 `origin` 目前不存在 | 迁移期风险 | S2 |

**结论**：03 的可见性矩阵本身自洽，但**在 `vis:origin/owner`、保留前缀校验、target 授权、`meta.kind` 前缀强制这四件事完成前，默认开启自动抽取（个人跨群 + 全局）不可行**。建议：全局默认关；个人跨群默认关（或仅"骰主确认后开"）；所有外部 tag 在服务层统一剥离/拒绝保留前缀。

---

## 5. v2 → v3 迁移

| 方案依赖 | 仓库实际 | 判定 |
|---|---|---|
| `MemoryBankMeta.schemaVersion: 3` | 不存在（`types.ts:10-35`）；全仓无 `schemaVersion` | ❌ 需新增字段 + 旧档缺省处理 |
| `migrate.ts` 在 `repository.getBank` 时按版本惰性执行 | `getBank` 只调 `normalizeBank`（`repository.ts:28-38,364-386`）；`migrate.ts` 是**旧 memoryMap 迁移**，不是 v2→v3 | ❌ 需新建迁移入口 |
| 迁移前备份 `memv2:<bank>:backup` | 无此代码；存储已拆 5 分片（`storage.ts:27-29`） | ❌ 需新增 |
| 迁移一次性 `repository.save()` | 5 个分片分 5 次 `storageSet`（`storage.ts:83-89`），中途失败会留下"meta 已是 v3、units 还是 v2"的混合态 | ⚠️ 必须"最后写 meta"或双写版本号 |
| 回滚 | 无备份、无 v2 读路径（01 §0 明确"不做双读双写"） | ❌ 不可回滚，只能力保迁移幂等 |
| 旧数据样本 | 仓库无 v2 样本 fixture；已有 `unit-test-context-migrate*` 只覆盖 context 迁移 | ⚠️ 需新增 `scripts/unit-test-memory-migrate.ts` |
| `factType='observation'` 删除 | **14 处代码引用 + 1 处提示词字符串**，跨 10 文件（`types.ts:5`、`engine.ts:293,300,383`、`consolidation.ts:136`、`reflection.ts:54`、`scoring.ts:76`、`mental_models.ts:318,326,329`、`session_memory.ts:122`、`manager.ts:294`、`migrate.ts:60`、`cmd/memory.ts:429`；`llm.ts:48` 为 prompt 文本） | 改动面比文档列举的大 |
| 旧数据可见性重分类 | 旧档私聊事实一律 `vis:public`（`manager.ts:367-370`），迁移无 `vis` 归一规则 | 03 §2 的"私聊不进群"决策对存量数据**不成立**；迁移必须把"来源=DM 且非用户显式公开"的旧事实改标 `origin`/`owner`，否则上线即沿用泄漏 |
| 单测/仿真影响 | 记忆模块现有测试主要在 `unit-test-entry.ts`（记忆引擎/命令）；`unit-test-context-bridge` 依赖 `MemoryManager` 静态方法；sim/fuzz 猴补静态方法 | 迁移 + 端口改造必须同步更新这 5 个 harness 文件 |

**建议的最小安全迁移序**：① 读旧 5 分片 → ② 在内存完整转换 → ③ 写新分片（全部成功）→ ④ **最后**写 `meta.schemaVersion=3` + `migratedFrom=2`；任一步失败保留旧 meta，下次重试；⑤ 首次成功时写 `memv2:<bank>:backup:<ts>` 单 key 快照，1 个版本后清理。

---

## 6. 文档行号 / 钩子抽查

| # | 文档断言 | 实测 | 判定 |
|---|---|---|---|
| 1 | `archiver.ts:6` import、`95/377/414` 调用 | 完全一致 | ✅ |
| 2 | `roster.ts:98` 死调用 | 一致，且 `findImage` 恒 null | ✅ |
| 3 | `Image.get(id)` 在 `resource/image.ts:589` | 一致 | ✅ |
| 4 | `agent.ts:189-203 / 500-514` finally | 一致；但内部 `resumePending`（196/507）与 `starting` 生命周期（171/198）会影响钩子语义 | ⚠️ 行号对、钩子注释需补 |
| 5 | `context_bridge.ts:175-187` 触发点 | `175` 水位判断、`179` summarize | ✅ |
| 6 | `resolveGlobalBank` 全仓 0 调用、`safeId('*')='_'→global__` | **完全一致**（仅定义，无调用） | ✅ |
| 7 | `config/memory.ts:26` 死配置 | 注册 26、读取 42，全仓 0 使用 | ✅ |
| 8 | `deps:check` 基线 13，本方案不新增 | 13 属实；但 `archiver→memory` 不在 13 内，"解耦=减少违规"不成立 | ⚠️ 结论误导 |
| 9 | L3 默认 `refresh_after_consolidation=false` | 仓库默认 **true**（`config/memory.ts:21`、`mental_models.ts:148,415`、`repository.ts:378`） | ❌ 行为变更非"对齐" |
| 10 | MM 最小自动刷新间隔默认 0 | 仓库默认 **30 分钟**（`config/memory.ts:22`） | ❌ |
| 11 | MM 输出 `maxTokens=2048` | 仓库 `4096`（`mental_models.ts:363`） | ❌ |
| 12 | `meta.schemaVersion:3` / 惰性迁移 / 备份键 | 全部不存在 | ❌ 见 §5 |
| 13 | `mental_models.ts:285` 的 `'tick'` | `'tick'` 实际在 305（285 是 `return summary`） | ⚠️ 轻微 |
| 14 | `MEMORY_LLM_EXTRACT` 在 `index.ts:30` | 实为 `memory/v2/index.ts:30`（根 `index.ts` 无此串） | ⚠️ 轻微 |
| 15 | 03 §3.2 `recall.ts:227-230` 的 `[from:]` | 一致（`eventRecallText`） | ✅ |
| 16 | 04 §4.1 "index.ts 启动时加载队列" | `index.ts:32-66` 无任何记忆调度初始化 | 预期新增 |

### 6.1 "文档设想但仓库不支持"清单

`schemaVersion` / v2→v3 惰性迁移 / 迁移备份 / `tagsMatch='all_strict'`（`RecallOptions` 只有 any·all·exact，`types.ts:253`）/ MM 的 `tagsMatch` / `structuredContent` + AST + 类型化 delta / `reflectResponse` / `lastRefreshedSourceQuery` / `lastMemorySeenSeq`（现为秒级 `lastMemorySeenAt`）/ Observation `status='stale'`（现为**物理删除**，`consolidation.ts:27,103-115`）/ global bank 的写入·注入·命令·工具 / `vis:origin`·`vis:owner` / `MemoryService` 单门面 + `service.ts` / 每小时 20 次预算 / 熔断 / "AI 已触发"标记 / `mem_sched_v1` / 后台 tick。

---

## 7. 最终裁决与必须改的实现前提

### 7.1 总表

| 主题 | 可行 | 需改 | 不可行 |
|---|---|---|---|
| 上下文解耦（方向） | ✔ | | |
| `roster.findImage` | ✔（直接删行） | | |
| L0 `memory_work` | | ✔（tri-state、无口默认、零 import） | |
| scheduler 放 agent 层 | ✔ | | |
| 持久化选址 | | ✔（引用而非原文、单一 pending 源） | |
| tick 生命周期 | ✔ | | |
| 在线让路（按文档用 requestLimiter） | | | ✔（FIFO 无优先级） |
| 在线让路（改探测式） | ✔ | | |
| 无 AI 触发门 | | ✔（需新 marker + headless 排除 + standby 规则） | |
| 失败/状态机 | | ✔（缺 dropped/degraded/reload 锁/purge） | |
| 隐私（默认开自动抽取） | | | ✔ |
| 隐私（前缀校验/授权/kind） | | ✔ | |
| v2→v3 迁移 | | ✔（设施全缺） | |
| 文档准确性 | | ✔（5 处硬伤） | |

### 7.2 三个必须改的实现前提（前置门槛）

1. **先定义"待抽取唯一事实源"和三态 job 结果**：`mem_cursor.pending` 是唯一 pending 原文；`submitExtraction` 返回 `done|skipped|failed`；`settledSeq` 只在语义为 done/skipped 时推进；`skipped`（记忆关闭/无口/空 chunk）不得退避重试。不先做这条，L0 端口和 scheduler 都会以"成功"掩盖丢数据。
2. **把 LLM 从回复前路径移出**：拆 `consumeContextV2` 为"只读入 pending（零 LLM）"与"抽取（LLM，后台）"；删除 `summarizeChunk` 内部的 `engine.consolidate`（`manager.ts:389-394`），改由 job 触发；否则"不阻塞"和"不双跑"同时不成立。后台禁止 `requestLimiter.acquire` 排队，改用 `active===0` 探测 + 5s 让路 + 10min 上限，并暴露 `tick(now)` 供测试。
3. **隐私写边界先收口**：服务层拒绝外部传入的保留前缀（`user:/group:/global:/vis:/src:/kw:`）、`memory_add` 的 `target_id` 必须校验"本会话可见"、`createBank` 按 bankId 前缀强制 `kind`、全局自动抽取**默认关**、`ctx purge` / `memo clear` 同时清 `mem_cursor` 与相关 job。否则端口/scheduler 一上线就放大现有越权面。

### 7.3 Top 9 风险（按严重度）

1. **S0 丢数据**：端口/任务用布尔"入账成功"推进 `settledSeq`，而分片清理不看 `settledSeq`（`archiver.ts:161-172`）→ 抽取失败但原文已删。
2. **S0 阻塞**：`consumeContextV2` 在 `agent.ts:259/536` 同步调用 3 次×180s 的 LLM；旧路径每 shard 同样 3 次。方案若不改这条，"不阻塞"是空话。
3. **S0 已确认决策失效**：私聊归档事实写 `vis:public`，群注入按 `user:<uid>` 召回 → 私聊内容默认进群（`manager.ts:367-370,178-183`）；旧数据全量 public，迁移不重分类就永久泄漏。
4. **S1 全局污染**：全局自动抽取默认开 + `owner=bot` 自报 + 弱过滤 = 跨会话人设/提示注入。
5. **S1 越权**：`keywords` 直通 tags（可伪造 `vis:*`）、`memory_add` 可指定任意用户 target、`meta.kind` 默认 global。
6. **S1 持久化双源/膨胀**：原文同时进 `mem_cursor` 与 job payload；`storageSet` 叠加式写入；tick 读全库 JSON 不是"只读元数据"。
7. **S1 让路反了**：用 `requestLimiter` 排队会让后台插到用户请求前（FIFO 无优先级）。
8. **S1 钩子误判**：finally 内 `starting` 仍 true、`resumePending` 链式触发、headless 子代理会话 → 触发门会误开/误关。
9. **S2 迁移不可回滚**：无 `schemaVersion`/无备份/5 分片非原子写；`factType='observation'` 14 处代码引用，改漏即运行时类型漂移。

### 7.4 建议的实施顺序（最小风险）

P0：上下文解耦用**方案 A/B**（删调用或注入回调），不上端口；同步修 `roster` 删行。
P0：隐私四项（前缀校验、target 授权、kind 强制、**私聊默认标 `owner` 而非 `public`**）+ 全局默认关 + 旧数据可见性重分类。
P1：`consumeContextV2` 拆读/抽、去双 consolidate、scheduler（探测式让路 + tick(now) + 引用式 payload）+ 状态机。
P2：v3 迁移（schemaVersion + 原子序 + 备份 + 样本 + 5 个 harness 桩更新）。
