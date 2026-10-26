// 记忆模块候选缺陷实验（A~N + 补充项）
// 仅用 MemoryEngine 构造注入（InMemoryMemoryStorage / embedding / extractor / rerank /
// synthesizeObservation / reflectSynthesizer / now），不调用任何真实 LLM/网络。
// 由 .dev/memory-audit/run.cjs 用 esbuild 打包后 node 运行。
import { MemoryEngine } from '../../src/memory/v2/engine';
import { InMemoryMemoryStorage } from '../../src/memory/v2/storage';
import {
    buildGroupedMemoryPrompt,
    buildLongTermMemoryPrompt,
    selectInjectionCandidates,
} from '../../src/memory/v2/prompt';
import { estimateTokens } from '../../src/memory/v2/scoring';
import type { Observation, RecallResult, ReflectSynthesizer } from '../../src/memory/v2/types';

const SEC = () => Math.floor(Date.now() / 1000);

function emit(id: string, detail: Record<string, unknown>): void {
    console.log('RESULT ' + id + ' ' + JSON.stringify(detail));
}

function obsOf(partial: Partial<Observation> & { id: string; bankId: string }): Observation {
    const t = SEC();
    return {
        text: '观察',
        scopeTags: [],
        evidence: [],
        proofCount: 0,
        createdAt: t,
        updatedAt: t,
        lastVerifiedAt: t,
        history: [{ text: '观察', reason: 'created', at: t }],
        ...partial,
    } as Observation;
}

function makeEngine(opts: Record<string, unknown> = {}): MemoryEngine {
    return new MemoryEngine({ storage: new InMemoryMemoryStorage(), ...opts } as any);
}

const cases: Array<{ id: string; ok: boolean; detail: unknown }> = [];

async function runCase(id: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
    try {
        const detail = await fn();
        cases.push({ id, ok: true, detail });
        emit(id, detail);
    } catch (e: any) {
        const detail = { error: String((e && e.stack) || e) };
        cases.push({ id, ok: false, detail });
        emit(id, detail);
    }
}

// ================= A. retain 精确查重合并 =================
async function caseA(): Promise<Record<string, unknown>> {
    const e = makeEngine();
    e.ensureBank('user_A', 'user');
    const r1 = await e.addMemory('user_A', {
        content: '用户喜欢喝咖啡',
        tags: ['user:QQ1', 'vis:public'],
        metadata: { type: 'text' },
        occurrence: undefined,
    } as any);
    const r2 = await e.addMemory('user_A', {
        content: '用户 喜欢 喝 咖啡', // 归一化（去空白/小写）后与上一条相同
        tags: ['user:QQ2', 'kw:drink'],
        metadata: { type: 'event' },
        importance: 0.9,
        factType: 'experience',
        occurredStart: 1700000000,
    } as any);
    const r3 = await e.addMemory('user_A', {
        content: '用户喜欢喝咖啡！', // 仅标点差异，归一化后不同
        tags: ['user:QQ1'],
    } as any);
    const bank = e.repository.getBank('user_A')!;
    const merged = bank.units[0];
    return {
        write1: r1,
        write2: r2,
        write3_punctuationOnly: r3,
        unitCount: bank.units.length,
        mergedTags: merged.tags,
        mergedMetadata: merged.metadata,
        mergedAccessCount: merged.accessCount,
        mergedImportance: merged.importance,
        mergedFactType_afterWrite2: merged.factType,
        mergedOccurredStart_afterWrite2: merged.occurredStart,
        note: '归一化=trim+小写+去全部空白；两次写入合并成 1 条，accessCount+1 且 tags/metadata/importance 被后写覆盖/并集',
    };
}

