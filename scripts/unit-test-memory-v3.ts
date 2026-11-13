// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：memory-v3 域，36 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Agent, ApiError, Config, Context,
    DEFAULT_MEMORY_PROMPT_TOKENS, InMemoryMemoryStorage, Logger, MEMORY_PROMPT_TOKEN_BUDGET,
    MemoryEngine, MemoryScheduler, MemoryService, SECTION_RECALL_MAX_TOKENS,
    StopError, SubCmd, TC, TokenCalibration,
    Tool, applyDeltaOps, assert, blockSnapshot,
    buildContent, buildMemoryPrompt, canReadByTags, defaultCmdPriv,
    executeTool, ext, fs, getAuxLlm,
    getRegexConfig, hasAuxLlm, hasConfigHook, installTestHost,
    makeCtx, makeMemoSession, migrateBankV3, parseMarkdown,
    path, registerAllCmds, registerAllTools, registerCmdMemory,
    registerConfigHook, registerRawToolSet, resetAuxBreaker, resetConfigCache,
    resetMemorySchedulerForTest, runConfigHook, runSubCmd, setAuxLlm, getAuxLlmImpl,
    setHost, setLoggerConfigProvider, setMemoryEngineFactory, toolMap,
} from './unit-test-helpers';

export const tests: Record<string, () => void | Promise<void>> = {
testRegisterAllToolsIdempotent(): void {
        registerAllTools();
        for (const name of ['list_tools', 'search_tools', 'call_tool', 'use_skill']) {
            assert.ok(toolMap[name], `${name} 应已注册`);
        }
        const snapshot = Object.keys(toolMap).sort();
        registerAllTools();
        assert.deepStrictEqual(Object.keys(toolMap).sort(), snapshot, '重复装配不应累积工具');
    }
,

    /** registerAllCmds：根命令写入 ext.cmdMap、help 覆盖全部子命令、权限表键数一致，重复装配不累积 */
    testRegisterAllCmdsRegistersRootCommand(): void {
        const beforeMap = { ...SubCmd.map };
        const beforeAiArgs = defaultCmdPriv.ai.args;
        const beforeCmdMap = { ...((ext as any).cmdMap ?? {}) };
        try {
            registerAllCmds();
            const cmd = (ext as any).cmdMap?.ai;
            assert.ok(cmd, '根命令 .ai 应写入 ext.cmdMap');
            const help = String(cmd.help ?? '');
            for (const name of Object.keys(SubCmd.map)) {
                assert.ok(help.includes(name), `.ai help 应包含子命令 ${name}`);
            }
            assert.strictEqual(
                Object.keys(defaultCmdPriv.ai.args ?? {}).length,
                Object.keys(SubCmd.map).length,
                '子命令权限表键数应等于已注册子命令数'
            );
            const count = Object.keys(SubCmd.map).length;
            registerAllCmds();
            assert.strictEqual(Object.keys(SubCmd.map).length, count, '重复装配不应累积子命令');
        } finally {
            for (const key of Object.keys(SubCmd.map)) {
                if (!Object.prototype.hasOwnProperty.call(beforeMap, key)) delete SubCmd.map[key];
            }
            defaultCmdPriv.ai.args = beforeAiArgs;
            (ext as any).cmdMap = beforeCmdMap;
        }
    }
,

    /** logger provider：级别「从不」抑制 info；provider 抛错回退默认且不抛异常 */
    testLoggerProviderLevelAndFallback(): void {
        const logs: string[] = [];
        const origInfo = console.info;
        const origError = console.error;
        console.info = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
        console.error = () => undefined;
        try {
            setLoggerConfigProvider(() => ({ level: '从不' }));
            Logger.info('should-not-appear-xyz');
            setLoggerConfigProvider(() => ({ level: '信息' }));
            Logger.info('should-appear-xyz');
            assert.ok(!logs.some(l => l.includes('should-not-appear-xyz')), '级别「从不」应抑制 info');
            assert.ok(logs.some(l => l.includes('should-appear-xyz')), '级别「信息」应输出 info');

            setLoggerConfigProvider(() => { throw new Error('provider boom'); });
            Logger.info('fallback-xyz');
            assert.ok(logs.some(l => l.includes('fallback-xyz')), 'provider 抛错应回退默认级别并继续输出');
        } finally {
            setLoggerConfigProvider(null);
            console.info = origInfo;
            console.error = origError;
        }
    }
,

    /** logger 截断收敛：关闭「日志简短打印」=完整打印；开启=整行超 1000 字只留头尾各 500（唯一截断点） */
    testLoggerShortPrintModes(): void {
        try {
            setLoggerConfigProvider(() => ({ shortPrint: false, messageContent: true }));
            const full = 'x'.repeat(3000);
            assert.strictEqual(Logger.handleLogData(full), full, '关闭「日志简短打印」应完整输出超长文本');
            const obj = { a: 'y'.repeat(3000) };
            assert.strictEqual(Logger.handleLogData(obj), JSON.stringify(obj), '关闭时应完整 stringify 对象');

            setLoggerConfigProvider(() => ({ shortPrint: true, messageContent: true }));
            const exact = 'z'.repeat(1000);
            assert.strictEqual(Logger.handleLogData(exact), exact, '未超阈值不应截断');
            const cut = Logger.handleLogData('a'.repeat(1001));
            assert.strictEqual(cut.length, 1005, '开启时超阈值行应为 头500 + 分隔 + 尾500');
            assert.ok(cut.startsWith('a'.repeat(500)) && cut.endsWith('a'.repeat(500)), '开启时应保留头尾');

            // 请求上下文正文不再预先截断（完整内容交给 Logger 统一处理）
            const origEmit = (Logger as any).emit;
            const emitted: string[] = [];
            (Logger as any).emit = (_level: string, ...data: any[]) => { emitted.push(data.map(String).join(' ')); };
            try {
                const body = 'q'.repeat(1500);
                Logger.printRequestMessages([{ role: 'user', content: body }]);
                assert.ok(emitted.some(l => l.includes(body)), '请求上下文正文应完整传给 logger');
            } finally {
                (Logger as any).emit = origEmit;
            }

            // 脱敏仍在（且发生在截断之前）
            const secret = Logger.handleLogData('api_key=' + 'k'.repeat(40) + ' tail');
            assert.ok(!secret.includes('k'.repeat(40)), '密钥脱敏应生效');
        } finally {
            setLoggerConfigProvider(null);
        }
    }
,

    /** logger base64 折叠：data URI / JSON base64 字段只留占位，关闭截断也不把整段 base64 写进日志 */
    testLoggerBase64Fold(): void {
        try {
            setLoggerConfigProvider(() => ({ shortPrint: false, messageContent: true }));
            const payload = 'A'.repeat(4096);
            const dataUri = Logger.handleLogData(`image=data:image/png;base64,${payload}`);
            assert.ok(!dataUri.includes(payload), 'data URI 的 base64 本体应折叠');
            assert.ok(dataUri.includes('4096'), '折叠占位应带原文长度');
            const json = Logger.handleLogData(JSON.stringify({ base64: payload }));
            assert.ok(!json.includes(payload), 'JSON base64 字段应折叠');
        } finally {
            setLoggerConfigProvider(null);
        }
    }
,

    /** getRegexConfig：非法正则回退为永不匹配，命中缓存后不再读配置 */
    testGetRegexConfigInvalidFallbackAndCache(): void {
        const TC = (globalThis as any).__TEST_CONFIG__;
        const origError = console.error;
        console.error = () => undefined;
        try {
            TC.templateConfigs['__probe_regex'] = ['(']; // 非法正则
            const first = getRegexConfig({} as any, '__probe_regex');
            assert.strictEqual(first.source, '(?!)', '非法正则应回退为永不匹配');
            TC.templateConfigs['__probe_regex'] = ['abc'];
            assert.strictEqual(getRegexConfig({} as any, '__probe_regex'), first, '命中缓存应返回同一实例');
        } finally {
            delete TC.templateConfigs['__probe_regex'];
            console.error = origError;
        }
    }
,

    /** 配置钩子：组合根已注册 model 钩子；钩子可替换数据、抛错时回退原数据 */
    testConfigHookRegisteredAndFailsSoft(): void {
        assert.ok(hasConfigHook('model'), '组合根测试宿主应已注册 model 配置钩子');
        const original = { a: 1 } as any;
        registerConfigHook('__probe_throw', () => { throw new Error('probe boom'); });
        assert.strictEqual(runConfigHook('__probe_throw', original), original, '钩子抛错应回退原数据');

        let called = false;
        registerConfigHook('__probe_ok', (_key: string, data: any) => {
            called = true;
            return { ...data, extra: true };
        });
        const out = runConfigHook('__probe_ok', original);
        assert.ok(called, '钩子应被调用');
        assert.strictEqual((out as any).extra, true, '钩子返回的替换数据应生效');
        assert.ok(!('extra' in original), '原数据不应被修改');
    }
,

    /** AuxLlm 端口：组合根已注入，且调用经 Agent.get 路由（既有测试桩语义保持） */
    async testAuxLlmPortRoutesToAgent(): Promise<void> {
        const origGet = Agent.get;
        const calls: string[] = [];
        (Agent as any).get = (name: string) => ({
            chat: async (p: string) => { calls.push(`chat:${name}:${p}`); return 'aux-ok'; },
            chatMessages: async () => 'aux-msgs',
        });
        try {
            assert.ok(hasAuxLlm(), '测试宿主应已安装 AuxLlm');
            const reply = await getAuxLlm().chat('probe_agent', 'hello');
            assert.strictEqual(reply, 'aux-ok');
            assert.deepStrictEqual(calls, ['chat:probe_agent:hello'], 'AuxLlm 应把用途名与 prompt 传给 Agent');
        } finally {
            (Agent as any).get = origGet;
        }
    }
,

    /** 工具统一执行器：未注册/未开启/缺参/类型错误/JSON 解析失败/成功/StopError 传播 */
    async testToolExecutorValidation(): Promise<void> {
        const name = '__probe_exec_tool';
        const probe = new Tool({
            type: 'function',
            function: {
                name,
                description: 'probe',
                parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
            },
        });
        probe.solve = async (_c, _m, _s, args) => `ok:${args.x}`;
        const ctx: any = { endPoint: { platform: 'qq', userId: 'QQ:1' } };
        const msg: any = { messageType: 'group' };
        const enabled: any = { toolState: { [name]: true } };
        const disabled: any = { toolState: {} };
        const base = { source: 'function' as const, repairJson: true };
        try {
            const notFound = await executeTool('__no_such_tool', ctx, msg, enabled, { ...base, args: {} });
            assert.strictEqual(notFound.ok, false);
            assert.strictEqual(notFound.failure?.code, 'not_found');

            const notEnabled = await executeTool(name, ctx, msg, disabled, { ...base, args: { x: 'v' } });
            assert.strictEqual(notEnabled.failure?.code, 'not_enabled');

            const missing = await executeTool(name, ctx, msg, enabled, { ...base, args: {} });
            assert.strictEqual(missing.failure?.code, 'missing_required');
            assert.strictEqual(missing.failure?.param, 'x');

            const invalid = await executeTool(name, ctx, msg, enabled, { ...base, args: { x: 1 } });
            assert.strictEqual(invalid.failure?.code, 'invalid_arg');

            const badJson = await executeTool(name, ctx, msg, enabled, { ...base, args: '{oops' });
            assert.strictEqual(badJson.failure?.code, 'bad_args');

            const ok = await executeTool(name, ctx, msg, enabled, { ...base, args: '{"x":"v"}' });
            assert.strictEqual(ok.ok, true);
            assert.strictEqual(ok.content, 'ok:v');
            assert.strictEqual(ok.callBack, true);

            // StopError 必须继续向上抛（由对话链中止），不能变成工具失败回填
            probe.solve = async () => { throw new StopError('stop'); };
            let thrown: any = null;
            try {
                await executeTool(name, ctx, msg, enabled, { ...base, args: { x: 'v' } });
            } catch (e) {
                thrown = e;
            }
            assert.ok(thrown instanceof StopError, 'StopError 应向上传播');
        } finally {
            delete toolMap[name];
        }
    }
,

    /** HostSeam：注入内存存储 + 固定时钟后，TokenCalibration 的读写与时间戳都走注入实现 */
    testHostStorageInjectionAndClock(): void {
        const store = new Map<string, string>();
        setHost({
            storage: {
                get: (key) => store.get(key) ?? null,
                set: (key, value) => { store.set(key, value); },
            },
            clock: { now: () => 1_000_000 },
            fetch: (url, init) => fetch(url, init),
            ext,
        });
        try {
            TokenCalibration.resetForTest();
            TokenCalibration.record('host-probe', 100, 150);
            const raw = store.get('tokenCalibration');
            assert.ok(raw, '校准数据应写入注入的存储');
            const saved = JSON.parse(raw as string);
            assert.ok(saved['host-probe'].factor > 1, '首次样本应按真实比例校准');
            assert.strictEqual(saved['host-probe'].updatedAt, 1_000_000, 'updatedAt 应使用注入时钟');

            TokenCalibration.resetForTest();
            assert.ok(TokenCalibration.getFactor('host-probe') > 1, '应能从注入存储重新读取校准系数');
        } finally {
            TokenCalibration.resetForTest();
            installTestHost();
        }
    }
,

    // ================= 记忆 v3：三层数据模型 / 可见性 / 巩固 / 心智模型 / 结构化 delta =================

    async testV3RetainAppendOnlyAndDedup(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1000 });
        const bank = 'user_QQ:1';
        const tags = ['user:QQ:1', 'vis:owner'];
        const r1 = await engine.retain(bank, { content: '喜欢咖啡', tags });
        const r2 = await engine.retain(bank, { content: '喜欢茶', tags });
        assert.equal(r1.action, 'added');
        assert.equal(r2.action, 'added');
        const units = engine.repository.listUnits(bank);
        assert.equal(units.length, 2, '原始事实 append-only，不做同实体合并');
        assert.equal(units[0].text, '喜欢咖啡');
        assert.equal(units[1].text, '喜欢茶');
        const dup = await engine.retain(bank, { content: '  喜欢咖啡  ', tags });
        assert.equal(dup.action, 'duplicate', '完全相同事实应去重');
        assert.equal(engine.repository.listUnits(bank).length, 2);
        assert.equal(engine.repository.listUnits(bank)[0].consolidationState, 'pending');
    }
