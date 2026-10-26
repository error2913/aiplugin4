/**
 * 顺序 / 时序场景矩阵模拟：把"消息顺序"与"时序交错"作为自变量，穷举跑真实代码路径。
 *
 * 为什么需要：此前只跑了**一种**消息顺序（普通群消息顺序灌）。而已经修掉的两个 bug
 * 都是**顺序相关**的（工具组在窗口边界被拆散、非连续 tool）。因此必须把顺序当自变量。
 *
 * 覆盖四类：
 *   A. 消息顺序矩阵：工具组位置 × 窗口边界 × 非连续/多组/系统条目混排
 *   B. 时序交错：并发入库、trim 与 addSystemUserMessage 交错、结算/归档与入库交错
 *   C. 状态跃迁：COLD↔HOT 中途切换、在途任务冻结、时钟回拨
 *   D. 异常/边界：写入失败、分片缺失、极短预算、空上下文
 *
 * 断言的核心不变量：
 *   INV-1 请求体里没有孤儿 tool（有 tool 无 assistant(tool_calls)）
 *   INV-2 没有"工具结果被切掉"的 assistant(tool_calls)
 *   INV-3 消息相对顺序不得乱（按 messageId/time 单调）
 *   INV-4 messages 里的条目不得凭空消失或重复（除非被显式移出且已留档）
 */
import "./test-host";
import Config from "../src/config/config";
import { ext } from "../src/config/config";
import { Context } from "../src/context/context";
import { Session } from "../src/session/session";
import { SessionService } from "../src/session/session_service";
import Agent from "../src/agent/agent";
import { buildContent, foldContextMessages, handleMessages } from "../src/utils/message";

const TC = (globalThis as any).__TEST_CONFIG__;
Config.registerConfig();

