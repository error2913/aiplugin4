/**
 * 模拟验收入口：驱动真实 Context/Session/handleMessages，测量 docs/14 §6 的验收数字。
 * 由 scripts/sim.cjs 打包后执行（esbuild → CJS）。
 */
import Config from "../src/config/config";
import { ext } from "../src/config/config";
import { Context, estimateContextMessagesTokens } from "../src/context/context";
import { Session } from "../src/session/session";
import { SessionService } from "../src/session/session_service";
import Agent from "../src/agent/agent";
import { buildContent, handleMessages } from "../src/utils/message";
import { MemoryManager } from "../src/memory/manager";
import { UsageManager } from "../src/usage";

const TC = (globalThis as any).__TEST_CONFIG__;

// 与生产一致：注册配置组（否则 Config.context 等 getter 不存在）
Config.registerConfig();

/** —— 假存储：模拟海豹 storage 的**叠加式**特性（写同样内容也占新空间）+ 不存在即抛异常 —— */
class FakeStorage {
    /** 已写入的字节总量（叠加式：每次 set 都累加，用于模拟真实占用增长） */
    writtenBytes = 0;
    /** 每次 set 调用计数（= 「落盘次数」验收数字） */
    setCalls = 0;
    private map = new Map<string, string>();
    /** 每次 set 的 key 顺序（用于分析写入放大 / 分片幂等） */
    writeLog: string[] = [];
    get(k: string): string {
        if (!this.map.has(k)) throw new Error('key not found');
        return this.map.get(k)!;
    }
    set(k: string, v: string): void {
        this.setCalls++;
        this.writtenBytes += v.length;
        this.writeLog.push(k);
        this.map.set(k, v);
    }
    /** 当前"活跃"键数（分片数等） */
    get liveKeys(): number { return Array.from(this.map.keys()).filter(k => (this.map.get(k) || '').length > 0).length; }
    keyLen(prefix: string): number { return Array.from(this.map.keys()).filter(k => k.startsWith(prefix)).length; }
    /** 安全读取（模拟"不存在即抛异常"的真实语义，但给调用方一个不抛的入口） */
    peek(k: string): string { return this.map.get(k) ?? ''; }
}

const storage = new FakeStorage();
(ext as any).storageGet = (k: string) => storage.get(k);
(ext as any).storageSet = (k: string, v: string) => storage.set(k, v);

/** —— 假模型 + 会话服务：用真实 SessionService，使 flushGroupUserMemories 等路径也被真实走一遍 —— */
const llm = { calls: 0, byUse: {} as Record<string, number> };
const sessionStore = new Map<string, Session>();

const realService = new SessionService();
realService.agentName = 'default';
/** 让 SessionService 用我们的假存储 + 返回已构造好的会话 */
(realService as any).getSession = function (id: string) {
    if (sessionStore.has(id)) return sessionStore.get(id)!;
    const s = new Session();
    s.sessionId = id;
    s.sessionType = id.includes('-Group:') ? 'group' : 'user';
    s.agentName = 'default';
    sessionStore.set(id, s);
    return s;
};

const fakeAgent = {
    sessionService: realService,
    chat: async () => { llm.calls++; llm.byUse['agent'] = (llm.byUse['agent'] || 0) + 1; return '（模拟回复）'; },
};
Agent.get = ((name: string) => fakeAgent) as any;

/** 让 summarize 走假实现：计入 LLM 调用，避免真的打网络 */
const origSummarize = MemoryManager.summarizeChunkWithRetry;
(MemoryManager as any).summarizeChunkWithRetry = async (session: Session, msgs: any[]) => {
    llm.calls++;
    llm.byUse['summarization'] = (llm.byUse['summarization'] || 0) + 1;
    return true;
};

/**
 * 压缩智能体（LLM）的假实现：**冷态零 LLM 的断言只看它**。
 * 说明：Agent.get('compress_agent').chat 才是"压缩调用"；User.get() 的存储读取失败日志
 * 与此无关（会被 Logger 记成 ERROR），不要混进 LLM 计数。
 */
const compressCounter = { calls: 0 };
const origGet = Agent.get;
Agent.get = ((name: string) => {
    if (name === 'compress_agent') {
        return {
            chat: async (t: string) => {
                compressCounter.calls++;
                llm.calls++; llm.byUse['compression'] = (llm.byUse['compression'] || 0) + 1;
                if (compressCounter.calls <= 3) {
                    console.log(`    [压缩被调用 #${compressCounter.calls}] 输入前 60 字：${String(t).slice(0, 60)}`);
                    console.log(`      调用栈：${new Error().stack?.split('\n').slice(2, 6).map(s => s.trim()).join(' | ')}`);
                }
                return '（模拟压缩结果）';
            },
        };
    }
    if (name === 'summarize_agent') {
        return {
            chat: async () => { llm.calls++; llm.byUse['summarization'] = (llm.byUse['summarization'] || 0) + 1; return '{"facts":[]}'; },
        };
    }
    return fakeAgent;
}) as any;

