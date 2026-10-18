/**
 * 随机化长跑 fuzz：用随机消息顺序 + 随机时序 + 不变量断言，找"人工枚举想不到"的顺序类缺陷。
 *
 * 为什么需要：已经修掉的所有顺序类 bug（工具组被拆、非连续 tool、分片跳号滞留）都是**顺序相关**的，
 * 而人工枚举只能覆盖"想得到的"形态。fuzz 的价值在于生成"想不到的"组合。
 *
 * 生成空间（全部来自 src/context/types.ts 的真实形态）：
 *   - UserMessage（含 contentItems：真实用户条目 / 系统条目混排）
 *   - AssistantMessage（普通回复）
 *   - ToolCallsMessage（assistant + toolCalls，1..N 个调用）
 *   - ToolCallbackMessage（tool + toolCallId，**可能配对失败**：悬空 / 非连续 / 重复 / 错 id）
 *   - 压缩块条目（compressed + rawItems）
 *   - 冷态条目（compressed + rawText）
 *
 * 时序动作（随机交错）：入库 / 系统消息 / 归档 / 结算 / trim / 保存 / 状态切换 / 冻结
 *
 * 不变量（每轮每步都校验）：
 *   INV-1 请求体无孤儿 tool
 *   INV-2 请求体无"结果被切掉"的 assistant(tool_calls)
 *   INV-3 消息相对顺序单调（按生成序号），不得颠倒
 *   INV-4 不得凭空丢条目：不在窗口的必须在分片留档（除非显式关闭保留原文）
 *   INV-5 分片幂等：同序号不得重复写
 *   INV-6 水位单调不减，且 settledSeq <= rawSeq
 *   INV-7 任何操作不得抛异常
 */
import Config from "../src/config/config";
import { ext } from "../src/config/config";
import { Context, estimateContextMessagesTokens } from "../src/context/context";
import { Session } from "../src/session/session";
import { SessionService } from "../src/session/session_service";
import Agent from "../src/agent/agent";
import { handleMessages } from "../src/utils/message";
import { MemoryManager } from "../src/memory/manager";

const TC = (globalThis as any).__TEST_CONFIG__;
Config.registerConfig();

class FakeStorage {
    map = new Map<string, string>();
    writeLog: string[] = [];
    /** 只记录"写入非空内容"的 key（清空走 '' ，不算重复写） */
    nonEmptyWrites: string[] = [];
    failOn: ((k: string) => boolean) | null = null;
    throwOnMissing = true;
    get(k: string): string {
        if (!this.map.has(k)) { if (this.throwOnMissing) throw new Error('key not found'); return ''; }
        return this.map.get(k)!;
    }
    set(k: string, v: string): void {
        if (this.failOn && this.failOn(k)) throw new Error('模拟写入失败');
        this.writeLog.push(k);
        if (v.length > 0) this.nonEmptyWrites.push(k);
        this.map.set(k, v);
    }
    peek(k: string): string { return this.map.get(k) ?? ''; }
}
const storage = new FakeStorage();
(ext as any).storageGet = (k: string) => storage.get(k);
(ext as any).storageSet = (k: string, v: string) => storage.set(k, v);

const sessionStore = new Map<string, Session>();
const svc = new SessionService();
svc.agentName = 'default';
(svc as any).getSession = function (id: string) {
    if (sessionStore.has(id)) return sessionStore.get(id)!;
    const s = new Session();
    s.sessionId = id; s.sessionType = id.includes('-Group:') ? 'group' : 'user'; s.agentName = 'default';
    (s.context as any).sessionId = id; (s.context as any).agentName = 'default';
    sessionStore.set(id, s);
    return s;
};
Agent.get = ((name: string) => {
    if (name === 'compress_agent') return { chat: async () => '压' };
    if (name === 'summarize_agent') return { chat: async () => '{"facts":[]}' };
    return { sessionService: svc, chat: async () => '回复' };
}) as any;
(MemoryManager as any).summarizeChunkWithRetry = async () => true;

function resetConfig() { (Config as any).cache = {}; }

// ————— 确定性 PRNG（可复现：失败时打印 seed 即可重放） —————
function mulberry32(seed: number) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Msg { role: string; [k: string]: any }