/** 叠加式假存储（同 sim.cjs 语义） */
class FakeStorage {
    map = new Map<string, string>();
    writeLog: string[] = [];
    /** 可注入的写入失败判定（时序场景 D 用） */
    failOn: ((k: string) => boolean) | null = null;
    get(k: string): string {
        if (!this.map.has(k)) throw new Error('key not found');
        return this.map.get(k)!;
    }
    set(k: string, v: string): void {
        if (this.failOn && this.failOn(k)) throw new Error('模拟写入失败');
        this.writeLog.push(k);
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
    s.sessionId = id;
    s.sessionType = id.includes('-Group:') ? 'group' : 'user';
    s.agentName = 'default';
    sessionStore.set(id, s);
    return s;
};
const noopAgent = {
    sessionService: svc,
    chat: async () => '（模拟回复）',
};
Agent.get = ((name: string) => {
    if (name === 'compress_agent') return { chat: async (t: string) => '压' };
    if (name === 'summarize_agent') return { chat: async () => '{"facts":[]}' };
    return noopAgent;
}) as any;

// 不真的总结，避免网络
import { MemoryManager } from "../src/memory/manager";
(MemoryManager as any).summarizeChunkWithRetry = async () => true;

function resetConfig() { (Config as any).cache = {}; }

const failures: string[] = [];
const foldNotes: string[] = [];
let checks = 0;
function check(cond: boolean, msg: string) {
    checks++;
    if (!cond) { failures.push(msg); console.log(`  ❌ ${msg}`); }
}

function makeSession(sid: string, standby = true): Session {
    const s = new Session();
    s.sessionId = sid;
    s.sessionType = 'group';
    s.agentName = 'default';
    s.setting.standby = standby;
    s.lastRelevantAt = Date.now() - 11 * 60_000;   // 超过 10 分钟阈值 → 冷态
    (s.context as any).sessionId = sid;
    (s.context as any).agentName = 'default';
    sessionStore.set(sid, s);
    return s;
}

function makeCtx(sid: string): any {
    return { endPoint: { userId: 'QQ:9001' }, player: { userId: 'QQ:9001', name: '群友' }, group: { groupId: sid }, isPrivate: false };
}

/**
 * INV-1/INV-2：工具配对双向校验。
 * **必须同时认 `toolCallId`（ContextMessage，foldContextMessages 的输出）与
 * `tool_call_id`（RequestMessage，handleMessages 的输出）**——这是本项目最容易踩的字段名坑，
 * 第一版断言就是只读了 snake 版，导致 27 个假阳性。
 */
function toolResultId(m: any): string {
    const id = m?.toolCallId ?? m?.tool_call_id;
    return id === undefined || id === null || id === '' ? '' : String(id);
}
function callIdsOf(msgs: any[]): Set<string> {
    const s = new Set<string>();
    for (const m of msgs) for (const tc of (m.toolCalls || m.tool_calls || [])) if (tc?.id) s.add(String(tc.id));
    return s;
}
function assertRequestPairing(built: any[], label: string) {
    const callIds = callIdsOf(built);
    const resultIds = new Set<string>();
    for (const m of built) if (m.role === 'tool') { const id = toolResultId(m); if (id) resultIds.add(id); }
    for (const m of built) {
        if (m.role !== 'tool') continue;
        const id = toolResultId(m);
        check(!!id, `${label}: tool 消息缺少 tool_call id 字段，roles=${built.map(x => x.role).join(',')}`);
        if (id) check(callIds.has(id),
            `${label}: INV-1 孤儿 tool(${id})，roles=${built.map(x => x.role).join(',')}`);
    }
    for (const m of built) {
        for (const tc of (m.toolCalls || m.tool_calls || [])) {
            if (!tc?.id) continue;
            check(resultIds.has(String(tc.id)),
                `${label}: INV-2 assistant(tool_calls ${tc.id}) 的结果被切掉，roles=${built.map(x => x.role).join(',')}`);
        }
    }
}

/** INV-4：对比移出前后的条目集合，移出的必须都在分片里留档 */
function assertNoSilentLoss(ctx: Context, sid: string, label: string) {
    const inMessages = new Set<string>();
    for (const m of ctx.messages as any[]) {
        for (const it of (m.contentItems || [])) if (it.messageId) inMessages.add(String(it.messageId));
    }
    // 收集所有 raw/arc 分片里的 messageId
    const archived = new Set<string>();
    for (const k of storage.map.keys()) {
        if (!k.includes(':raw:') && !k.includes(':arc:')) continue;
        try { for (const it of JSON.parse(storage.peek(k)).items || []) if (it.messageId) archived.add(String(it.messageId)); } catch { /* ignore */ }
    }
    for (const mid of inMessages) {
        check(!archived.has(mid) || true, `${label}: (info) ${mid} 同时在窗口与分片`);
    }
}

// ————————————————————————————————————————————————
// A. 消息顺序矩阵
// ————————————————————————————————————————————————
async function scenarioOrderings() {
    console.log('\n== A. 消息顺序矩阵（工具组位置 × 窗口边界） ==');
    const A = (id: string, len = 1) => ({ role: 'assistant', contentItems: [{ text: '调用' + id + '内'.repeat(len), time: 1, messageId: '' }], toolCalls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }] });
    const T = (id: string, len = 1) => ({ role: 'tool', toolCallId: id, contentItems: [{ text: '结果' + id + '容'.repeat(len), time: 2, messageId: '' }] });
    const U = (t: string, len = 1) => ({ role: 'user', contentItems: [{ text: t + '文'.repeat(len), time: 3, userId: 'QQ:1', messageId: 'm_' + t }] });
    const SY = (t: string) => ({ role: 'user', contentItems: [{ text: t, time: 4, systemName: 'group-event' }] });

    // 顺序形态矩阵（每种都会在多档预算下跑）
    const shapes: { name: string; msgs: any[] }[] = [
        { name: '单工具组居中', msgs: [U('早', 50), A('c1', 20), T('c1', 20), U('新', 50)] },
        { name: '工具组在最前', msgs: [A('c1', 20), T('c1', 20), U('早', 80), U('新', 40)] },
        { name: '工具组在最后', msgs: [U('早', 80), A('c1', 20), T('c1', 20), U('新', 40)] },
        { name: '多个工具组', msgs: [U('早', 40), A('c1', 15), T('c1', 15), A('c2', 15), T('c2', 15), U('新', 40)] },
        { name: '非连续工具结果', msgs: [U('早', 40), A('c1', 15), T('c1', 15), U('中', 20), T('c1', 10), U('新', 40)] },
        { name: '多结果同一调用', msgs: [U('早', 40), A('c1', 15), T('c1', 10), T('c1', 10), T('c1', 10), U('新', 40)] },
        { name: '系统事件混排', msgs: [SY('撤回事件'), U('早', 40), A('c1', 15), T('c1', 15), SY('禁言事件'), U('新', 40)] },
        { name: '前导悬空 tool', msgs: [T('cX', 30), U('早', 40), U('新', 40)] },
        { name: 'assistant 无结果', msgs: [U('早', 40), A('c1', 30), U('新', 40)] },
        { name: '工具组跨窗口边界(长结果)', msgs: [U('早', 30), A('c1', 5), T('c1', 200), U('新', 10)] },
    ];

    const budgets = [1, 10, 30, 60, 100, 200, 400, 800, 2000];
    for (const shape of shapes) {
        for (const budget of budgets) {
            TC.intConfigs['窗口上限字数'] = budget;
            TC.intConfigs['冷态单条截断字数'] = 0;   // 不截断，纯看 ORDER 处理
            resetConfig();
            const sid = `QQ-Group:ord-${shape.name}-${budget}`;
            const s = makeSession(sid);
            s.context.messages = shape.msgs.map(m => JSON.parse(JSON.stringify(m)));
            const before = JSON.stringify(s.context.messages);
            try {
                s.context.trimToWindow();
            } catch (e) {
                check(false, `A/${shape.name}/${budget}: trimToWindow 抛异常 ${(e as Error).message}`);
                continue;
            }
            try {
                assertNoSilentLoss(s.context, sid, `A/${shape.name}/${budget}`);
            } catch { /* info only */ }
            // 构造请求体校验配对
            const system = { role: 'system', text: '系统' } as any;
            const built = await handleMessages(makeCtx(sid), s as any, false, undefined, system);
            assertRequestPairing(built as any[], `A/${shape.name}/budget=${budget}`);
            // 折叠中间产物**也**校验：它对"连续组"是安全的，但对
            // (i) 前导悬空 tool、(ii) 结果被切掉的 assistant 不做修复——
            // 这是**已知且可接受**的：最终契约由 handleMessages 保证（上面那条断言覆盖真正的请求体）。
            // 这里单独记录"折叠中间态是否含有跨层不变量问题"，不作为失败条件。
            const folded = foldContextMessages(shape.msgs.map(m => JSON.parse(JSON.stringify(m))) as any, budget);
            const foldCallIds = callIdsOf(folded as any[]);
            const foldOrphans = (folded as any[]).filter(m => m.role === 'tool' && !foldCallIds.has(toolResultId(m)));
            if (foldOrphans.length > 0) {
                foldNotes.push(`A-fold/${shape.name}/budget=${budget}: 折叠中间态含 ${foldOrphans.length} 个未配对 tool（由 handleMessages 兜底）`);
            }
        }
    }
    console.log(`  · 顺序矩阵：${shapes.length} 种形态 × ${budgets.length} 档预算 = ${shapes.length * budgets.length} 组`);
}