// ================= B. tagsMatch 默认 any =================
async function caseB(): Promise<Record<string, unknown>> {
    const e = makeEngine();
    e.ensureBank('group_B', 'group');
    const u1 = await e.addMemory('group_B', { content: '用户1喜欢猫', tags: ['user:QQ1', 'group:100', 'vis:public'] });
    const u9 = await e.addMemory('group_B', { content: '用户9是管理员', tags: ['user:QQ9', 'vis:public'] });
    const u3 = await e.addMemory('group_B', { content: '群规则：晚上不刷屏', tags: ['group:100', 'vis:public'] });
    const u4 = await e.addMemory('group_B', { content: '用户1的私人备注', tags: ['user:QQ1', 'vis:public'] });
    const tags = ['user:QQ1', 'group:100'];
    const any = await e.recall('group_B', '喜欢 管理员 规则 备注', { tags, maxTokens: 2000 });
    const all = await e.recall('group_B', '喜欢 管理员 规则 备注', { tags, tagsMatch: 'all', maxTokens: 2000 });
    const groupOnly = await e.recall('group_B', '喜欢 管理员 规则 备注', { tags: ['group:100'], maxTokens: 2000 });
    const ids = (rs: RecallResult[]) => rs.map(r => r.unit.id);
    return {
        defaultTagsMatchEffective: 'any（engine.ts:292 options.tagsMatch || "any"）',
        ids_any: ids(any),
        units_any: any.map(r => r.unit.text),
        ids_all: ids(all),
        ids_groupOnly: ids(groupOnly),
        u1: u1.unitIds[0],
        u9_nonParticipant: u9.unitIds[0],
        u3_groupOnlyTag: u3.unitIds[0],
        u4_userOnlyTag: u4.unitIds[0],
        leak_nonParticipant: ids(any).includes(u9.unitIds[0]),
        leak_userOnlyIntoGroupScope: ids(any).includes(u4.unitIds[0]),
        note: 'any 下 user-only 标签单元进入群聊召回；非参与方(QQ9)未进入 → 越权未复现，但归属标签过滤被放宽',
    };
}

// ================= C. 语义通路无相似度下限 / 无 embedding 退化 =================
async function caseC(): Promise<Record<string, unknown>> {
    // C1：embedding 使查询向量与全部记忆正交（cosine=0），语义通路仍全量进入候选
    const e1 = makeEngine({ embedding: async (t: string) => (t.includes('查询') ? [1, 0] : [0, 1]) });
    await e1.addMemory('user_C1', { content: '用户喜欢喝咖啡' });
    await e1.addMemory('user_C1', { content: '用户养了一只猫' });
    await e1.addMemory('user_C1', { content: '用户在杭州工作' });
    const r1 = await e1.recall('user_C1', '查询', { maxTokens: 2000 });
    const c1 = {
        returned: r1.map(r => ({ text: r.unit.text, strategies: r.matchedStrategies, score: Number(r.score.toFixed(4)) })),
        semanticMinCosine: 0,
        note: '3 条完全无关记忆全部带 semantic 策略返回（semanticLimit=50，无阈值）',
    };

    // C2：无 embedding（未配置）时，语义通路消失；关键词/图/时间全 0 分仍由 backfill 兜底全量返回
    const e2 = makeEngine();
    const texts = ['记忆甲内容', '记忆乙内容', '记忆丙内容', '记忆丁内容', '记忆戊内容'];
    for (const t of texts) await e2.addMemory('user_C2', { content: t });
    const r2 = await e2.recall('user_C2', '查询', { maxTokens: 20 });
    const c2 = {
        returnedOrder: r2.map(r => r.unit.text),
        strategies: r2.map(r => r.matchedStrategies),
        insertionOrder: texts,
        note: '无 embedding 时 semantic 通路消失（剩 keyword/graph/temporal 三路）；三路均 0 分时 backfill 按数组插入序（最旧优先）填满 token 预算',
    };

    // C3：embedding 抛错 → 静默降级（与未配置同路径），不报错
    const e3 = makeEngine({ embedding: async () => { throw new Error('embedding down'); } });
    await e3.addMemory('user_C3', { content: '记录一' });
    const r3 = await e3.recall('user_C3', '查询', { maxTokens: 200 });
    const c3 = { returned: r3.length, matchedStrategies: r3.map(r => r.matchedStrategies), note: 'embedding 异常被 embedText 吞掉，语义静默关闭' };
    return { c1, c2, c3 };
}