,

    testV3VisibilityMatrix(): void {
        const dm = { sessionId: 'QQ:1', sessionType: 'user' as const, userId: 'QQ:1' };
        const sameGroup = { sessionId: 'QQ-Group:9', sessionType: 'group' as const, groupId: 'QQ-Group:9', userId: 'QQ:1' };
        const otherGroup = { sessionId: 'QQ-Group:8', sessionType: 'group' as const, groupId: 'QQ-Group:8', userId: 'QQ:1' };
        assert.equal(canReadByTags('user_QQ:1', ['user:QQ:1', 'vis:owner'], dm), true, '本人私聊可见 owner');
        assert.equal(canReadByTags('user_QQ:1', ['user:QQ:1', 'vis:owner'], sameGroup), false, 'owner 事实不得进群');
        assert.equal(canReadByTags('user_QQ:1', ['user:QQ:1', 'vis:public'], sameGroup), true, 'public 可进本人发言的群');
        assert.equal(canReadByTags('user_QQ:1', ['user:QQ:1', 'vis:public'], otherGroup), true, 'public 是显式跨群，本人发言的群均可读');
        assert.equal(canReadByTags('user_QQ:1', ['user:QQ:1', 'vis:origin:QQ-Group:9'], sameGroup), true, 'origin 来源群可读');
        assert.equal(canReadByTags('user_QQ:1', ['user:QQ:1', 'vis:origin:QQ-Group:9'], otherGroup), false, 'origin 非来源群不可读');
        assert.equal(canReadByTags('group_QQ-Group:9', ['group:QQ-Group:9', 'vis:public'], otherGroup), false, '群 bank 不跨群');
        assert.equal(canReadByTags('global_main', ['global:main', 'vis:public'], dm), true, 'global public 所有会话可见');
        assert.equal(canReadByTags('global_main', ['global:main', 'vis:owner'], dm), false, 'global 不允许 owner');
    }