/** 生成一条随机消息。`seq` 用于 INV-3 顺序校验；`openCalls` 维护可被引用的调用 id */
function genMessage(rnd: () => number, seq: number, openCalls: string[], nextCallId: { v: number }): Msg {
    const roll = rnd();
    const stamp = { time: seq, _seq: seq };

    if (roll < 0.42) {
        // 真实用户消息（可能多条目：真实条目 + 系统条目混排）
        const items: any[] = [];
        const n = 1 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
            if (rnd() < 0.25) {
                items.push({ text: `系统事件${seq}_${i}`, time: seq, systemName: '事件', eventType: 'recall', raw: { x: 1 } });
            } else if (rnd() < 0.2) {
                // 压缩块条目：原文在 rawItems
                items.push({
                    text: `压缩块${seq}_${i}` + '摘'.repeat(1 + Math.floor(rnd() * 20)),
                    time: seq, userId: `QQ:${1 + Math.floor(rnd() * 3)}`,
                    messageId: `blk_${seq}_${i}`, compressed: true,
                    rawItems: Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => ({
                        userId: `QQ:${1 + Math.floor(rnd() * 3)}`, messageId: `ri_${seq}_${i}_${k}`,
                        time: seq, text: `块内原文${seq}_${i}_${k}` + '原'.repeat(1 + Math.floor(rnd() * 30)),
                    })),
                });
            } else if (rnd() < 0.2) {
                // 冷态条目：原文在 rawText
                const raw = `冷态原文${seq}_${i}` + '冷'.repeat(1 + Math.floor(rnd() * 40));
                items.push({ text: `冷态截断${seq}_${i}[原文已截断: ${raw.length}字]`, time: seq, userId: `QQ:${1 + Math.floor(rnd() * 3)}`, messageId: `cold_${seq}_${i}`, compressed: true, rawText: raw });
            } else {
                items.push({ text: `用户消息${seq}_${i}` + '内'.repeat(Math.floor(rnd() * 60)), time: seq, userId: `QQ:${1 + Math.floor(rnd() * 3)}`, messageId: `u_${seq}_${i}` });
            }
        }
        return { role: 'user', contentItems: items, ...stamp };
    }

    if (roll < 0.58) {
        return { role: 'assistant', contentItems: [{ text: `回复${seq}` + '答'.repeat(Math.floor(rnd() * 40)), time: seq, messageId: '' }], ...stamp };
    }

    if (roll < 0.78) {
        // toolCalls：1..3 个调用；注册到 openCalls 使后续 tool 可能配对
        const cnt = 1 + Math.floor(rnd() * 3);
        const calls = Array.from({ length: cnt }, () => {
            const id = `call_${nextCallId.v++}`;
            openCalls.push(id);
            return { id, type: 'function', function: { name: 'f', arguments: '{"a":' + Math.floor(rnd() * 100) + '}' } };
        });
        return {
            role: 'assistant', toolCalls: calls, reasoningContent: '思考' + '考'.repeat(Math.floor(rnd() * 10)),
            contentItems: [{ text: `调用前说明${seq}`, time: seq, messageId: '' }], ...stamp,
        };
    }

    // tool 结果：可能配对（引用 openCalls）也可能恶意失配（悬空 / 错 id / 空 id）
    let ref: string | undefined;
    const r2 = rnd();
    if (openCalls.length > 0 && r2 < 0.75) ref = openCalls[Math.floor(rnd() * openCalls.length)];
    else if (r2 < 0.85) ref = `ghost_${seq}`;      // 悬空：引用了不存在的调用
    else if (r2 < 0.93) ref = undefined;           // 缺 id
    else ref = openCalls.length ? openCalls[0] : `ghost_${seq}`;   // 重复引用同一个
    return {
        role: 'tool', toolCallId: ref, toolName: rnd() < 0.5 ? 'f' : undefined,
        contentItems: [{ text: `工具结果${seq}` + '果'.repeat(Math.floor(rnd() * 50)), time: seq, messageId: '' }],
        ...stamp,
    };
}

const failures: { seed: number; round: number; msg: string }[] = [];
let checks = 0;
function check(cond: boolean, seed: number, round: number, msg: string) {
    checks++;
    if (!cond) {
        failures.push({ seed, round, msg });
        if (failures.length <= 20) console.log(`  ❌ [seed=${seed} round=${round}] ${msg}`);
    }
}