// ================= D. reflect 注入范围与必调 LLM =================
async function caseD(): Promise<Record<string, unknown>> {
    const calls: Array<Record<string, any>> = [];
    const synth: ReflectSynthesizer = async (q, ctx) => {
        calls.push({ q, mm: ctx.mentalModels.length, obs: ctx.observations.length, mem: ctx.memories.length });
        return '合成答案' + calls.length;
    };
    const e = makeEngine({ reflectSynthesizer: synth });
    e.ensureBank('user_D', 'user');
    await e.createMentalModel('user_D', '用户QQ2的设定是什么？', 'A'.repeat(200), ['user:QQ2']);
    await e.createMentalModel('user_D', '用户QQ3的偏好是什么？', 'B'.repeat(200), ['user:QQ3']);
    await e.createMentalModel('user_D', '用户QQ4的雷点是什么？', 'C'.repeat(200), ['user:QQ4']);
    await e.createMentalModel('user_D', '待生成问题？', '', ['user:QQ2']); // pending 不应注入
    const now = SEC();
    for (let i = 0; i < 3; i++) {
        e.repository.addObservation('user_D', obsOf({
            id: 'obs_D' + i, bankId: 'user_D', text: '观察' + i + '：' + 'D'.repeat(200), scopeTags: ['user:QQ9'],
            evidence: [], proofCount: 0, updatedAt: now - i,
        }));
    }
    const r1 = await e.reflect('user_D', '用户喜欢什么？', { scopeTags: ['user:QQ1'], factTypes: ['world'] });
    const r2 = await e.reflect('user_D', '用户喜欢什么？', { scopeTags: ['user:QQ1'], factTypes: ['world'] });
    const r3 = await e.reflect('user_D', '用户喜欢什么？', { factTypes: ['world'] }); // 不带 scopeTags
    const payloadChars = r3.basedOn.mentalModels.reduce((a, m) => a + m.answer.length, 0)
        + r3.basedOn.observations.reduce((a, o) => a + o.text.length, 0);
    const emptyCalls = { n: 0 };
    const e2 = makeEngine({ reflectSynthesizer: async () => { emptyCalls.n++; return '空库答案'; } });
    e2.ensureBank('user_D_empty', 'user');
    await e2.reflect('user_D_empty', '空库问题？');
    return {
        scopeTagsGiven_QQ1: {
            injectedMentalModels: r1.basedOn.mentalModels.length,
            injectedObservations: r1.basedOn.observations.length,
            llmCalls: 2,
            identicalQueryCalledTwice: calls.length === 2,
        },
        noScopeTags_factTypes_world: {
            injectedObservations: r3.basedOn.observations.length,
            injectedMentalModels: r3.basedOn.mentalModels.length,
            note: 'factTypes 只作用于 unit 召回，不约束 observations',
        },
        payloadChars,
        emptyBankLlmCalls: emptyCalls.n,
        calls,
        note: 'ready 心智模型全量注入（3 条 scopeTags 全不匹配仍注入）；pending 不注入；每次 reflect 必调 LLM（同 query 2 次 = 2 次调用，空库也调）',
    };
}

// ================= E. delta 刷新 = 文本整体重写 =================
async function caseE(): Promise<Record<string, unknown>> {
    const clock = 1700000000;
    const captured: Array<Record<string, any>> = [];
    const e = makeEngine({
        now: () => clock,
        reflectSynthesizer: async (_q, ctx) => {
            captured.push({
                mode: ctx.mode,
                existingAnswer: ctx.existingAnswer,
                memories: ctx.memories.map(m => m.text),
                mentalModels: ctx.mentalModels.map(m => m.question),
            });
            return '新答案：A段 - B段 - C段'; // 模拟 LLM 重排格式（A/B/C 段语义未改）
        },
    });
    e.ensureBank('user_E', 'user');
    const old = await e.addMemory('user_E', { content: '旧记忆：用户喜欢咖啡' });
    const oldUnit = e.repository.getUnit('user_E', old.unitIds[0])!;
    oldUnit.updatedAt = clock - 100; // 人工把旧记忆时间压到 watermark 之前（retain 内部用真实时钟，见补充项 O）
    e.repository.updateUnit('user_E', oldUnit);
    const mm = await e.createMentalModel('user_E', '这个用户的偏好是什么？', '旧答案：A段-B段-C段', [], { mode: 'delta' });
    const nu = await e.addMemory('user_E', { content: '新记忆：用户最近改喝美式' });
    const newUnit = e.repository.getUnit('user_E', nu.unitIds[0])!;
    newUnit.updatedAt = clock + 10;
    newUnit.createdAt = clock + 10;
    e.repository.updateUnit('user_E', newUnit);
    const summary = await e.refreshMentalModels('user_E', mm.id, { reason: 'manual' });
    const after = e.repository.listMentalModels('user_E')[0];
    const keys = Object.keys(after);
    const oldSegments = ['A段', 'B段', 'C段'];
    const stillAfter = oldSegments.map(s => after.answer.includes(s));
    return {
        captured,
        summary,
        oldAnswer: '旧答案：A段-B段-C段',
        newAnswerStored: after.answer,
        versionAfter: after.version,
        historyTop: after.history[after.history.length - 1],
        modelKeys: keys,
        hasStructuredContentField: keys.some(k => /structured/i.test(k)),
        unchangedSegmentsStillPresentVerbatim: stillAfter,
        note: 'delta 仅把 旧答案+新记忆 交给返回单一字符串的 synthesizer；答案被整体替换，无 AST/类型化编辑，未变更段落无法保证逐字节不变',
    };
}