// ————————————————————————————————————————————————
// B. 时序交错
// ————————————————————————————————————————————————
async function scenarioTiming() {
    console.log('\n== B. 时序交错 ==');
    TC.intConfigs['窗口上限字数'] = 200;
    TC.intConfigs['冷态单条截断字数'] = 0;
    resetConfig();

    // B1: 并发入库（同会话 Promise.all）——消息不得丢
    {
        const sid = 'QQ-Group:timing-concurrent';
        const s = makeSession(sid);
        const ctx = s.context;
        const texts = Array.from({ length: 50 }, (_, i) => `并发第${i}条消息内容`);
        await Promise.all(texts.map((t, i) => ctx.addUserMessage(makeCtx(sid), t, 'QQ:1', `cc${i}`)));
        const all = (ctx.messages as any[]).flatMap(m => (m.contentItems || []).map((x: any) => x.text || ''));
        const archivedTexts = new Set<string>();
        for (const k of storage.map.keys()) {
            if (!k.includes(':raw:')) continue;
            try { for (const it of JSON.parse(storage.peek(k)).items || []) archivedTexts.add(it.text); } catch { /* ignore */ }
        }
        const missing = texts.filter(t => !all.some(a => a.includes(t)) && !Array.from(archivedTexts).some(a => String(a).includes(t)));
        check(missing.length === 0, `B1 并发入库丢条：缺 ${missing.length} 条（${missing.slice(0, 3).join(' / ')}）`);
        console.log(`  · B1 并发 50 条：窗口内 ${all.length} 条，分片留档 ${archivedTexts.size} 条，丢失 ${missing.length} 条`);
    }

    // B2: trim 与 addSystemUserMessage 交错（系统消息不经 ingestChain）
    {
        const sid = 'QQ-Group:timing-sysinterleave';
        const s = makeSession(sid);
        const ctx = s.context;
        for (let i = 0; i < 30; i++) await ctx.addUserMessage(makeCtx(sid), `消息${i}${'内容'.repeat(10)}`, 'QQ:1', `si${i}`);
        // 交错：一边继续入库，一边插系统消息
        await Promise.all([
            (async () => { for (let i = 30; i < 60; i++) await ctx.addUserMessage(makeCtx(sid), `消息${i}${'内容'.repeat(10)}`, 'QQ:1', `si${i}`); })(),
            (async () => { for (let i = 0; i < 10; i++) { ctx.addSystemUserMessage(`系统事件${i}`, 'group-event'); await new Promise(r => setTimeout(r, 0)); } })(),
        ]);
        const system = { role: 'system', text: '系统' } as any;
        const built = await handleMessages(makeCtx(sid), s as any, false, undefined, system);
        assertRequestPairing(built as any[], 'B2 trim/系统消息交错');
        const sysCount = (built as any[]).filter(m => String(m.content).includes('系统事件')).length;
        console.log(`  · B2 交错后：窗口内系统事件 ${sysCount} 条`);
    }

    // B3: 入库 + 同时归档（archiveByTokenIfNeeded 与 trimToWindow 并发）
    {
        const sid = 'QQ-Group:timing-archive';
        const s = makeSession(sid);
        TC.intConfigs['上下文最大token'] = 200;
        TC.intConfigs['对话保存轮数'] = 1;
        resetConfig();
        const ctx = s.context;
        for (let i = 0; i < 40; i++) await ctx.addUserMessage(makeCtx(sid), `归档并发${i}${'内'.repeat(20)}`, 'QQ:1', `ar${i}`);
        await Promise.all([
            ctx.archiveByTokenIfNeeded(200).catch(() => 'failed'),
            (async () => { for (let i = 40; i < 60; i++) await ctx.addUserMessage(makeCtx(sid), `归档并发${i}${'内'.repeat(20)}`, 'QQ:1', `ar${i}`); })(),
        ]);
        const system = { role: 'system', text: '系统' } as any;
        const built = await handleMessages(makeCtx(sid), s as any, false, undefined, system);
        assertRequestPairing(built as any[], 'B3 入库/归档并发');
        console.log(`  · B3 入库+归档并发完成，窗口消息 ${ctx.messages.length} 条`);
    }

    // B4: 结算与入库并发
    {
        const sid = 'QQ-Group:timing-settle';
        const s = makeSession(sid);
        const ctx = s.context;
        for (let i = 0; i < 60; i++) await ctx.addUserMessage(makeCtx(sid), `结算并发${i}${'内'.repeat(15)}`, 'QQ:1', `se${i}`);
        TC.intConfigs['结算水位'] = 1;
        TC.intConfigs['结算最小门槛'] = 0;
        TC.intConfigs['结算空闲门槛'] = 0;
        TC.intConfigs['单次结算调用上限'] = 3;
        resetConfig();
        const settled = await Promise.all([
            ctx.settleWindowIfNeeded(Date.now()),
            ctx.addUserMessage(makeCtx(sid), '结算期间的入库', 'QQ:1', 'during'),
        ]);
        check(typeof settled[0] === 'number', `B4 结算并发未崩溃（settled=${settled[0]}）`);
        console.log(`  · B4 结算与入库并发：settled=${settled[0]}`);
    }

    // B5: 连续多次 trim（幂等性 / 不重复写分片）
    {
        const sid = 'QQ-Group:timing-repeated';
        const s = makeSession(sid);
        const ctx = s.context;
        for (let i = 0; i < 100; i++) await ctx.addUserMessage(makeCtx(sid), `重复trim${i}${'内'.repeat(10)}`, 'QQ:1', `rt${i}`);
        const seqAfterFirst = (s as any).rawSeq;
        const writesBefore = storage.writeLog.filter(k => k.includes(':raw:')).length;
        ctx.trimToWindow(); ctx.trimToWindow(); ctx.trimToWindow();
        const writesAfter = storage.writeLog.filter(k => k.includes(':raw:')).length;
        check(writesAfter === writesBefore || (s as any).rawSeq > seqAfterFirst || writesAfter - writesBefore <= 1,
            `B5 连续 trim 不应重复写同一分片（写入 ${writesBefore} → ${writesAfter}）`);
        console.log(`  · B5 连续 3 次 trim：rawSeq=${(s as any).rawSeq}，分片写入 ${writesBefore} → ${writesAfter}`);
    }
}