function resetConfig() { (Config as any).cache = {}; }

/** 设立"待机群"会话 */
function makeStandbyGroup(sid: string): Session {
    const s = new Session();
    s.sessionId = sid;
    s.sessionType = 'group';
    s.agentName = 'default';
    s.setting.standby = true;
    s.lastRelevantAt = Date.now() - 11 * 60_000;   // 超过 10 分钟阈值 → 冷态
    // 关键：Context.session 是经 agent.sessionService.getSession(context.sessionId) 取的，
    // 必须让 context 知道自己的 sessionId，否则 isColdSession() 会落到别的会话上（真实踩过的坑）。
    (s.context as any).sessionId = sid;
    (s.context as any).agentName = 'default';
    sessionStore.set(sid, s);
    return s;
}

function makeCtx(sid: string): any {
    return {
        endPoint: { userId: 'QQ:9001' },
        player: { userId: 'QQ:9001', name: '测试群友' },
        group: { groupId: sid },
        isPrivate: false,
    };
}

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
    results.push({ name, pass, detail });
    console.log(`${pass ? '  ✅' : '  ❌'} ${name} — ${detail}`);
}

async function scenarioColdIngest() {
    console.log('\n== 场景 1：待机群灌 1000 条普通消息（机器人没被 @） ==');
    const sid = 'QQ-Group:sim1';
    const session = makeStandbyGroup(sid);
    const ctx = session.context;

    resetConfig();
    const before = { compressCalls: compressCounter.calls, setCalls: storage.setCalls, bytes: storage.writtenBytes };

    const N = 1000;
    console.log(`  · 灌消息前：stateOf=${session.stateOf(Date.now(), { touch: false })}，standby=${session.setting.standby}，GLOBAL_STANDBY=${Config.base.GLOBAL_STANDBY}`);
    for (let i = 0; i < N; i++) {
        const text = i % 37 === 0
            ? `第${i}条超长消息${'内容'.repeat(400)}`   // 制造单条超长，触发冷态截断
            : `第${i}条群聊消息，大家在聊一些日常话题${'补充'.repeat(i % 5)}`;
        await ctx.addUserMessage(makeCtx(sid), text, `QQ:${1000 + (i % 20)}`, `msg${i}`);
    }
    // 冷态入库走 save(true)（合并写，5 秒窗口）。真实环境里这 5 秒会被后续消息自然跨过；
    // 这里显式补一次 save() 把待写内容落盘，否则量到的"落盘 0 次"只是节流还没到期。
    session.save();

    const llmDelta = compressCounter.calls - before.compressCalls;
    const setDelta = storage.setCalls - before.setCalls;
    const bytesDelta = storage.writtenBytes - before.bytes;
    const rendered = ctx.messages.reduce((n, m: any) => n + buildContent(m).length, 0);

    // 验收数字
    check('压缩调用为 0（冷态零 LLM）', llmDelta === 0, `本次新增压缩调用 ${llmDelta} 次`);
    check('落盘次数 ≤ 50 次/1000 条', setDelta <= 50, `实际落盘 ${setDelta} 次（原实现为 ${N} 次）`);
    // 体积上界：用"灌两倍消息后 blob 是否仍近似不变"来证明**与消息总量解耦**（单纯比原文长度没有意义）
    const blob1 = storage.peek(`session_${sid}`).length;
    const before2 = { compress: compressCounter.calls };
    for (let i = 0; i < N; i++) {
        await ctx.addUserMessage(makeCtx(sid), `追加第${i}条群聊消息，继续聊日常话题${'补充'.repeat(3)}`, `QQ:${1000 + (i % 20)}`, `more${i}`);
    }
    session.save();
    const blob2 = storage.peek(`session_${sid}`).length;
    check('再灌 1000 条后 session 体积仍近似不变（与消息总量解耦）',
        blob2 <= blob1 * 1.5 && (compressCounter.calls - before2.compress) === 0,
        `blob ${blob1} → ${blob2} 字（消息总量 1000 → 2000 条），期间压缩调用 ${compressCounter.calls - before2.compress} 次`);
    check('窗口移出确实生效（raw 分片存在）', (session as any).rawSeq > 0,
        `rawSeq=${(session as any).rawSeq}，raw 分片键 ${storage.keyLen(`session_${sid}:raw:`)} 个`);

    console.log(`  · 累计写入 ${bytesDelta} 字，storage 活跃键 ${storage.liveKeys} 个`);
    // 写入放大的构成：分片只写一次（幂等），会话 blob 会被反复重写
    const shardWrites = (storage as any).writeLog.filter((k: string) => k.includes(':raw:') || k.includes(':arc:'));
    const dupShardWrites = shardWrites.length - new Set(shardWrites).size;
    check('分片只写一次（幂等，无重复写）', dupShardWrites === 0,
        `分片写入 ${shardWrites.length} 次，重复写 ${dupShardWrites} 次；会话 blob 写入 ${(storage as any).writeLog.filter((k: string) => k.startsWith('session_') && !k.includes(':raw:') && !k.includes(':arc:')).length} 次`);
    return { session, ctx, sid };
}