// ================= E2(补充 Q). 秒级 watermark 边界：同秒新记忆进不了 delta 窗口 =================
async function caseQ(): Promise<Record<string, unknown>> {
    let scenario: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 8; attempt++) {
        const e = makeEngine({ reflectSynthesizer: async () => '刷新后的答案' });
        const bank = 'user_Q' + attempt;
        e.ensureBank(bank, 'user');
        await e.addMemory(bank, { content: '旧记忆' });
        const mm = await e.createMentalModel(bank, '这个用户有什么变化？', '旧答案', [], { mode: 'delta' });
        const r = await e.addMemory(bank, { content: '同一秒写入的新记忆' });
        const unit = e.repository.getUnit(bank, r.unitIds[0])!;
        const newest = Math.max(...e.repository.listUnits(bank).filter(u => u.state === 'valid').map(u => u.updatedAt));
        const natural = mm.lastMemorySeenAt === newest;
        // 若两次操作跨秒，则人为复刻「上次刷新发生在该秒」的水位（等价于同秒时序）
        if (!natural) mm.lastMemorySeenAt = newest;
        e.repository.updateMentalModel(bank, mm);
        const captured: string[][] = [];
        (e as any).reflectSynthesizer = async (_q: string, ctx: any) => {
            captured.push(ctx.memories.map((m: any) => m.text));
            return '答案';
        };
        const noForce = await e.refreshMentalModels(bank, mm.id, { reason: 'manual' });
        let forced: any = null;
        if (natural) {
            forced = await e.refreshMentalModels(bank, mm.id, { reason: 'manual', force: true });
        }
        scenario = {
            attempt,
            naturalSameSecond: natural,
            watermark: mm.lastMemorySeenAt,
            newestUnitUpdatedAt: newest,
            equalTimestamps: mm.lastMemorySeenAt === newest,
            noForceSummary: noForce,
            deltaWindowMemoriesWhenForced: natural ? captured[0] : 'n/a',
            forcedSummary: forced,
        };
        if (natural) break;
    }
    return {
        ...scenario,
        note: 'watermark 与 unit.updatedAt 均为秒级；相等时 staleness gating 判定 not_stale、delta createdAfter 过滤要求 updatedAt > watermark → 该秒写入的记忆不会进入 delta（乃至 force 也不会），直到后续新记忆到来',
    };
}

// ================= F. observation 无趋势枚举 / 过期物理删除 =================
async function caseF(): Promise<Record<string, unknown>> {
    const e = makeEngine({ synthesizeObservation: async (quotes: string[]) => '观察：' + quotes.join('；') });
    e.ensureBank('user_F', 'user');
    await e.addMemory('user_F', { content: '小明喜欢咖啡', entities: ['小明'] });
    await e.addMemory('user_F', { content: '小明常去星巴克', entities: ['小明'] });
    await e.consolidate('user_F');
    const obs = e.repository.listObservations('user_F')[0];
    const obsUnit = e.repository.getUnit('user_F', obs.id);
    const keys = Object.keys(obs);
    const historyReasons = obs.history.map(h => h.reason);
    // 把观察压成过期（>90 天未验证）后再次 consolidate
    obs.lastVerifiedAt = SEC() - 91 * 86400;
    obs.updatedAt = SEC() - 91 * 86400;
    e.repository.updateObservation('user_F', obs);
    const unitsBefore = e.repository.listUnits('user_F').map(u => ({ id: u.id, type: u.factType, state: u.state, cs: u.consolidationState }));
    const evidenceQuotesBefore = obs.evidence.map(ev => ev.quote);
    await e.consolidate('user_F');
    const unitsAfter = e.repository.listUnits('user_F').map(u => ({ id: u.id, type: u.factType, cs: u.consolidationState }));
    return {
        observationKeys: keys,
        hasTrendField: keys.some(k => /trend|status|stale/i.test(k)),
        historyReasons,
        evidenceQuotesBefore,
        obsUnitEmbeddingAtCreate: obsUnit ? obsUnit.embedding : null,
        observationsAfterStaleConsolidate: e.repository.listObservations('user_F').length,
        obsUnitAfterStaleConsolidate: e.repository.getUnit('user_F', obs.id),
        unitsBefore,
        unitsAfter,
        note: 'Trend 枚举不存在（history reason 只有 created/refined/merged 被代码使用）；过期观察被物理删除，证据链（observation.evidence 引用）随之丢失，原始 unit 保留但 consolidationState=done',
    };
}