,

    async testV3ConsolidationEvidenceAndContradiction(): Promise<void> {
        let call = 0;
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000 + call,
            observationDecision: async ({ existing }) => {
                call++;
                if (call === 1) return { action: 'create', text: '用户喜欢咖啡' } as any;
                if (call === 2) return { action: 'reinforce', targetId: existing[0]?.id, text: '用户喜欢咖啡' } as any;
                return { action: 'contradict', targetId: existing[0]?.id, text: '用户以前喜欢咖啡，现在改喝茶' } as any;
            },
        });
        const bank = 'user_QQ:1';
        const tags = ['user:QQ:1', 'vis:owner'];
        await engine.retain(bank, { content: '喜欢咖啡', tags, entities: ['咖啡'] });
        await engine.retain(bank, { content: '每天一杯咖啡', tags, entities: ['咖啡'] });
        const c1 = await engine.consolidate(bank);
        assert.equal(c1.created.length, 1);
        let obs = engine.repository.listObservations(bank);
        assert.equal(obs.length, 1);
        assert.equal(obs[0].proofCount, 2, 'proofCount=distinct live sources');
        assert.equal(obs[0].history[0].reason, 'created');

        await engine.retain(bank, { content: '咖啡不加糖', tags, entities: ['咖啡'] });
        const c2 = await engine.consolidate(bank);
        assert.equal(c2.updated.length, 1);
        obs = engine.repository.listObservations(bank);
        assert.equal(obs[0].proofCount, 3);
        assert.equal(obs[0].history.some(h => h.reason === 'reinforced'), true);

        await engine.retain(bank, { content: '最近改喝茶了', tags, entities: ['咖啡'] });
        const c3 = await engine.consolidate(bank);
        assert.equal(c3.updated.length, 1);
        obs = engine.repository.listObservations(bank);
        assert.ok(obs[0].text.includes('现在改喝茶'), 'contradict 应改写成时间叙事');
        assert.equal(obs[0].history.some(h => h.reason === 'contradicted'), true);
        assert.equal(engine.repository.listUnits(bank).filter(u => u.consolidationState === 'pending').length, 0);
    }