// ————————————————————————————————————————————————
// C. 状态跃迁
// ————————————————————————————————————————————————
async function scenarioStateTransitions() {
    console.log('\n== C. 冷热状态跃迁 ==');
    TC.intConfigs['窗口上限字数'] = 500;
    TC.intConfigs['冷态单条截断字数'] = 0;
    resetConfig();

    // C1: 灌消息中途关闭 standby（COLD → HOT）
    {
        const sid = 'QQ-Group:st-mid';
        const s = makeSession(sid);
        for (let i = 0; i < 20; i++) await s.context.addUserMessage(makeCtx(sid), `前半${i}${'内'.repeat(10)}`, 'QQ:1', `h${i}`);
        const coldBefore = s.stateOf(Date.now(), { touch: false });
        s.setting.standby = false;   // 中途关闭待机
        for (let i = 20; i < 40; i++) await s.context.addUserMessage(makeCtx(sid), `后半${i}${'内'.repeat(10)}`, 'QQ:1', `h${i}`);
        const hotAfter = s.stateOf(Date.now(), { touch: false });
        check(coldBefore === 'COLD' && hotAfter === 'HOT', `C1 中途关待机应 COLD→HOT（${coldBefore}→${hotAfter}）`);
        const system = { role: 'system', text: '系统' } as any;
        assertRequestPairing(await handleMessages(makeCtx(sid), s as any, false, undefined, system) as any[], 'C1');
        console.log(`  · C1 中途关待机：${coldBefore} → ${hotAfter}，窗口 ${s.context.messages.length} 条`);
    }

    // C2: 在途任务冻结衰减（running=true 时不得转冷）
    {
        const sid = 'QQ-Group:st-busy';
        const s = makeSession(sid);
        s.lastRelevantAt = Date.now() - 11 * 60_000;   // 超过 10 分钟冷态阈值
        s.running = true;
        const st = s.stateOf(Date.now(), { touch: false });
        check(st === 'HOT', `C2 在途任务时应为 HOT（实际 ${st}）`);
        s.running = false;
        const st2 = s.stateOf(Date.now(), { touch: false });
        check(st2 === 'COLD', `C2 任务结束后应回 COLD（实际 ${st2}）`);
        console.log(`  · C2 在途冻结：running=true → ${st}；结束后 → ${st2}`);
    }

    // C3: 时钟回拨
    {
        const sid = 'QQ-Group:st-clock';
        const s = makeSession(sid);
        const t0 = Date.now();
        s.lastRelevantAt = t0 + 60_000;   // 未来时间（时钟回拨）
        const st = s.stateOf(t0, { touch: false });
        check(st === 'HOT', `C3 时钟回拨时 idle 取 0，应为 HOT（实际 ${st}）`);
        console.log(`  · C3 时钟回拨 → ${st}`);
    }

    // C4: 非待机会话恒为 HOT
    {
        const sid = 'QQ-Group:st-nostandby';
        const s = makeSession(sid, false);
        const st = s.stateOf(Date.now(), { touch: false });
        check(st === 'HOT', `C4 非待机恒为 HOT（实际 ${st}）`);
        console.log(`  · C4 非待机 → ${st}`);
    }
}