// ================= G. consolidate 后自动刷新是否全量 =================
async function caseG(): Promise<Record<string, unknown>> {
    const clock = SEC() - 300;
    const calls: string[] = [];
    const e = makeEngine({
        now: () => clock,
        reflectSynthesizer: async (q) => { calls.push(q); return '答案:' + q; },
    });
    e.ensureBank('group_G', 'group');
    const a1 = await e.addMemory('group_G', { content: 'A 喜欢猫', tags: ['group:G', 'user:A'] });
    const a2 = await e.addMemory('group_G', { content: 'A 养了猫', tags: ['group:G', 'user:A'] });
    const b1 = await e.addMemory('group_G', { content: 'B 喜欢狗', tags: ['group:G', 'user:B'] });
    for (const [id, tagsArr] of [[a1, ['group:G', 'user:A']], [a2, ['group:G', 'user:A']], [b1, ['group:G', 'user:B']]] as any[]) {
        const u = e.repository.getUnit('group_G', id.unitIds[0])!;
        if (tagsArr.includes('user:B')) u.updatedAt = clock - 50;
        e.repository.updateUnit('group_G', u);
    }
    const mms = [
        await e.createMentalModel('group_G', 'A的偏好？', '旧A', ['user:A']),
        await e.createMentalModel('group_G', 'B的偏好？', '旧B', ['user:B']),
        await e.createMentalModel('group_G', 'C的偏好？', '旧C', ['user:C']),
        await e.createMentalModel('group_G', 'D的偏好？', '旧D', ['user:D']),
        await e.createMentalModel('group_G', '群聊全局印象？', '旧全局', []),
    ];
    const summary = await e.refreshMentalModels('group_G', undefined, { reason: 'consolidate' });
    return {
        modelCount: mms.length,
        llmCallCount: calls.length,
        llmQuestions: calls,
        summary,
        note: '触发层遍历全部模型，但 per-model scopeTags/factTypes + watermark gating：C/D 无 scope 内记忆(no_source)、B 未变(not_stale)，只有 A 与全局模型实际调 LLM',
    };
}

// ================= H. graphSearch 越界 unit / observation unit embedding =================
async function caseH(): Promise<Record<string, unknown>> {
    const e = makeEngine();
    e.ensureBank('group_H', 'group');
    const u1 = await e.addMemory('group_H', { content: '小明喜欢猫', tags: ['group:G', 'user:QQ1'], entities: ['小明'], factType: 'world' });
    const u2 = await e.addMemory('group_H', { content: '小明养过一只橘猫', tags: ['user:QQ2', 'vis:public'], entities: ['小明'], factType: 'experience' });
    const u3 = await e.addMemory('group_H', { content: '小明讨厌下雨', tags: ['group:G'], entities: ['小明'], factType: 'world' });
    const graphIds: string[] = (e as any).graphSearch('group_H', '小明', 'mid');
    const r = await e.recall('group_H', '小明', { tags: ['group:G'], types: ['world'], maxTokens: 2000 });
    const resultIds = r.map(x => x.unit.id);

    // H2：observation unit 创建时无 embedding，首次召回后回填；回填当轮仍进不了 semantic
    const e2 = makeEngine({
        embedding: async (t: string) => [t.length, 1],
        synthesizeObservation: async () => '观察：小明喜欢猫',
    });
    e2.ensureBank('user_H2', 'user');
    await e2.addMemory('user_H2', { content: '小明喜欢猫', entities: ['小明'] });
    await e2.addMemory('user_H2', { content: '小明喂过猫', entities: ['小明'] });
    await e2.consolidate('user_H2');
    const obs = e2.repository.listObservations('user_H2')[0];
    const obsUnitBefore = e2.repository.getUnit('user_H2', obs.id)!;
    const rr1 = await e2.recall('user_H2', '小明喜欢猫', { maxTokens: 2000 });
    const obsUnitAfter = e2.repository.getUnit('user_H2', obs.id)!;
    const rr2 = await e2.recall('user_H2', '小明喜欢猫', { maxTokens: 2000 });
    const find = (rs: RecallResult[]) => rs.find(x => x.unit.id === obs.id);
    return {
        graphSearchIds: graphIds,
        u1: u1.unitIds[0], u2: u2.unitIds[0], u3: u3.unitIds[0],
        resultIds,
        u2_typeOutOfScope: resultIds.includes(u2.unitIds[0]),
        u3_tagOutOfScope: resultIds.includes(u3.unitIds[0]),
        graphIncludesTagOutOfScopeUnit: graphIds.includes(u2.unitIds[0]) || graphIds.includes(u3.unitIds[0]),
        obsUnitEmbeddingAtCreate: obsUnitBefore.embedding,
        obsUnitEmbeddingAfterFirstRecall: obsUnitAfter.embedding,
        firstRecallObsUnitStrategies: find(rr1)?.matchedStrategies,
        secondRecallObsUnitStrategies: find(rr2)?.matchedStrategies,
        note: 'graphSearch 返回 tags/类型外 unit，但 RRF 前 unitById 过滤 → 不注入（越权否定，代价是白算）；observation unit 初始无向量，首次召回回填后当轮 semantic 仍用旧数组对象，下一轮才命中',
    };
}