,

    /** P0-1：多个 cluster 合并为一次批量决策请求 */
    async testV3BatchDecisionSingleCall(): Promise<void> {
        let calls = 0;
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000,
            observationDecisionBatch: async items => {
                calls++;
                return items.map((_, i) => ({ action: 'create', text: `批量观察 ${i + 1}` }) as any);
            },
        });
        const bank = 'user_QQ:batch';
        const tags = ['user:QQ:batch', 'vis:owner'];
        for (const content of ['喜欢咖啡', '喜欢茶', '喜欢跑步']) {
            await engine.retain(bank, { content, tags, entities: [content] });
        }
        const out = await engine.consolidate(bank, { maxFacts: 20 });
        assert.equal(calls, 1, '3 个 cluster 应合并为 1 次批量请求');
        assert.equal(out.created.length, 3, '批量中的每条 create 都应落库');
        assert.equal(engine.repository.listUnits(bank).filter(u => u.consolidationState === 'pending').length, 0);
    }
,

    /** P0-1：批量调用抛分类错误时整批上抛，不得退化成逐条重发 */
    async testV3BatchApiErrorNoPerItemFallback(): Promise<void> {
        let single = 0;
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000,
            observationDecision: async () => { single++; return { action: 'create', text: '单条' } as any; },
            observationDecisionBatch: async () => {
                throw ApiError.fromResponse(429, 'deepseek', '{"error":{"message":"Insufficient credits","type":"insufficient_quota"}}');
            },
        });
        const bank = 'user_QQ:batch-error';
        await engine.retain(bank, { content: '喜欢咖啡', tags: ['user:QQ:batch-error', 'vis:owner'] });
        await assert.rejects(() => engine.consolidate(bank, { maxFacts: 20 }));
        assert.equal(single, 0, '分类错误不得逐条重发（成本放大器）');
        assert.equal(engine.repository.listUnits(bank).filter(u => u.consolidationState === 'pending').length, 1, '失败不标记巩固');
    }
,

    /** P1-1：混合取数 = 最老一半 + 重要度一半 */
    async testV3ConsolidatePicksOldestAndImportant(): Promise<void> {
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000,
            observationDecision: async () => ({ action: 'create', text: '观察' } as any),
        });
        const bank = 'user_QQ:pick';
        const tags = ['user:QQ:pick', 'vis:owner'];
        const ids: string[] = [];
        for (let i = 0; i < 30; i++) {
            const text = String.fromCharCode(0x4e00 + i * 137) + String.fromCharCode(0x4e00 + i * 31);
            const r = await engine.retain(bank, {
                content: text,
                tags,
                entities: [`e${i}`],
                importance: i < 15 ? 0.1 : 0.9,
            });
            ids.push(r.unitIds[0]);
        }
        const out = await engine.consolidate(bank, { maxFacts: 20 });
        assert.equal(out.created.length, 20, '单次只处理 20 条');
        const done = new Set(engine.repository.listUnits(bank)
            .filter(u => u.consolidationState === 'done')
            .map(u => u.id));
        for (let i = 0; i < 10; i++) assert.ok(done.has(ids[i]), `最老的 10 条应被处理（第 ${i} 条）`);
        assert.equal(engine.repository.listUnits(bank).filter(u => u.consolidationState === 'pending').length, 10);
    }
,

    async testV3MentalModelRefreshWatermark(): Promise<void> {
        let now = 1000;
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => now,
            reflectSynthesizer: async (_q, ctx) => `答案:${ctx.memories.length}`,
        });
        const bank = 'user_QQ:1';
        const model = await engine.createMentalModel(bank, '用户偏好？', '');
        assert.equal(model.status, 'pending');
        await engine.retain(bank, { content: '喜欢咖啡', tags: ['user:QQ:1', 'vis:owner'] });
        now += 1;
        const r1 = await engine.refreshMentalModels(bank, model.id);
        assert.equal(r1.updated, 1);
        let stored = engine.listMentalModels(bank)[0];
        assert.equal(stored.status, 'ready');
        assert.ok(stored.content.includes('答案:1'));
        assert.ok(stored.lastMemorySeenSeq > 0, '刷新后应推进 watermark');

        now += 1;
        const r2 = await engine.refreshMentalModels(bank, model.id);
        assert.equal(r2.skipped, 1, '无新事实应跳过');
        assert.equal(r2.skippedReasons.not_stale, 1);

        await engine.retain(bank, { content: '也喜欢茶', tags: ['user:QQ:1', 'vis:owner'] });
        now += 1;
        const r3 = await engine.refreshMentalModels(bank, model.id);
        assert.equal(r3.updated, 1, '有新事实应更新');
        stored = engine.listMentalModels(bank)[0];
        assert.ok(stored.content.includes('答案:2'));
    }
,

    async testV3ReflectFastPathAndFallback(): Promise<void> {
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000,
            reflectSynthesizer: async () => '合成答案',
        });
        const bank = 'user_QQ:1';
        const tags = ['user:QQ:1', 'vis:owner'];
        await engine.retain(bank, { content: '喜欢咖啡', tags });
        const model = await engine.createMentalModel(bank, '用户偏好？', '直接答案');
        model.lastRefreshedAt = 1000;
        model.lastMemorySeenSeq = engine.repository.maxFactSeq(bank);
        engine.repository.updateMentalModel(bank, model, true);
        const fast = await engine.reflect(bank, '用户偏好？', { scopeTags: tags, fastPath: true });
        assert.equal(fast.answeredBy, 'model');
        assert.equal(fast.text, '直接答案');
        const deep = await engine.reflect(bank, '用户偏好？', { scopeTags: tags, fastPath: false, strict: false });
        assert.ok(deep.basedOn.memories.length >= 1 || deep.basedOn.mentalModels.length >= 1);
    }