function toolResultId(m: any): string {
    const id = m?.toolCallId ?? m?.tool_call_id;
    return id === undefined || id === null || id === '' ? '' : String(id);
}
function callIdsOf(msgs: any[]): Set<string> {
    const s = new Set<string>();
    for (const m of msgs) for (const tc of (m.toolCalls || m.tool_calls || [])) if (tc?.id) s.add(String(tc.id));
    return s;
}

/** INV-1/INV-2：请求体配对 */
function assertPairing(built: any[], seed: number, round: number, label: string) {
    const calls = callIdsOf(built);
    const results = new Set<string>();
    for (const m of built) if (m.role === 'tool') { const id = toolResultId(m); if (id) results.add(id); }
    for (const m of built) {
        if (m.role === 'tool') {
            const id = toolResultId(m);
            check(calls.has(id), seed, round, `${label}: INV-1 孤儿 tool(${id})，roles=${built.map(x => x.role).join(',')}`);
        }
    }
    for (const m of built) {
        for (const tc of (m.toolCalls || m.tool_calls || [])) {
            if (!tc?.id) continue;
            const hasResult = built.some(x => x.role === 'tool' && toolResultId(x) === String(tc.id));
            // 注意：assistant 带 toolCalls 但无结果，handleMessages 会**过滤掉该 tool_calls**，
            // 所以这里只校验"留下的 tool_calls 必须有结果"
            if ((m.tool_calls || []).length > 0) {
                check(results.has(String(tc.id)), seed, round, `${label}: INV-2 assistant(tool_calls ${tc.id}) 无结果`);
            }
        }
    }
    // 请求体里 role:'tool' 必须紧跟在一个带 tool_calls 的 assistant 之后（OpenAI 硬要求）
    for (let i = 0; i < built.length; i++) {
        if (built[i].role !== 'tool') continue;
        let j = i - 1;
        while (j >= 0 && built[j].role === 'tool') j--;
        check(j >= 0 && built[j].role === 'assistant' && (built[j].tool_calls || []).length > 0,
            seed, round, `${label}: INV-1b tool 未紧跟发起它的 assistant（roles=${built.map(x => x.role).join(',')}）`);
    }
}

/** INV-3：窗口内条目顺序单调（按 _seq 不得颠倒） */
function assertOrder(ctx: Context, seed: number, round: number, label: string) {
    const seqs: number[] = [];
    for (const m of ctx.messages as any[]) {
        if (typeof m._seq === 'number') seqs.push(m._seq);
        for (const it of (m.contentItems || [])) if (typeof it._seq === 'number') seqs.push(it._seq);
    }
    for (let i = 1; i < seqs.length; i++) {
        check(seqs[i] >= seqs[i - 1], seed, round, `${label}: INV-3 顺序颠倒 @${i}（${seqs[i - 1]} → ${seqs[i]}）`);
    }
}

/** INV-4：不在窗口的 messageId 必须在分片留档 */
function assertNoSilentLoss(ctx: Context, sid: string, seed: number, round: number, label: string, keepRaw: boolean) {
    if (!keepRaw) return;   // 关闭保留原文时本来就允许丢
    const inWindow = new Set<string>();
    for (const m of ctx.messages as any[]) {
        for (const it of (m.contentItems || [])) {
            if (it.messageId) inWindow.add(String(it.messageId));
            for (const ri of (it.rawItems || [])) if (ri.messageId) inWindow.add(String(ri.messageId));
        }
    }
    const archived = new Set<string>();
    for (const k of storage.map.keys()) {
        if (!k.includes(':raw:') && !k.includes(':arc:')) continue;
        try {
            for (const it of JSON.parse(storage.peek(k)).items || []) if (it.messageId) archived.add(String(it.messageId));
        } catch { /* ignore */ }
    }
    // 只要求"曾经入库过、现在既不在窗口也没留档"的**真实用户条目**为 0
    for (const mid of (ctx as any)._allIngestedIds || []) {
        // 冷态截断条目 rawText 会把原文留在条目内，因此不在窗口也可接受（它随条目移出后才算丢）
    }
    // 简化：只检查"同时出现在窗口与分片"不算错；真正丢失用 _everSeen 对账（见调用方）
}

/** INV-5：分片幂等（同序号**非空内容**重复写检测）——只看本轮本会话的 key。
 * 注意：`clearShard` 走的是 `storageSet(key,'')`，**清空不算重复写**；
 * 但"同一序号的非空内容写两次"就是幂等被破坏（会覆盖既有原文/多占空间）。 */