// ================= I. 群聊分组注入预算/重复 =================
async function caseI(): Promise<Record<string, unknown>> {
    const e = makeEngine();
    e.ensureBank('group_I', 'group');
    const pad = (s: string) => s + '说'.repeat(Math.max(0, 80 - s.length));
    for (let i = 0; i < 20; i++) {
        await e.addMemory('group_I', { content: pad('群记忆' + i), tags: ['group:I', 'user:U' + (i % 3 + 1), 'vis:public'], factType: i % 2 ? 'experience' : 'world' });
    }
    for (const u of ['U1', 'U2', 'U3']) await e.addMemory('user_' + u, { content: pad('共同事实：喜欢猫'), tags: ['user:' + u, 'vis:public'] });
    for (const u of ['U1', 'U2', 'U3']) {
        for (let i = 0; i < 20; i++) await e.addMemory('user_' + u, { content: pad('个人记忆' + u + '-' + i), tags: ['user:' + u, 'vis:public'] });
    }
    const query = '查询';
    const groupTags = ['user:U1', 'user:U2', 'user:U3', 'group:I'];
    const groupRecalls = await e.recall('group_I', query, { tags: groupTags, maxTokens: 2048, preferObservations: true, budget: 'mid' });
    const groupList = groupRecalls.slice(0, 20);
    const sections: any[] = [{
        title: '群聊记忆（测试群）',
        scopeLabel: '群聊：I（测试群）',
        mentalModels: [
            fakeMM('群设定？', '群'.repeat(500)), fakeMM('群规则？', '规'.repeat(500)), fakeMM('群偏好？', '偏'.repeat(500)),
        ],
        recalls: groupList,
    }];
    let mmBudget = 5 - 3;
    const perUser: Record<string, any> = {};
    for (const u of ['U1', 'U2', 'U3']) {
        const ranked = await e.recall('user_' + u, query, { tags: ['user:' + u], maxTokens: 1024, preferObservations: true, budget: 'low' });
        const userRecalls: RecallResult[] = [];
        let total = 0;
        for (const r of ranked) {
            if (userRecalls.length >= 20) break;
            if (total + r.unit.text.length > 2048) break;
            userRecalls.push(r);
            total += r.unit.text.length;
        }
        const userMMs = [fakeMM('用户设定？', '设'.repeat(400))].slice(0, Math.max(0, Math.min(2, mmBudget)));
        mmBudget -= userMMs.length;
        sections.push({ title: '个人记忆（' + u + '）', scopeLabel: '个人：' + u, mentalModels: userMMs, recalls: userRecalls });
        perUser[u] = { returned: ranked.length, kept: userRecalls.length, chars: total };
    }
    const longTerm = buildGroupedMemoryPrompt(sections);
    const observations: Observation[] = Array.from({ length: 20 }, (_, i) => obsOf({
        id: 'obs_I' + i, bankId: 'group_I', text: '观察' + i + '：' + '观'.repeat(300), scopeTags: ['group:I'],
    }));
    const injectable = selectInjectionCandidates([], observations, ['group:I']).observations;
    const obsPrompt = '## 观察记忆\n' + injectable.map((o, i) => (i + 1) + '. ' + o.text).join('\n');
    const combined = obsPrompt + '\n\n' + longTerm;
    const dupText = '共同事实：喜欢猫';
    const dupCount = combined.split(dupText).length - 1;
    return {
        groupRecall: { returned: groupRecalls.length, kept: groupList.length, chars: groupList.reduce((a, r) => a + r.unit.text.length, 0) },
        perUser,
        obsInjected: injectable.length,
        obsPromptChars: obsPrompt.length,
        longTermChars: longTerm.length,
        combinedChars: combined.length,
        combinedEstTokens: estimateTokens(combined),
        sumPerCallBudgetsTokens: 2048 + 3 * 1024,
        crossBankDuplicateTextOccurrences: dupCount,
        duplicateUnitIds: [
            groupRecalls.filter(r => r.unit.text === dupText).map(r => r.unit.id),
        ],
        note: '分组注入无全局预算：群段≤2048 tokens + 3 段个人各≤1024 tokens + 心智模型 5×1000 字 + 观察 20 条不截断 → 实测总量远超单次预算；同一事实在两个 bank 各存一份时在 prompt 出现两次',
    };
}