,

    testV3StructuredDeltaPreservesUnrelatedBlocks(): void {
        const doc = parseMarkdown('## A\n- a\n- b\n\n## B\nhello');
        const before = blockSnapshot(doc);
        const sectionA = doc.sections.find(s => s.heading === 'A')!;
        const blockB = doc.sections.find(s => s.heading === 'B')!.blocks[0];
        const result = applyDeltaOps(doc, [
            { op: 'append_bullet', sectionId: sectionA.id, text: 'c' },
            { op: 'replace_block', blockId: blockB.id, text: 'world' },
        ]);
        assert.equal(result.applied, 2);
        assert.equal(result.rejected, 0);
        const after = blockSnapshot(result.doc);
        for (const old of before) {
            if (old.id === blockB.id) {
                assert.equal(after.find(b => b.id === old.id)?.text, 'world');
            } else {
                assert.equal(after.find(b => b.id === old.id)?.text, old.text, '未命中 block 必须原样保留');
            }
        }
        const rejected = applyDeltaOps(doc, [{ op: 'remove_stale_paragraph', blockId: 'no_such_block' }]);
        assert.equal(rejected.rejected, 1);
    }
,

    async testV3MigrationFromV2(): Promise<void> {
        const old: any = {
            meta: { id: 'user_QQ:1', kind: 'user', createdAt: 1, updatedAt: 1, settings: {} },
            units: [
                { id: 'u1', bankId: 'user_QQ:1', text: '喜欢咖啡', factType: 'world', createdAt: 1, updatedAt: 1, tags: ['user:QQ:1', 'vis:public'], embedding: [], entityIds: [], metadata: {}, consolidationState: 'done' },
                { id: 'o1', bankId: 'user_QQ:1', text: '旧观察同步单元', factType: 'observation', createdAt: 1, updatedAt: 1, tags: ['user:QQ:1'], embedding: [], entityIds: [], metadata: {} },
            ],
            entities: [],
            links: [],
            observations: [],
            mentalModels: [{ id: 'm1', question: 'Q', answer: 'A', scopeTags: ['user:QQ:1'], createdAt: 1, updatedAt: 1, trigger: {} }],
        };
        const { bank, changed } = migrateBankV3(old);
        assert.equal(changed, true);
        assert.equal(bank.meta.schemaVersion, 3);
        assert.equal(bank.units.length, 1, 'observation unit 必须消除');
        assert.ok(bank.units[0].tags.includes('vis:owner'), '旧 user bank public 迁移为 owner');
        assert.equal(bank.observations.length, 1, 'observation unit 迁移为观察表');
        assert.ok(bank.observations[0].tags.includes('vis:owner'), '旧个人观察必须收紧为 owner');
        assert.equal(bank.mentalModels[0].sourceQuery, 'Q');
        assert.equal(bank.mentalModels[0].structuredContent.sections.length > 0, true);
        assert.equal(bank.mentalModels[0].trigger.refreshAfterConsolidation, false);
        assert.equal(bank.mentalModels[0].maxTokens, 2048);
        assert.equal(bank.mentalModels[0].lastMemorySeenSeq, 0);
    }
,

    async testV3PromptDedupBudget(): Promise<void> {
        const now = 1000;
        const obs: any = { id: 'o1', text: '观察A', tags: [], status: 'active', createdAt: now, updatedAt: now, lastSupportedAt: now, proofCount: 2 };
        const prompt = buildMemoryPrompt([
            { kind: 'user', title: '个人记忆', observations: [obs], recalls: [
                { kind: 'observation', observation: obs, score: 1, matchedStrategies: [] },
                { kind: 'fact', unit: { id: 'f1', text: '观察A', tags: [] } as any, score: 1, matchedStrategies: [] },
            ] },
        ], 1000);
        assert.equal(prompt.split('观察A').length - 1, 1, '同一文本只渲染一次');
    }
,

    async testV3SchedulerNoAiNoWork(): Promise<void> {
        resetMemorySchedulerForTest();
        MemoryScheduler.init();
        const before = MemoryScheduler.status();
        assert.equal(before.jobs, 0);
        const fake: any = { sessionId: 'QQ:1', agentName: '*', headless: false, subagentDepth: 0 };
        MemoryScheduler.onRunEnd(fake);
        assert.ok(MemoryScheduler.status().lastAiActivityAt > 0, 'AI 结束后记录 lastAiActivityAt');
        assert.equal(MemoryScheduler.status().jobs, 0, '无待抽取文本时不得入队');
        resetMemorySchedulerForTest();
    }
,

    async testV3SchedulerGatingAndManualBypass(): Promise<void> {
        resetMemorySchedulerForTest();
        MemoryScheduler.init();
        MemoryScheduler.enqueueForTest({ kind: 'mm_refresh', bankId: 'user_QQ:1', modelId: 'm1', source: 'ai', priority: 2, payload: {} });
        assert.equal(await MemoryScheduler.tick(Math.floor(Date.now() / 1000)), false, '无 AI 活动不得执行自动任务');
        assert.equal(MemoryScheduler.status().jobs, 1, '自动任务应保留在队列');
        MemoryScheduler.enqueueForTest({ kind: 'mm_refresh', bankId: 'user_QQ:2', modelId: 'm2', source: 'manual', priority: 0, payload: {} });
        assert.equal(await MemoryScheduler.tick(Math.floor(Date.now() / 1000)), true, '手动任务应可执行');
        const jobs = MemoryScheduler.snapshot();
        assert.equal(jobs.some(j => j.source === 'manual'), false, '手动任务完成后移除');
        assert.equal(jobs.some(j => j.source === 'ai'), true, '自动任务仍等待 AI');
        resetMemorySchedulerForTest();
    }