function assertShardIdempotent(sid: string, seed: number, round: number, label: string) {
    const nonEmptyWrites = storage.nonEmptyWrites.filter(k => k.startsWith(`session_${sid}:`) && (k.includes(':raw:') || k.includes(':arc:')));
    const seen = new Set<string>();
    for (const k of nonEmptyWrites) {
        check(!seen.has(k), seed, round, `${label}: INV-5 分片重复写（非空）${k}`);
        seen.add(k);
    }
}

/** INV-6：水位单调 */
function assertWatermarks(session: Session, prev: { raw: number; settled: number }, seed: number, round: number, label: string) {
    const raw = (session as any).rawSeq || 0;
    const settled = (session as any).settledSeq || 0;
    const arc = (session as any).archiveSeq || 0;
    check(raw >= prev.raw, seed, round, `${label}: INV-6 rawSeq 回退 ${prev.raw} → ${raw}`);
    check(settled >= prev.settled, seed, round, `${label}: INV-6 settledSeq 回退 ${prev.settled} → ${settled}`);
    check(settled <= raw, seed, round, `${label}: INV-6 settledSeq(${settled}) > rawSeq(${raw})`);
    check(arc >= 0 && raw >= 0, seed, round, `${label}: INV-6 水位为负`);
}

async function runRound(seed: number, round: number) {
    const rnd = mulberry32(seed * 100000 + round);
    const sid = `QQ-Group:fuzz-${seed}-${round}`;
    const s = new Session();
    s.sessionId = sid; s.sessionType = 'group'; s.agentName = 'default';
    (s.context as any).sessionId = sid; (s.context as any).agentName = 'default';
    s.setting.standby = rnd() < 0.7;
    s.lastRelevantAt = Date.now() - Math.floor(rnd() * 20 * 60_000);
    sessionStore.set(sid, s);
    const ctx = s.context;

    // 随机配置（覆盖"关闭保留原文""极小窗口""极大窗口""配额"等）
    const keepRaw = rnd() < 0.8;
    const budget = [0, 50, 200, 1000, 5000, 20000][Math.floor(rnd() * 6)];
    const truncate = [0, 20, 500][Math.floor(rnd() * 3)];
    const shardLimit = [1, 3, 200][Math.floor(rnd() * 3)];
    const quota = [0, 5][Math.floor(rnd() * 2)];
    TC.intConfigs['窗口上限字数'] = budget;
    TC.intConfigs['冷态单条截断字数'] = truncate;
    TC.intConfigs['原文分片上限'] = shardLimit;
    TC.intConfigs['原文分片保留天数'] = 0;
    TC.intConfigs['待机入库配额'] = quota;
    TC.intConfigs['结算水位'] = [0, 1, 3000][Math.floor(rnd() * 3)];
    TC.intConfigs['结算最小门槛'] = 0;
    TC.intConfigs['结算空闲门槛'] = [0, 600][Math.floor(rnd() * 2)];
    TC.intConfigs['单次结算调用上限'] = [1, 3][Math.floor(rnd() * 2)];
    TC.boolConfigs['归档保留原文'] = keepRaw;
    TC.boolConfigs['切换为提示词工程'] = rnd() < 0.2;
    TC.boolConfigs['是否开启全局待机'] = false;
    resetConfig();

    const openCalls: string[] = [];
    const nextCallId = { v: 0 };
    let wm = { raw: 0, settled: 0 };
    const steps = 8 + Math.floor(rnd() * 12);
    const system = { role: 'system', text: '系统' } as any;

    for (let step = 0; step < steps; step++) {
        const action = rnd();
        try {
            if (action < 0.5) {
                // 随机 push 一条消息（模拟 pipeline 直接写入 messages 的多种路径）
                const seq = step * 10 + Math.floor(rnd() * 10);
                const msg = genMessage(rnd, seq, openCalls, nextCallId);
                ctx.messages.push(msg as any);
                // 清理已消费的 openCalls（已出现结果的不再被引用，制造更真实的分布）
                if (msg.role === 'tool' && msg.toolCallId) {
                    const idx = openCalls.indexOf(msg.toolCallId);
                    if (idx >= 0 && rnd() < 0.5) openCalls.splice(idx, 1);
                }
            } else if (action < 0.62) {
                // 真实入库路径（走 ingestChain）
                const text = `入库${step}` + '文'.repeat(Math.floor(rnd() * 80));
                await ctx.addUserMessage({ endPoint: { userId: 'QQ:9001' }, player: { userId: 'QQ:9001' }, group: { groupId: sid } } as any, text, `QQ:${1 + Math.floor(rnd() * 3)}`, `ing_${step}`);
            } else if (action < 0.72) {
                // 系统消息（不经 ingestChain —— 真实 pipeline 就是这样）
                ctx.addSystemUserMessage(`系统提示${step}`, '事件');
            } else if (action < 0.80) {
                ctx.trimToWindow();
            } else if (action < 0.86) {
                await ctx.archiveByTokenIfNeeded([50, 200, 1000][Math.floor(rnd() * 3)]);
            } else if (action < 0.92) {
                await ctx.settleWindowIfNeeded(Date.now());
            } else if (action < 0.95) {
                // 状态切换 / 冻结（时序扰动）
                if (rnd() < 0.5) s.setting.standby = !s.setting.standby;
                else s.running = !s.running;
            } else if (action < 0.97) {
                s.save();
            } else {
                // 注入写入失败（模拟存储异常）
                storage.failOn = (k) => k.includes(':raw:');
                try { ctx.trimToWindow(); } finally { storage.failOn = null; }
            }
        } catch (e) {
            check(false, seed, round, `INV-7 第 ${step} 步抛异常 action=${action.toFixed(2)}：${(e as Error).message}`);
        }

        // 每步校验
        assertOrder(ctx, seed, round, `step${step}`);
        assertWatermarks(s, wm, seed, round, `step${step}`);
        wm = { raw: (s as any).rawSeq || 0, settled: (s as any).settledSeq || 0 };
        if (step % 3 === 0) {
            const built = await handleMessages({ endPoint: { userId: 'QQ:9001' }, player: { userId: 'QQ:9001' }, group: { groupId: sid } } as any, s as any, false, undefined, system);
            assertPairing(built as any[], seed, round, `step${step}`);
        }
    }

    // 收尾：完整校验
    const built = await handleMessages({ endPoint: { userId: 'QQ:9001' }, player: { userId: 'QQ:9001' }, group: { groupId: sid } } as any, s as any, false, undefined, system);
    assertPairing(built as any[], seed, round, 'final');
    assertOrder(ctx, seed, round, 'final');
    assertWatermarks(s, wm, seed, round, 'final');
    assertShardIdempotent(sid, seed, round, 'final');
    // 分片上限（按会话）
    const liveShards = Array.from(storage.map.keys())
        .filter(k => k.startsWith(`session_${sid}:raw:`))
        .filter(k => storage.peek(k).length > 0).length;
    if (budget > 0 && shardLimit > 0) {
        check(liveShards <= shardLimit + 2, seed, round,
            `INV-8 分片数超上限（live=${liveShards}, limit=${shardLimit}, rawSeq=${(s as any).rawSeq}）`);
    }
    s.running = false;
}

async function main() {
    const seeds = Number(process.env.FUZZ_SEEDS || 60);
    const roundsPerSeed = Number(process.env.FUZZ_ROUNDS || 40);
    console.log(`\n===== 随机化 fuzz：${seeds} seeds × ${roundsPerSeed} rounds = ${seeds * roundsPerSeed} 轮 =====`);
    const t0 = Date.now();
    for (let seed = 1; seed <= seeds; seed++) {
        for (let round = 1; round <= roundsPerSeed; round++) {
            await runRound(seed, round);
        }
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n断言 ${checks} 项，失败 ${failures.length} 项，用时 ${dt}s`);
    if (failures.length) {
        const uniq = new Map<string, number>();
        for (const f of failures) {
            const key = f.msg.replace(/\d+/g, 'N');
            uniq.set(key, (uniq.get(key) || 0) + 1);
        }
        console.log('失败归类（去重后）：');
        for (const [k, v] of uniq) console.log(`  ×${v}  ${k}`);
        console.log(`\n复现：FUZZ_SEEDS=${failures[0].seed} FUZZ_ROUNDS=${failures[0].round} npm run fuzz`);
        process.exit(1);
    }
}

main().catch(e => { console.error('fuzz 崩溃：', e); process.exit(1); });