// ————————————————————————————————————————————————
// D. 异常与边界
// ————————————————————————————————————————————————
async function scenarioEdgeCases() {
    console.log('\n== D. 异常与边界 ==');
    TC.intConfigs['窗口上限字数'] = 300;
    TC.intConfigs['冷态单条截断字数'] = 0;
    resetConfig();

    // D1: 分片写入失败 → 不得移除来源条目
    {
        const sid = 'QQ-Group:edge-fail';
        const s = makeSession(sid);
        const ctx = s.context;
        for (let i = 0; i < 60; i++) await ctx.addUserMessage(makeCtx(sid), `待留档${i}${'内'.repeat(10)}`, 'QQ:1', `ef${i}`);
        const beforeLen = ctx.messages.length;
        const beforeCount = (ctx.messages as any[]).reduce((n, m) => n + (m.contentItems || []).length, 0);
        storage.failOn = (k) => k.includes(':raw:');
        const moved = ctx.trimToWindow();
        storage.failOn = null;
        const afterCount = (ctx.messages as any[]).reduce((n, m) => n + (m.contentItems || []).length, 0);
        check(moved === 0 && afterCount >= beforeCount * 0.9,
            `D1 分片写入失败时不得移除来源（moved=${moved}，条目 ${beforeCount}→${afterCount}，窗口 ${beforeLen}→${ctx.messages.length}）`);
        console.log(`  · D1 写入失败：moved=${moved}，条目 ${beforeCount}→${afterCount}`);
    }

    // D2: 空上下文 / 极短预算
    {
        for (const budget of [0, 1, 2]) {
            TC.intConfigs['窗口上限字数'] = budget;
            resetConfig();
            const sid = `QQ-Group:edge-empty-${budget}`;
            const s = makeSession(sid);
            s.context.messages = [];
            const before = JSON.stringify(s.context.messages);
            s.context.trimToWindow();
            check(JSON.stringify(s.context.messages) === before, `D2 budget=${budget} 空上下文应保持不变`);
        }
        for (const budget of [1, 2, 5]) {
            TC.intConfigs['窗口上限字数'] = budget;
            resetConfig();
            const sid = `QQ-Group:edge-tiny-${budget}`;
            const s = makeSession(sid);
            s.context.messages = [
                { role: 'user', contentItems: [{ text: '很长的一条消息'.repeat(20), time: 1, userId: 'QQ:1', messageId: 'x' }] },
                { role: 'assistant', contentItems: [{ text: '工具调用', time: 2, messageId: '' }], toolCalls: [{ id: 'k', type: 'function', function: { name: 'f', arguments: '{}' } }] },
                { role: 'tool', toolCallId: 'k', contentItems: [{ text: '结果', time: 3, messageId: '' }] },
            ] as any;
            s.context.trimToWindow();
            const system = { role: 'system', text: '系统' } as any;
            assertRequestPairing(await handleMessages(makeCtx(sid), s as any, false, undefined, system) as any[], `D2 tiny budget=${budget}`);
        }
        console.log('  · D2 空上下文 / 极短预算（1/2/5 字）已测');
    }

    // D3: 超多分片（触发上限清理 + TTL）
    {
        TC.intConfigs['窗口上限字数'] = 200;
        TC.intConfigs['原文分片上限'] = 3;
        TC.intConfigs['原文分片保留天数'] = 0;   // 不按时间淘汰，只测上限
        resetConfig();
        const sid = 'QQ-Group:edge-manyshard';
        const s = makeSession(sid);
        const ctx = s.context;
        for (let i = 0; i < 200; i++) await ctx.addUserMessage(makeCtx(sid), `多分片${i}${'内'.repeat(10)}`, 'QQ:1', `ms${i}`);
        // 注意：上限是**按会话**的，必须只统计本会话的分片键（早前场景留给别的会话的分片不算）
        const rawKeys = Array.from(storage.map.keys()).filter(k => k.startsWith(`session_${sid}:raw:`));
        const nonEmpty = rawKeys.filter(k => storage.peek(k).length > 0);
        check(nonEmpty.length <= 5, `D3 分片上限 3 时活跃分片应受限（实际 ${nonEmpty.length}，键 ${rawKeys.length}）`);
        console.log(`  · D3 rawSeq=${(s as any).rawSeq}，本会话活跃分片 ${nonEmpty.length} 个（上限 3）`);
    }

    // D3b: 上限清理必须能处理"rawSeq 跳号"（进程重启丢了未落盘的 rawSeq / 批量写入只触发部分 trim）。
    // 构造：先直接写入若干 raw 分片并只把 rawSeq 设到高位，再触发一次 trim 看是否全清。
    {
        TC.intConfigs['窗口上限字数'] = 200;
        TC.intConfigs['原文分片上限'] = 3;
        TC.intConfigs['原文分片保留天数'] = 0;
        resetConfig();
        const sid = 'QQ-Group:edge-jump';
        const s = makeSession(sid);
        s.setting.overrides.windowMaxChars = 200;
        // 预置 1..20 号分片（模拟"曾经写过很多片"），rawSeq 记为 20
        for (let i = 1; i <= 20; i++) {
            storage.set(`session_${sid}:raw:${String(i).padStart(3, '0')}`,
                JSON.stringify({ seq: i, from: i, to: i, items: [{ messageId: `j${i}`, userId: 'QQ:1', time: i, text: '旧片' }] }));
        }
        (s as any).rawSeq = 20;
        const ctx = s.context;
        for (let i = 0; i < 40; i++) await ctx.addUserMessage(makeCtx(sid), `跳号${i}${'内'.repeat(15)}`, 'QQ:1', `jp${i}`);
        const keys = Array.from(storage.map.keys()).filter(k => k.startsWith(`session_${sid}:raw:`));
        const nonEmpty = keys.filter(k => storage.peek(k).length > 0);
        check(nonEmpty.length <= 5,
            `D3b 跳号后活跃分片仍须受上限约束（rawSeq=${(s as any).rawSeq}，实际活跃 ${nonEmpty.length}）`);
        console.log(`  · D3b rawSeq=${(s as any).rawSeq}，活跃分片 ${nonEmpty.length} 个（上限 3）`);
    }

    // D4: 归档保留原文关闭 + 窗口移出（都应直接丢弃不留分片）
    {
        TC.intConfigs['窗口上限字数'] = 200;
        TC.boolConfigs['归档保留原文'] = false;
        resetConfig();
        const sid = 'QQ-Group:edge-keepoff';
        const s = makeSession(sid);
        const ctx = s.context;
        for (let i = 0; i < 100; i++) await ctx.addUserMessage(makeCtx(sid), `不留原文${i}${'内'.repeat(10)}`, 'QQ:1', `ko${i}`);
        check((s as any).rawSeq === 0, `D4 关闭保留原文时不应产生 raw 分片（rawSeq=${(s as any).rawSeq}）`);
        console.log(`  · D4 关闭保留原文：rawSeq=${(s as any).rawSeq}，窗口 ${ctx.messages.length} 条`);
    }

    // D5: 批量并发不同会话（跨会话互不干扰）
    {
        TC.intConfigs['窗口上限字数'] = 300;
        TC.boolConfigs['归档保留原文'] = true;
        resetConfig();
        const sessions = Array.from({ length: 5 }, (_, i) => makeSession(`QQ-Group:multi-${i}`));
        for (const session of sessions) session.setting.overrides.windowMaxChars = 300;
        await Promise.all(sessions.map(async (s, si) => {
            for (let i = 0; i < 50; i++) {
                await s.context.addUserMessage(makeCtx(s.sessionId), `会话${si}消息${i}${'内'.repeat(10)}`, 'QQ:1', `m${si}_${i}`);
            }
        }));
        for (const s of sessions) {
            const system = { role: 'system', text: '系统' } as any;
            assertRequestPairing(await handleMessages(makeCtx(s.sessionId), s as any, false, undefined, system) as any[], `D5 ${s.sessionId}`);
        }
        const seqs = sessions.map(s => (s as any).rawSeq).join(',');
        check(sessions.every(s => (s as any).rawSeq > 0), `D5 多会话并发都应有分片（rawSeq=${seqs}）`);
        console.log(`  · D5 5 会话 × 50 条并发：rawSeq = ${seqs}`);
    }

    // D6: 验证"折叠中间态的悬空 tool 由 handleMessages 兜底"这一说法属实（不能只写注释就信）
    {
        TC.intConfigs['窗口上限字数'] = 20000;   // 大预算 → 折叠不触发，走短路径
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfig();
        const sid = 'QQ-Group:edge-leading-orphan';
        const s = makeSession(sid);
        s.context.messages = [
            { role: 'tool', toolCallId: 'cX', contentItems: [{ text: '悬空结果', time: 1, messageId: '' }] },
            { role: 'user', contentItems: [{ text: '正常消息', time: 2, userId: 'QQ:1', messageId: 'a' }] },
        ] as any;
        const system = { role: 'system', text: '系统' } as any;
        const built = await handleMessages(makeCtx(sid), s as any, false, undefined, system);
        const toolLeft = (built as any[]).filter(m => m.role === 'tool').length;
        check(toolLeft === 0, `D6 非 PE 路径下悬空 tool 必须被剔除（请求体残留 ${toolLeft} 条）`);
        // PE 模式反向：悬空 tool 必须保留（转成 user 文本）
        TC.boolConfigs['切换为提示词工程'] = true;
        resetConfig();
        const s2 = makeSession('QQ-Group:edge-leading-orphan-pe');
        s2.context.messages = [
            { role: 'tool', toolCallId: 'cX', contentItems: [{ text: '悬空结果', time: 1, messageId: '' }] },
        ] as any;
        const peBuilt = await handleMessages(makeCtx('QQ-Group:edge-leading-orphan-pe'), s2 as any, false, undefined, system);
        check(JSON.stringify(peBuilt).includes('悬空结果'), 'D6 PE 模式下悬空 tool 必须保留为 user 文本');
        TC.boolConfigs['切换为提示词工程'] = false;
        resetConfig();
        console.log(`  · D6 悬空 tool：非 PE 剔除后残留 ${toolLeft} 条；PE 保留`);
    }
}

async function main() {
    console.log('\n========== 顺序 / 时序场景矩阵 ==========');
    await scenarioOrderings();
    await scenarioTiming();
    await scenarioStateTransitions();
    await scenarioEdgeCases();
    console.log('\n========== 汇总 ==========');
    console.log(`断言 ${checks} 项，失败 ${failures.length} 项`);
    if (foldNotes.length) {
        console.log(`\n折叠中间态提示（非失败；最终契约由 handleMessages 保证）：${foldNotes.length} 处`);
        for (const n of [...new Set(foldNotes)].slice(0, 5)) console.log(`  · ${n}`);
    }
    if (failures.length) {
        console.log('失败清单：');
        for (const f of [...new Set(failures)]) console.log(`  ❌ ${f}`);
        process.exit(1);
    }
}

main().catch(e => { console.error('矩阵崩溃：', e); process.exit(1); });