,

    async testV3FatalAuxPausesScheduler(): Promise<void> {
        resetAuxBreaker();
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000,
            observationDecision: async () => {
                throw ApiError.fromResponse(402, 'deepseek', '{"error":{"message":"Insufficient Balance","type":"insufficient_quota"}}');
            },
        });
        setMemoryEngineFactory(() => engine);
        const bank = 'user_QQ:fatal';
        await engine.retain(bank, { content: '喜欢咖啡', tags: ['user:QQ:fatal', 'vis:owner'] });
        resetMemorySchedulerForTest();
        MemoryScheduler.init();
        MemoryScheduler.enqueueForTest({ kind: 'consolidate', bankId: bank, source: 'manual', priority: 0, payload: {} });
        const now = Math.floor(Date.now() / 1000);
        await MemoryScheduler.tick(now);
        assert.ok(MemoryScheduler.status().pausedUntil > now, 'fatal aux 错误应立即熔断');
        const job = MemoryScheduler.snapshot().find(j => j.bankId === bank);
        assert.ok(job, 'fatal 时 job 应保留在队列');
        assert.equal(job!.attempts, 0, 'fatal 不累加 attempts');
        resetAuxBreaker();
        resetMemorySchedulerForTest();
    }
,

    async testV3ServicePromptVisibility(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1000 });
        setMemoryEngineFactory(() => engine);
        await MemoryService.retainForSessionId('QQ:1', '*', { content: '私密偏好茶', visibility: 'owner' });
        await MemoryService.retainForSessionId('QQ:1', '*', { content: '公开偏好茶', visibility: 'public' });
        const group = makeMemoSession('QQ-Group:9');
        group.agentName = '*';
        const prompt = await MemoryService.buildMemoryPrompt(group, '茶', [{ id: 'QQ:1', name: '小明' }], { id: 'QQ-Group:9', name: '测试群' });
        assert.equal(prompt.includes('私密偏好茶'), false, 'owner 事实不得进入群提示词');
        assert.equal(prompt.includes('公开偏好茶'), true, 'public 事实应进入本人发言的群提示词');
        await MemoryService.retainToBank('global_main', { content: '本体经验茶', visibility: 'public' });
        const dm = makeMemoSession('QQ:1');
        dm.agentName = '*';
        const dmPrompt = await MemoryService.buildMemoryPrompt(dm, '茶', [{ id: 'QQ:1', name: '小明' }], null);
        assert.ok(dmPrompt.includes('本体经验茶'), 'global public 事实应注入所有会话');
        await MemoryService.consolidateBank('user_QQ:1');
        const afterObs = await MemoryService.buildMemoryPrompt(group, '茶', [{ id: 'QQ:1', name: '小明' }], { id: 'QQ-Group:9', name: '测试群' });
        assert.equal(afterObs.includes('私密偏好茶；公开偏好茶'), false, '含 owner 证据的观察不得进入群提示词');
    }
,

    /** 记忆默认值：单轮注入 2048、单 bank 召回 1024、渲染兜底 2048 */
    testMemoryPromptDefaults2048(): void {
        assert.equal(DEFAULT_MEMORY_PROMPT_TOKENS, 2048, '渲染兜底预算应为 2048');
        assert.equal(MEMORY_PROMPT_TOKEN_BUDGET, 2048, '配置默认预算应为 2048');
        assert.equal(SECTION_RECALL_MAX_TOKENS, 1024, '单 bank 召回上限应为 1024');
    }
,

    /** 空记忆整段丢弃：只有标题、没有条目的 section 不输出（含 global 段） */
    testMemoryPromptDropsEmptySections(): void {
        assert.equal(buildMemoryPrompt([{ kind: 'user', title: 'Empty bank' }]), '', '空段应整段丢弃');
        assert.equal(buildMemoryPrompt([{ kind: 'global', title: 'Self experience (global)' }]), '', 'global 空段同样丢弃');
        const now = Math.floor(Date.now() / 1000);
        const prompt = buildMemoryPrompt([{
            kind: 'user',
            title: 'Bank',
            observations: [{ id: 'o1', bankId: 'user_x', text: '喜欢猫', tags: [], evidence: [], proofCount: 1, createdAt: now, updatedAt: now, lastSupportedAt: now, status: 'active', history: [] } as any],
        }]);
        assert.ok(prompt.includes('## Bank'), '有内容时标题应保留');
        assert.ok(prompt.includes('喜欢猫'), '有内容时应正常渲染');
    }
,

    /** 预算裁剪按渲染顺序：顺序靠前的段先占用预算，靠后的低相关段被丢弃 */
    testV3SectionRelevanceBudgetCut(): void {
        const now = Math.floor(Date.now() / 1000);
        const mkObs = (id: string, text: string) => ({ id, bankId: 'user_x', text, tags: [], evidence: [], proofCount: 1, createdAt: now, updatedAt: now, lastSupportedAt: now, status: 'active', history: [] } as any);
        const prompt = buildMemoryPrompt([
            { kind: 'user', title: 'High', observations: [mkObs('o1', '高相关记忆')] },
            { kind: 'user', title: 'Low', observations: [mkObs('o2', '低相关记忆')] },
        ], 10);
        assert.ok(prompt.includes('高相关记忆'), '预算内的第一段应保留');
        assert.equal(prompt.includes('低相关记忆'), false, '预算耗尽后应丢弃后面的低相关段');
    }