async function scenarioSettle(session: Session, sid: string) {
    console.log('\n== 场景 2：记忆结算（三条件） ==');
    // 放开结算门槛，模拟"积压够了 + 转冷"
    TC.intConfigs['结算水位'] = 1;
    TC.intConfigs['结算最小门槛'] = 0;
    TC.intConfigs['结算空闲门槛'] = 600;
    TC.intConfigs['单次结算调用上限'] = 100;
    resetConfig();

    const beforeCalls = llm.calls;
    const settled = await session.context.settleWindowIfNeeded(Date.now());
    const delta = llm.calls - beforeCalls;
    check('按水位结算并沉淀记忆', settled > 0, `本次结算 ${settled} 个分片，summarize 调用 ${delta} 次`);
    check('水位幂等（settledSeq 推进）', (session as any).settledSeq === settled,
        `settledSeq=${(session as any).settledSeq} / 本次 ${settled}`);

    // 再跑一次应无事可做
    const again = await session.context.settleWindowIfNeeded(Date.now());
    check('重复调用不重复总结', again === 0, `第二次结算 ${again} 个分片`);
}

async function scenarioTurnHot(session: Session, sid: string) {
    console.log('\n== 场景 3：@ 一次 → 转热，检查首轮请求 ==');
    // 模拟"有人跟机器人说话"：session.chat 会刷新 lastRelevantAt
    (session as any).lastRelevantAt = Date.now();
    (session as any).chat = async () => undefined;
    const state = session.stateOf(Date.now(), { touch: false });
    check('转热后状态为 HOT', state === 'HOT', `stateOf()=${state}`);

    // 构造带工具轮的上下文，验证"工具结果必须保留"
    const ctx = session.context;
    ctx.messages.push({
        role: 'assistant',
        contentItems: [{ text: '我需要查一下天气', time: Math.floor(Date.now() / 1000), messageId: '' }],
        toolCalls: [{ id: 'call_sim_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    } as any);
    ctx.messages.push({
        role: 'tool',
        toolCallId: 'call_sim_1',
        contentItems: [{ text: '晴，25 度', time: Math.floor(Date.now() / 1000), messageId: '' }],
    } as any);
    await ctx.addUserMessage(makeCtx(sid), '那今天适合出门吗', 'QQ:1001', 'msg_hot');

    const system = { role: 'system', text: '你是测试机器人' } as any;
    const built = await handleMessages(makeCtx(sid), session as any, false, undefined, system);

    // 工具配对：请求体里不得有孤儿 tool
    const callIds = new Set<string>();
    for (const m of built as any[]) for (const tc of (m.tool_calls || [])) if (tc?.id) callIds.add(String(tc.id));
    const orphan = (built as any[]).filter(m => m.role === 'tool' && !callIds.has(String(m.tool_call_id)));
    check('工具结果仍在且无孤儿 tool', orphan.length === 0,
        `tool 消息 ${(built as any[]).filter(m => m.role === 'tool').length} 条，孤儿 ${orphan.length} 条`);

    const totalChars = built.reduce((n, m: any) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const budget = Config.context.COLD_WINDOW_CHARS;
    check('首轮整包 ≤ 冷态窗口 × 1.2（含折叠摘要）', totalChars <= budget * 1.2,
        `整包 ${totalChars} 字 / 窗口 ${budget} 字`);

    const hasFold = JSON.stringify(built).includes('折叠摘要');
    console.log(`  · 是否出现折叠摘要：${hasFold ? '是' : '否'}（窗口装得下时不折叠是正常的）`);
}

async function scenarioKeepRawOff() {
    console.log('\n== 场景 4：关闭「归档保留原文」 ==');
    TC.boolConfigs['归档保留原文'] = false;
    TC.intConfigs['对话保存轮数'] = 1;
    TC.intConfigs['上下文最大token'] = 20;
    resetConfig();
    const sid = 'QQ-Group:sim-keepraw';
    const session = makeStandbyGroup(sid);
    session.context.messages = [
        { role: 'user', contentItems: [{ text: 'u1 原文', time: 10, userId: 'QQ:1', messageId: 'm1' }] },
        { role: 'assistant', contentItems: [{ text: 'a1', time: 11, messageId: '' }] },
        { role: 'user', contentItems: [{ text: 'u2', time: 12, userId: 'QQ:1', messageId: 'm2' }] },
        { role: 'assistant', contentItems: [{ text: 'a2', time: 13, messageId: '' }] },
    ] as any;
    const beforeSum = llm.byUse['summarization'] || 0;
    const outcome = await session.context.archiveByTokenIfNeeded();
    const afterSum = llm.byUse['summarization'] || 0;
    check('关闭后归档不写分片', session.archiveSeq === 0, `archiveSeq=${session.archiveSeq}`);
    check('关闭后仍沉淀记忆（只是不留原文）', afterSum > beforeSum,
        `summarization 调用 ${beforeSum} → ${afterSum}`);
    check('消息仍被移出上下文', session.context.messages.length < 4,
        `剩余 ${session.context.messages.length} 条`);
}

async function scenarioForgetAll() {
    console.log('\n== 场景 5：.ai forget --all 清理分片 ==');
    const sid = 'QQ-Group:sim-forget';
    const session = makeStandbyGroup(sid);
    // 造两个分片
    storage.set(`session_${sid}:arc:001`, JSON.stringify({ seq: 1, from: 1, to: 1, items: [{ messageId: 'a', userId: 'QQ:1', time: 1, text: '归档' }] }));
    storage.set(`session_${sid}:raw:001`, JSON.stringify({ seq: 1, from: 1, to: 1, items: [{ messageId: 'b', userId: 'QQ:1', time: 1, text: '移出' }] }));
    (session as any).archiveSeq = 1;
    (session as any).rawSeq = 1;
    (session as any).settledSeq = 1;

    const { registerCmdForget } = require('../src/cmd/sub_cmd/forget');
    const { SubCmd } = require('../src/cmd/root_cmd');
    registerCmdForget();
    let replied = '';
    (globalThis as any).seal.replyToSender = (_c: any, _m: any, t: string) => { replied = String(t); };
    await SubCmd.map['forget'].solve({
        ctx: makeCtx(sid), msg: {} as any,
        cmdArgs: { kwargs: [{ name: 'all' }], getArgN: () => '' } as any,
        epId: 'QQ:9001', uid: 'QQ:9001', gid: sid, sid,
        session, page: 1, ret: {} as any,
    });
    check('.ai forget --all 清空分片并重置水位',
        (session as any).archiveSeq === 0 && (session as any).rawSeq === 0 && replied.includes('已清除'),
        `archiveSeq=${(session as any).archiveSeq} rawSeq=${(session as any).rawSeq}，回复：${replied.slice(0, 40)}…`);
}

async function main() {
    console.log('\n========== aiplugin4 上下文成本治理 · 模拟验收 ==========');
    console.log(`配置：窗口上限 ${Config.context.WINDOW_MAX_CHARS} 字 · 冷态窗口 ${Config.context.COLD_WINDOW_CHARS} 字 · `
        + `归档保留原文 ${Config.context.ARCHIVE_KEEP_RAW}`);

    const { session, sid } = await scenarioColdIngest();
    await scenarioSettle(session, sid);
    await scenarioTurnHot(session, sid);
    await scenarioKeepRawOff();
    await scenarioForgetAll();

    const failed = results.filter(r => !r.pass);
    console.log('\n========== 汇总 ==========');
    console.log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
    if (failed.length > 0) {
        console.log('失败项：');
        for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
    }
    console.log(`\nLLM 调用统计：${JSON.stringify(llm.byUse)}（总计 ${llm.calls}）`);
    console.log(`存储统计：set 调用 ${storage.setCalls} 次 · 累计写入 ${storage.writtenBytes} 字 · 活跃键 ${storage.liveKeys} 个`);

    (MemoryManager as any).summarizeChunkWithRetry = origSummarize;
    if (failed.length > 0) process.exit(1);
}

main().catch(e => { console.error('模拟崩溃：', e); process.exit(1); });