function fakeMM(question: string, answer: string): any {
    return { id: question, bankId: 'x', question, answer, scopeTags: [], createdAt: 1, updatedAt: 1, version: 1, lastRefreshedAt: 1, history: [], trigger: 'full', status: 'ready' };
}

// ================= J. memory cap/prune 淘汰 =================
async function caseJ(): Promise<Record<string, unknown>> {
    // J1：刚写入即被淘汰（protected 高重要性旧记忆把新记忆挤掉）
    const e1 = makeEngine({ memoryCap: 2 });
    await e1.addMemory('user_J1', { content: '重要记忆一', importance: 0.95 });
    await e1.addMemory('user_J1', { content: '重要记忆二', importance: 0.95 });
    const r = await e1.addMemory('user_J1', { content: '刚写入的低重要性记忆', importance: 0.1 });
    const found = e1.repository.getUnit('user_J1', r.unitIds[0]!);
    const j1 = {
        retainResult: r,
        unitsAfter: e1.repository.listUnits('user_J1').map(u => u.text),
        justWrittenStillExists: !!found,
    };
    // J2：被观察引用的记忆先被淘汰，observation evidence 被静默削减（证据链损坏）
    const e2 = makeEngine({ memoryCap: 3, synthesizeObservation: async (q: string[]) => '观察：' + q.join('；') });
    e2.ensureBank('user_J2', 'user');
    for (const t of ['事实一：小明喜欢咖啡', '事实二：小明常去星巴克', '事实三：小明讨厌下雨']) {
        await e2.addMemory('user_J2', { content: t, entities: ['小明'] });
    }
    await e2.consolidate('user_J2');
    const obs = e2.repository.listObservations('user_J2')[0];
    const j2 = {
        observationProofCount: obs.proofCount,
        observationEvidence: obs.evidence,
        unitsAfterConsolidate: e2.repository.listUnits('user_J2').map(u => ({ id: u.id, type: u.factType, cs: u.consolidationState })),
        note: 'cap=3 时 3 条被观察覆盖的记忆 + 1 条 observation 同步 unit = 4 条 → 淘汰组0（被观察覆盖）优先删 → observation 证据被删并 proofCount 下调',
    };
    return { j1, j2 };
}

// ================= K. memory_add 标签缺失导致注入不可见 =================
async function caseK(): Promise<Record<string, unknown>> {
    const e = makeEngine();
    // tools.memory_add 默认参数（related_user_ids/related_group_ids 缺省=[]）→ tags 只有 vis:public
    const userBank = 'user_QQ1';
    const groupBank = 'group_100';
    const addUser = await e.addMemory(userBank, { content: '用户喜欢猫', tags: ['vis:public'], metadata: { type: 'text' } });
    const addUserKw = await e.addMemory(userBank, { content: '用户喜欢狗', tags: ['kw:dog', 'vis:public'] });
    const addGroup = await e.addMemory(groupBank, { content: '群里约定晚上不刷屏', tags: ['vis:public'] });
    // summarizeChunk 路径：tags 带 baseTags=[user:/group:, vis:public]
    const addSummary = await e.addMemory(userBank, { content: '归档事实：用户养了猫', tags: ['user:QQ1', 'vis:public'], metadata: { type: 'fact' } });
    const injectedUser = await e.recall(userBank, '用户喜欢猫', { tags: ['user:QQ1'], maxTokens: 2048 });
    const injectedGroup = await e.recall(groupBank, '晚上不刷屏', { tags: ['user:QQ1', 'group:100'], maxTokens: 2048 });
    const directNoTags = await e.recall(userBank, '用户喜欢猫', { maxTokens: 2048 });
    const injectedSummary = await e.recall(userBank, '归档事实', { tags: ['user:QQ1'], maxTokens: 2048 });
    return {
        addUser: addUser.unitIds,
        addUserWithKeywords: addUserKw.unitIds,
        addGroup: addGroup.unitIds,
        addSummary: addSummary.unitIds,
        injectionStyleRecall_user: { returned: injectedUser.length, texts: injectedUser.map(x => x.unit.text) },
        injectionStyleRecall_group: { returned: injectedGroup.length, texts: injectedGroup.map(x => x.unit.text) },
        recallWithoutTags: { returned: directNoTags.length, texts: directNoTags.map(x => x.unit.text) },
        summarizeChunkStyleRecall: { returned: injectedSummary.length, texts: injectedSummary.map(x => x.unit.text) },
        note: 'related_* 缺省时 tags 不含目标 user:/group: 标签 → buildLongTermPrompt 的 tags=[user:...]/[group:...] + any 过滤把它整条剔除；memory_recall 工具 tags=keywords（默认[]）不过滤所以能搜到 → 注入路径与搜索路径不一致',
    };
}