,

    /** 多 bank 相关性排序：当前会话 bank 固定第一；命中的个人 bank 排未命中的之前；global 最后 */
    async testV3SectionRelevanceOrder(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1000 });
        setMemoryEngineFactory(() => engine);
        const nowSec = Math.floor(Date.now() / 1000);
        const mkObs = (bankId: string, id: string, text: string, scopeTag: string) => ({
            id, bankId, text,
            tags: [scopeTag, 'vis:public'],
            evidence: [], proofCount: 1,
            createdAt: nowSec, updatedAt: nowSec, lastSupportedAt: nowSec,
            status: 'active', history: [],
        } as any);
        // 当前群 bank：一条可注入观察（无召回命中，仅保证当前段非空且固定第一）
        engine.repository.addObservation('group_QQ-Group:9', mkObs('group_QQ-Group:9', 'o_group', '本群十点后禁言', 'group:QQ-Group:9'));
        // 个人 bank QQ:2：一条可注入观察（无命中，低相关）
        engine.repository.addObservation('user_QQ:2', mkObs('user_QQ:2', 'o_user2', '喜欢下雨', 'user:QQ:2'));
        // 个人 bank QQ:1：一条命中 query 的公开事实
        await MemoryService.retainForSessionId('QQ:1', '*', { content: '喜欢喝咖啡', visibility: 'public' });

        const group = makeMemoSession('QQ-Group:9');
        group.agentName = '*';
        const prompt = await MemoryService.buildMemoryPrompt(group, '咖啡', [
            { id: 'QQ:2', name: '小红' },
            { id: 'QQ:1', name: '小明' },
        ], { id: 'QQ-Group:9', name: '测试群' });

        const atGroup = prompt.indexOf('Group chat memory (测试群)');
        const atXiaoming = prompt.indexOf('Personal memory (小明)');
        const atXiaohong = prompt.indexOf('Personal memory (小红)');
        assert.ok(atGroup >= 0 && atXiaoming >= 0 && atXiaohong >= 0, `应三段的标题都存在：\n${prompt}`);
        assert.ok(atGroup < atXiaoming, '当前会话 bank 应固定第一');
        assert.ok(atXiaoming < atXiaohong, '命中的个人 bank 应排在未命中的之前（不受发言顺序影响）');
    }
,

    /** 单 bank 召回预算 1024：当前 bank 与 global bank 的 recall 都要带该上限 */
    async testV3PerBankRecallBudget(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1000 });
        const captured: number[] = [];
        const originalRecall = engine.recall.bind(engine);
        (engine as any).recall = async (bankId: string, options: any) => {
            captured.push(options?.maxTokens);
            return originalRecall(bankId, options);
        };
        setMemoryEngineFactory(() => engine);
        const dm = makeMemoSession('QQ:1');
        dm.agentName = '*';
        await MemoryService.buildMemoryPrompt(dm, '你好', [{ id: 'QQ:1', name: '小明' }], null);
        assert.ok(captured.length >= 2, `至少召回当前 bank 与 global bank，实际 ${captured.length} 次`);
        assert.ok(captured.every(value => value === SECTION_RECALL_MAX_TOKENS), `单 bank 召回上限应为 1024，实际 ${captured.join(',')}`);
    }
,

    async testV3ExtractionRoutesAndPrivacy(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1000 });
        setMemoryEngineFactory(() => engine);
        const TC = (globalThis as any).__TEST_CONFIG__;
        TC.boolConfigs['本体自动抽取'] = false;
        TC.boolConfigs['群聊自动写个人记忆'] = false;
        (Config as any).cache = {};
        const __prevAux = getAuxLlmImpl();
        setAuxLlm({
            chat: async () => JSON.stringify({
                facts: [
                    { memory_type: 'private', target_id: 'QQ:1', text: '小明喜欢咖啡', type: 'fact', confidence: 0.9 },
                    { memory_type: 'group', target_id: 'QQ-Group:9', text: '本群十点后禁言', type: 'rule', confidence: 0.9 },
                    { memory_type: 'global', text: '助手应简洁', type: 'rule', confidence: 0.9 },
                ],
            }),
            chatMessages: async () => '',
        } as any);
        try {
            const group = makeMemoSession('QQ-Group:9');
            group.agentName = '*';
            await MemoryService.extractFromChunk(group, { text: '群聊内容', throughSeq: 1, textLength: 4 }, 'ai');
            const groupUnits = engine.repository.listUnits('group_QQ-Group:9');
            assert.ok(groupUnits.some(u => u.text.includes('小明喜欢咖啡')), '群聊 private 默认落群 bank（origin），不写个人');
            assert.ok(groupUnits.some(u => u.text.includes('禁言')), 'group 事实落本群');
            assert.equal(groupUnits.some(u => u.text.includes('助手应简洁')), false, 'group 自动抽取默认不得写 global');
            assert.ok(groupUnits.find(u => u.text.includes('小明喜欢咖啡'))!.tags.some(t => t.startsWith('vis:origin')), '群聊 private 回退为 origin');
            assert.equal(engine.repository.listUnits('user_QQ:1').length, 0, '默认不把群聊事实写个人 bank');

            const dm = makeMemoSession('QQ:1');
            dm.agentName = '*';
            await MemoryService.extractFromChunk(dm, { text: '私聊内容', throughSeq: 1, textLength: 4 }, 'ai');
            const userUnits = engine.repository.listUnits('user_QQ:1');
            assert.ok(userUnits.some(u => u.text.includes('小明喜欢咖啡')), '私聊 private 写个人 bank');
            assert.ok(userUnits.find(u => u.text.includes('小明喜欢咖啡'))!.tags.includes('vis:owner'));
        } finally {
            setAuxLlm(__prevAux);
            delete TC.boolConfigs['本体自动抽取'];
            delete TC.boolConfigs['群聊自动写个人记忆'];
            (Config as any).cache = {};
        }
    }
,

    async testV3LegacyPersonaMigratesToModel(): Promise<void> {
        const engine = new MemoryEngine({ storage: new InMemoryMemoryStorage(), now: () => 1000 });
        setMemoryEngineFactory(() => engine);
        const dm = makeMemoSession('QQ:1');
        dm.agentName = '*';
        dm.memory.persona = '喜欢猫，讨厌下雨';
        await MemoryService.buildMemoryPrompt(dm, '你好', [{ id: 'QQ:1', name: '小明' }], null);
        assert.equal(dm.memory.persona, '无', '旧 persona 字段应清空');
        const models = engine.listMentalModels('user_QQ:1');
        const persona = models.find(m => m.templateId === 'persona');
        assert.ok(persona, '应生成 persona 心智模型');
        assert.equal(persona!.status, 'ready');
        assert.ok(persona!.content.includes('喜欢猫'));
    }
