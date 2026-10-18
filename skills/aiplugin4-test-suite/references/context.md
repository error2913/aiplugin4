# 上下文成本用例（context）

权限：U=任意成员；I=邀请者/管理/群主/白名单/骰主；S=骰主（会话权限≥1 时为邀请者）。

背景见 `docs/09-注意事项与常见问题.md`（4.26.0 上下文成本治理注意事项）与 `docs/03-核心模块详解.md` 的「上下文(src/context/)」一节。
相关配置（组「上下文」）：`冷态窗口字数`(5000)、`冷态单条截断字数`(500)、`归档保留原文`(true)。

| ID | 指令 / 操作 | 权限 | 预期关键字 | 备注 |
|---|---|---|---|---|
| CTX-01 | `.ai ctx` | U | `状态：`、`预算：`、`本会话调用：` | 输出含状态/预算/本会话调用；状态应为 `HOT`/`COOLING`/`COLD` 之一 |
| CTX-02 | 待机群灌消息后 `.ai ctx` | U | `压缩 0` | 冷态入库零 LLM（见下"灌消息"步骤） |
| CTX-03 | 关闭「归档保留原文」后触发归档 | — | （无分片、仍有总结） | 见下"开关关闭"步骤；需改配置 + 真机触发超限 |
| CTX-04 | `.ai forget --all` | I | `已清除` | 清空本会话 arc/raw 分片并重置水位；**不影响长期记忆**（`memv2:*`）。执行后 `read_raw kind=user id=raw:001` 应返回"未找到" |
| CTX-05 | 待机群转热（`@` 一次）后查 `.ai ctx` | U | 状态 `HOT` | 首轮整包 ≤ `冷态窗口字数`（需看日志/请求体，或临时调小窗口字数放大差异） |

## 灌消息步骤（CTX-02 / CTX-05）

1. 选一个**群聊**会话，用 `.ai standby on` 把它设为待机会话（或在配置里打开「是否开启全局待机」）。
2. 确保机器人**没有被 @**：只发普通群消息 500–1000 条（脚本刷或人工灌）。此期间不应有任何压缩调用。
3. `.ai ctx` 检查：
   - `状态：` 应为 `COLD`（灌完后等 >600s；刚灌完可能是 `COOLING`）。
   - `本会话调用：压缩 0` —— **这是本组用例的核心断言**。
   - `归档：分片 N` —— 若已触发归档应有分片数。
4. 再 `@` 机器人说一句话，`.ai ctx` 的 `状态：` 应变为 `HOT`；首轮请求整包应 ≤ `冷态窗口字数`（工具轮的 `tool` 结果必须仍在，不得出现孤儿 tool 结果）。

## 开关关闭步骤（CTX-03）

改配置「归档保留原文」= 关闭后：

- 归档**不产生** `session_<id>:arc:*` 分片键，`archiveSeq` 保持 0；
- 但**仍应调用总结智能体**沉淀记忆（关掉它只省存储、不省 LLM——这是容易误解的一点）；
- 消息仍会被移出上下文。

单测对应：`testArchiveDiscardWhenKeepRawOff`（断言 `summarizeCalls > 0`、无 `:arc:` 键、消息仍被移出）。

## 说明

- **CRITICAL（配置依赖）**：`getBoolConfig` 测试桩默认返回 `true`。任何"待机/冷态"用例都必须**显式**设 `TC.boolConfigs['是否开启全局待机'] = false`，否则会话恒为待机，热态路径测不到。
- **CRITICAL（会话桩）**：`Context.session` 经 `Agent.get(agentName).sessionService.getSession(sessionId)` 获取；单测里要 `Agent.get = () => ({ sessionService: { getSession: () => session } })` 指回自己的 session，否则 `archiveSeq`/`stateOf` 落到别的会话实例上。
- **分片存储**：海豹 `storageGet` 对**不存在的 key 也抛异常**（`types/seal.d.ts:504`），因此"读异常"不能当作存在性结论；分片存在性由持久化的 `archiveSeq` 水位判定（见 `src/context/archive_store.ts` 的 `writeShardIfAbsent`）。
- CTX-04 已验证可用（P1-4 已实现：`.ai forget --all` + TTL + 上限配置）。
- 新增命令 `.ai ctxset`（权限 I）：`window=` / `cold=` / `truncate=` 按会话覆盖上下文参数，`clr` 清除。