// ================= N. 观察记忆双重注入 =================
async function caseN(): Promise<Record<string, unknown>> {
    const e = makeEngine({ synthesizeObservation: async () => '观察：小明喜欢猫' });
    e.ensureBank('group_N', 'group');
    await e.addMemory('group_N', { content: '小明喜欢猫', tags: ['group:G', 'user:QQ1'], entities: ['小明'] });
    await e.addMemory('group_N', { content: '小明喂过猫', tags: ['group:G', 'user:QQ1'], entities: ['小明'] });
    await e.consolidate('group_N');
    const obs = e.repository.listObservations('group_N')[0];
    const recalls = await e.recall('group_N', '小明喜欢什么', { tags: ['user:QQ1', 'group:G'], maxTokens: 2048, preferObservations: true, budget: 'mid' });
    const obsUnitInRecalls = recalls.find(r => r.unit.id === obs.id);
    const longTerm = buildLongTermMemoryPrompt(recalls, false, 'G');
    const injectable = selectInjectionCandidates([], e.repository.listObservations('group_N'), ['group:G']).observations;
    const obsPrompt = '## 观察记忆\n' + injectable.map((o, i) => (i + 1) + '. ' + o.text).join('\n');
    const combined = obsPrompt + '\n\n' + longTerm;
    return {
        recallCount: recalls.length,
        observationId: obs.id,
        obsUnitInRecalls: !!obsUnitInRecalls,
        obsUnitFactType: obsUnitInRecalls?.unit.factType,
        observationText: obs.text,
        narrativeOccurrencesInCombinedPrompt: combined.split(obs.text).length - 1,
        combinedPrompt: combined,
        note: 'observation unit（consolidation.ts syncObservationUnit）参与 recall 并渲染进「长期记忆/群聊长期记忆」段；buildObservationPrompt 又按 observation 表注入同一文本 → 同一观察出现两次',
    };
}

// ================= O(补充). retain 不使用注入时钟 =================
async function caseO(): Promise<Record<string, unknown>> {
    const clock = 1700000000;
    const e = makeEngine({ now: () => clock });
    const r = await e.addMemory('user_O', { content: '时钟测试记忆' });
    const u = e.repository.getUnit('user_O', r.unitIds[0])!;
    return {
        injectedNow: clock,
        unitCreatedAt: u.createdAt,
        unitUpdatedAt: u.updatedAt,
        matchesInjectedClock: u.createdAt === clock,
        note: 'engine.retain 用 Date.now()（engine.ts:153），now 注入只作用于 MentalModelService；测试/回放时钟不覆盖写入路径',
    };
}

// ================= P(补充). 关键词/图/时间三路均空时按插入序返回（不看新近度） =================
async function caseR(): Promise<Record<string, unknown>> {
    const e = makeEngine({ recencyWeight: 0.4 });
    for (const t of ['最早记忆', '第二记忆', '第三记忆', '最新记忆']) {
        await e.addMemory('user_R', { content: t });
    }
    const all = e.repository.listUnits('user_R');
    // 人为让"最新记忆"最近访问，验证 backfill 兜底不吃新近度加权
    const latest = all[all.length - 1];
    latest.lastAccessedAt = SEC();
    e.repository.updateUnit('user_R', latest);
    const rs = await e.recall('user_R', '查询', { maxTokens: 1000 });
    return {
        recalledOrder: rs.map(r => r.unit.text),
        matchedStrategies: rs.map(r => r.matchedStrategies),
        note: 'RRF 为空时走 backfill 兜底：按 units 数组顺序（写入序，最旧优先）填充，不排序、不吃新近度/重要性',
    };
}

(async () => {
    await runCase('A-retain-dedup-merge', caseA);
    await runCase('B-tagsmatch-default-any', caseB);
    await runCase('C-semantic-no-threshold', caseC);
    await runCase('D-reflect-scope-and-llm', caseD);
    await runCase('E-delta-full-rewrite', caseE);
    await runCase('Q-delta-same-second-watermark', caseQ);
    await runCase('F-observation-trend-stale-delete', caseF);
    await runCase('G-auto-refresh-scope', caseG);
    await runCase('H-graph-filter-and-obs-embedding', caseH);
    await runCase('I-group-injection-budget', caseI);
    await runCase('J-prune-evict', caseJ);
    await runCase('K-memory-add-missing-tags', caseK);
    await runCase('N-observation-double-injection', caseN);
    await runCase('O-retain-clock', caseO);
    await runCase('R-backfill-order', caseR);
    console.log('SUMMARY ' + JSON.stringify({ total: cases.length, failed: cases.filter(c => !c.ok).map(c => c.id) }));
})();