,

    async testV3MentalModelSeedOnce(): Promise<void> {
        const engine = new MemoryEngine({
            storage: new InMemoryMemoryStorage(),
            now: () => 1000,
            reflectSynthesizer: async () => '种子答案',
        });
        const bank = 'user_QQ:1';
        const firstIds = await engine.ensureDefaultMentalModels(bank, 'user', 'user:QQ:1', true);
        assert.ok(firstIds.length >= 2, '首次应播种个人模板');
        assert.ok(engine.listMentalModels(bank).every(m => m.status === 'pending'));
        await engine.retain(bank, { content: '喜欢咖啡', tags: ['user:QQ:1', 'vis:owner'] });
        const seedAgain = await engine.ensureDefaultMentalModels(bank, 'user', 'user:QQ:1', true);
        assert.ok(seedAgain.length >= 1, '有来源后应返回待 seed 的模型');
        for (const id of seedAgain) await engine.refreshMentalModels(bank, id);
        assert.ok(engine.listMentalModels(bank).every(m => m.status === 'ready'), 'seed 后应 ready');
        const afterReady = await engine.ensureDefaultMentalModels(bank, 'user', 'user:QQ:1', true);
        assert.equal(afterReady.length, 0, 'ready 后不应重复排队');
    }
,

    testV3ContextDecoupledFromMemory(): void {
        const root = path.join(process.cwd(), 'src', 'context');
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory() ? walk(full) : [full];
        });
        for (const file of walk(root).filter(f => f.endsWith('.ts'))) {
            const text = fs.readFileSync(file, 'utf8');
            assert.equal(/^\s*import\s+[^;]*from\s+['"][^'"]*memory\//m.test(text), false, `${file} 不应 import memory`);
            assert.equal(/\.memory\./.test(text), false, `${file} 不应访问 session.memory`);
        }
    }
,

    async testV3CommandUsable(): Promise<void> {
        registerCmdMemory();
        const s = makeMemoSession('QQ:1');
        s.sessionType = 'user';
        s.agentName = '*';
        const status = await runSubCmd('memory', ['memo', 'status'], { session: s });
        assert.ok(status.includes('长期事实'), `memo status 应可用: ${status}`);
        const add = await runSubCmd('memory', ['memo', 'add', '喜欢手冲咖啡'], { session: s });
        assert.ok(add.includes('已添加'), `memo add 应可用: ${add}`);
        const list = await runSubCmd('memory', ['memo', 'list'], { session: s });
        assert.ok(list.includes('喜欢手冲咖啡'), `memo list 应显示事实: ${list}`);
        const noYes = await runSubCmd('memory', ['memo', 'clear'], { session: s });
        assert.ok(noYes.includes('--yes'), `clear 无 --yes 应拒绝: ${noYes}`);
        const yes = await runSubCmd('memory', ['memo', 'clear'], { session: s }, [{ name: 'yes' }]);
        assert.ok(yes.includes('已清除'), `clear --yes 应执行: ${yes}`);
        // 全局（本体）记忆：默认仅骰主；写入目标必须是 global bank 而不是当前 user bank
        const master = { session: s, ctx: { privilegeLevel: 100 } };
        const gAdd = await runSubCmd('memory', ['memo', 'add', '本体经验'], master, [{ name: 'self' }]);
        assert.ok(gAdd.includes('已添加'), `--self add 应写入全局: ${gAdd}`);
        const gList = await runSubCmd('memory', ['memo', 'list'], master, [{ name: 'self' }]);
        assert.ok(gList.includes('本体经验'), `--self list 应读到全局事实: ${gList}`);
        assert.ok(gList.includes('本体'), `--self 应标明本体范围: ${gList}`);
    }
,

    /** 旧回退路径（无事件账本）超长用户消息：纯代码 token 截断 + rawText 回查（不再调用任何 LLM） */
    async testUserMessageLegacyTokenTruncate(): Promise<void> {
        const origGlobal = TC.boolConfigs['是否开启全局待机'];
        TC.boolConfigs['是否开启全局待机'] = false;   // 测试桩默认 true；关掉才能进旧热态路径
        resetConfigCache();
        try {
            const long = '长'.repeat(9000);   // ~9000 token > 8192
            const ctx = new Context();
            ctx.agentName = '*';
            ctx.sessionId = 'QQ:legacy-hot';
            const sess = ctx.session;
            sess.setting.aiEnabled = false;
            sess.lastRelevantAt = Math.floor(Date.now() / 1000);
            await ctx.addUserMessage(makeCtx(), long, 'QQ:1', 'm_legacy');
            const item = (ctx.messages[0] as any).contentItems[0];
            assert.equal(item.rawText, long, '截断前原文应保留在 rawText');
            assert.ok(item.text.includes('[content-truncated:'), '展示文本应带截断标记');
            assert.ok(item.text.includes('tokens'), '标记按 token 计');
            assert.ok(item.text.length < long.length, '展示文本应短于原文');
            assert.equal(item.compressed, true, '截断过的旧路径条目应标记已处理');
            assert.ok(!buildContent(ctx.messages[0]).includes(long), '渲染不应泄露 rawText');
            // 旧路径 read_raw kind=user 仍可按 msg_id 回查原文
            registerRawToolSet();
            const readRaw = toolMap['read_raw'];
            const r = await readRaw.solve(makeCtx(), {} as any, { context: ctx } as any, { kind: 'user', id: 'm_legacy' });
            assert.ok(r.includes('长'.repeat(100)), 'read_raw kind=user 应能读到截断前原文');
        } finally {
            if (origGlobal === undefined) delete TC.boolConfigs['是否开启全局待机']; else TC.boolConfigs['是否开启全局待机'] = origGlobal;
            resetConfigCache();
        }
    }
};
