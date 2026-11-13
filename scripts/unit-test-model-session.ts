// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：model-session 域，35 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Agent, Config, Image, KnowledgeBaseService,
    Logger, Model, SKILL_INJECT_MAX_ITEMS, Session,
    SessionService, StopError, SubCmd, TC,
    TimerInfo, TimerManager, Tool, assert,
    createStopEvent, ext, fireStopEvent, getSkillSummariesBudgeted,
    makeCtx, parseKnowledgeLibrary, pinConn, pinConnTyped,
    registerCmdModel, registerDispatchTools, registerSkills, resetConfigCache,
    resetModelConfigCacheForTest, resetStopEvent, restoreImageTestConfig, seedAutoConns,
    seedFromV5Config, seedPinnedConns, setModelListDepsForTest, setupImageTestConfig,
    streamService, textToMultimodalContent, toolCallFormat, toolMap,
    v5Conn, v5Model, withTimeout,
} from './unit-test-helpers';

export const tests: Record<string, () => void | Promise<void>> = {
/** 多模态文本转换：纯文本原样返回；图片标签转内容块数组；无法解析保留原标签 */
    async testTextToMultimodalContent(): Promise<void> {
        // 纯文本：原样返回字符串
        assert.equal(await textToMultimodalContent('你好，世界'), '你好，世界');
        assert.equal(typeof await textToMultimodalContent('没有图片标签的文本'), 'string');

        setupImageTestConfig();
        const origFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => ({ ok: false, status: 500, text: async () => '{"error":"x"}' });
        const img = new Image();
        img.imageId = 'img_mm_text';
        img.url = 'https://example.com/a.png';
        (Image as any).imageMap['img_mm_text'] = img;
        try {
            // [img:...] → image_url 内容块数组
            const parts: any = await textToMultimodalContent('看看[img:img_mm_text]');
            assert.ok(Array.isArray(parts), '[img] 应转成内容块数组');
            assert.equal(parts[0].type, 'text');
            assert.equal(parts[0].text, '看看');
            const imagePart = parts.find((p: any) => p.type === 'image_url');
            assert.ok(imagePart, '应包含 image_url 内容块');
            assert.equal(imagePart.image_url.url, 'https://example.com/a.png', '转换失败应保留原 URL');
            // [avatar:...] 同样转内容块数组
            const partsAv: any = await textToMultimodalContent('头像[avatar:QQ:12345]');
            assert.ok(Array.isArray(partsAv), '[avatar] 应转成内容块数组');
            assert.ok(partsAv.find((p: any) => p.type === 'image_url'), 'avatar 应转 image_url');
            // 无法解析的图片：保留原标签文本
            const parts2: any = await textToMultimodalContent('没有这张图[img:not_exist_xxx]');
            assert.ok(Array.isArray(parts2));
            const textOnly = parts2.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
            assert.ok(textOnly.includes('[img:not_exist_xxx]'), '无法解析的图片应保留原标签');
        } finally {
            delete (Image as any).imageMap['img_mm_text'];
            (globalThis as any).fetch = origFetch;
            restoreImageTestConfig();
        }
    }
,

    /** 模型解析（v4）：候选按能力标签；默认取首个可用同类型模型；覆盖优先、失效回退；重名用 [序号]:模型名 */
    testGetChatModelResolution(): void {
        try {
            // 单文本候选 → 三个对话用途自动默认同一模型
            seedPinnedConns([pinConn('deepseek', ['text-a'])]);
            assert.equal(Model.getChatModel('chat')?.name, 'text-a');
            assert.equal(Model.getChatModel('summarization')?.name, 'text-a');
            assert.equal(Model.getChatModel('judge')?.name, 'text-a');
            // 嵌入/识图候选为空 → 无默认
            assert.equal(Model.getEmbeddingModel('text-embedding'), null);
            assert.equal(Model.getMultimodalModel('image-understanding'), null);

            // 多文本候选 → 默认取第一个（首个可用）
            seedPinnedConns([pinConn('deepseek', ['text-a', 'text-b'])]);
            assert.equal(Model.getChatModel('chat')?.name, 'text-a', '多候选默认应取第一个');

            // 视觉模型：**v5 起必须显式声明**（不再靠命名猜测，见 catalog.ts 与方案 4.3）
            // 默认 image-understanding；也可作对话候选
            seedPinnedConns([pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' })]);
            const itt = Model.getMultimodalModel('image-understanding');
            assert.equal(itt?.name, 'glm-4v');
            assert.equal(itt?.isMultimodal, true, '声明为 vision 的模型应进入识图候选');
            assert.equal(Model.getChatModel('chat')?.name, 'glm-4v', '视觉模型可作对话候选');
            // 未声明的同名模型不再被当作视觉（回归：命名猜测已删除）
            seedPinnedConns([pinConn('zhipu', ['glm-4v'])]);
            assert.equal(Model.getMultimodalModel('image-understanding'), null,
                'glm-4v 未声明 kind 时不得进识图候选（v5 不再猜测视觉）');
            assert.deepEqual(Model.entries[0].tags, ['text']);
            // 多个视觉候选 → 识图默认取第一个
            seedPinnedConns([
                pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' }),
                pinConnTyped('openai', ['gpt-4o'], { 'gpt-4o': 'vision' }),
            ]);
            assert.equal(Model.getMultimodalModel('image-understanding')?.name, 'glm-4v', '识图默认取首个视觉模型');

            // 嵌入白名单：进 text-embedding（首个）但绝不进对话候选
            seedPinnedConns([pinConn('openai', ['text-embedding-3-small']), pinConn('siliconflow', ['BAAI/bge-m3'])]);
            assert.equal(Model.getEmbeddingModel('text-embedding')?.name, 'text-embedding-3-small', '嵌入默认取首个');
            assert.equal(Model.getChatModel('chat'), null, '嵌入模型不得进对话候选');

            // 生图类不进任何候选
            seedPinnedConns([pinConn('openai', ['dall-e-3', 'gpt-image-1'])]);
            assert.equal(Model.getChatModel('chat'), null);
            assert.equal(Model.getMultimodalModel('image-understanding'), null);
            assert.equal(Model.getEmbeddingModel('text-embedding'), null);

            // 覆盖：多候选时绑定任意可用模型生效；失效覆盖回退默认（首个）
            seedPinnedConns([pinConn('deepseek', ['text-a', 'text-b'])]);
            Model.purposeModelOverrides.chat = 'text-b';
            assert.equal(Model.getChatModel('chat')?.name, 'text-b', '覆盖应生效');
            Model.purposeModelOverrides.chat = 'no-such';
            assert.equal(Model.getChatModel('chat')?.name, 'text-a', '失效覆盖回退默认（首个可用）');

            // 重名跨连接 → ref=[序号]:模型名；裸名歧义覆盖失效回退默认首个
            seedPinnedConns([pinConn('deepseek', ['same']), pinConn('openai', ['same'])]);
            assert.equal(Model.entries.length, 2);
            assert.deepEqual(Model.entries.map(e => e.ref).sort(), ['[0]:same', '[1]:same']);
            Model.purposeModelOverrides.chat = 'same';
            assert.equal(Model.getChatModel('chat')?.provider, 'deepseek', '裸名重名歧义失效应回退默认首个（[0]）');
            Model.purposeModelOverrides.chat = '[1]:same';
            assert.equal(Model.getChatModel('chat')?.provider, 'openai', '[序号]:名 覆盖应精确命中');
        } finally {
            Model.reset();
        }
    }
,

    /** 模型类型手动声明（api连接 [types]）：声明后立即进对应用途候选，嵌入模型不再误入对话候选 */
    testModelTypesManualDeclaration(): void {
        try {
            // 未声明：网关自命名模型（名字不含 embed/vision 等关键词）全部归 text，嵌入模型被误用为对话模型、嵌入/识图无候选
            seedPinnedConns([pinConn('custom', ['gw-vec-1', 'gw-vl-1', 'gw-chat-1'])]);
            assert.equal(Model.entries.every(e => e.tags.includes('text')), true, '未声明时应全部归 text');
            assert.equal(Model.getEmbeddingModel('text-embedding'), null);
            assert.equal(Model.getMultimodalModel('image-understanding'), null);
            assert.equal(Model.getChatModel('chat')?.name, 'gw-vec-1', '未声明时首个候选被误用为对话模型');

            // 声明后：嵌入/识图各有候选，对话候选只剩纯文本
            seedPinnedConns([pinConnTyped('custom', ['gw-vec-1', 'gw-vl-1', 'gw-chat-1'], {
                'gw-vec-1': 'embed',
                'gw-vl-1': 'vision',
                'gw-chat-1': 'text',
            })]);
            const embed = Model.getEmbeddingModel('text-embedding');
            assert.equal(embed?.name, 'gw-vec-1', 'embed 声明应进嵌入候选');
            assert.equal(embed?.tags.includes('embed'), true);
            assert.equal(Model.getChatModel('chat')?.name, 'gw-vl-1', '对话候选按列表顺序取首个非嵌入/非生图模型（vision 可当对话模型）');
            assert.equal(Model.listModelsForUse('chat').some(m => m.name === 'gw-vec-1'), false, '嵌入声明后不得再进对话候选');
            const vl = Model.getMultimodalModel('image-understanding');
            assert.equal(vl?.name, 'gw-vl-1', 'vision 声明应进识图候选');
            assert.equal(vl?.isMultimodal, true, 'vision 声明应让模型按多模态处理');
        } finally {
            Model.reset();
        }
    }
,

    /** 手动声明绝对优先：可把视觉模型声明为纯文本、把嵌入模型声明为多模态（两个方向都成立） */
    testModelTypesManualAbsolutePriority(): void {
        try {
            // 方向一：视觉模型 → text（摘出识图候选，仍可作对话模型）
            seedPinnedConns([pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'text' })]);
            assert.equal(Model.entries[0].tags.includes('text'), true, '声明应覆盖命名视觉白名单');
            assert.equal(Model.getMultimodalModel('image-understanding'), null, '声明 text 应摘出识图候选');
            assert.equal(Model.getChatModel('chat')?.name, 'glm-4v', '声明 text 后仍可作对话模型');

            // 方向二：嵌入模型 → vision（摘出嵌入候选，进识图与对话候选）
            seedPinnedConns([pinConnTyped('openai', ['text-embedding-3-small'], { 'text-embedding-3-small': 'vision' })]);
            assert.equal(Model.getEmbeddingModel('text-embedding'), null, '声明 vision 应摘出嵌入候选');
            assert.equal(Model.getMultimodalModel('image-understanding')?.name, 'text-embedding-3-small');
            assert.equal(Model.getChatModel('chat')?.name, 'text-embedding-3-small', 'vision 声明可作对话候选');

            // 方向三：覆盖生图/排序等命名终值白名单
            seedPinnedConns([pinConnTyped('openai', ['dall-e-3', 'bge-reranker-v2'], { 'dall-e-3': 'text', 'bge-reranker-v2': 'text' })]);
            assert.equal(Model.getChatModel('chat')?.name, 'dall-e-3', '手动声明应覆盖生图白名单');
        } finally {
            Model.reset();
        }
    }
,

    /**
     * 模型 kind（v5，取代 v4「api连接」的 [types] 表）：声明后进对应用途候选。
     *
     * v4 这个位置测的是 TOML 的坑（大小写容错、点号裸键被解析成嵌套表、[types] 顺序错整行跳过）。
     * v5 用 JSON 后这些坑**在语法层面不存在**：kind 是模型对象上的普通字段，
     * 模型名不需要加引号、也没有"表必须写在最后"的约束。因此改为验证等价语义。
     */
    testModelKindFromV5(): void {
        try {
            // 1) 声明生效：embed 进嵌入候选且不进对话候选；vision 可进识图与对话
            seedFromV5Config({
                version: 5,
                providers: [v5Conn({
                    baseURL: 'https://gw/v1',
                    models: [
                        v5Model('gw-vec-1', 'gw-vec-1', 'embed'),
                        v5Model('gw-vl-1', 'gw.model.vl', 'vision'),
                        v5Model('plain', 'plain', 'text'),
                    ],
                })],
            });
            assert.equal(Model.states[0].status, 'ok');
            assert.equal(Model.getEmbeddingModel('text-embedding')?.name, 'gw-vec-1', 'embed 应进嵌入候选');
            // 模型名含点号也无需引号（v4 需要，v5 不需要）
            assert.equal(Model.getMultimodalModel('image-understanding')?.name, 'gw.model.vl', '带点号的模型名应正常');
            assert.equal(Model.getChatModel('chat')?.name, 'gw.model.vl', '对话候选按列表顺序（vision 可当对话模型）');
            assert.equal(Model.listModelsForUse('chat').some(m => m.name === 'gw-vec-1'), false, '嵌入模型不得进对话候选');

            // 2) 未声明 kind → 回退命名推断（纯文本名归 text）
            seedFromV5Config({
                version: 5,
                providers: [v5Conn({ baseURL: 'https://gw/v1', models: [v5Model('a', 'gw-selfnamed-1')] })],
            });
            assert.equal(Model.entries[0].tags.includes('text'), true, '未声明时按命名推断为 text');

            // 3) 非法 kind → 整份配置被拒（v5 是"整体拒绝"，不是 v4 的"忽略该键"）
            const bad = seedFromV5Config({
                version: 5,
                providers: [v5Conn({ baseURL: 'https://gw/v1', models: [{ id: 'a', name: 'a', kind: '多模态' }] })],
            });
            assert.ok(bad.issues.length > 0, '非法 kind 应报错');
            assert.equal(bad.conns.length, 0, '非法配置整体拒绝（不做部分生效）');
            assert.equal(Model.states.length, 0);
        } finally {
            delete TC.stringConfigs['模型配置'];
            resetModelConfigCacheForTest();
            setModelListDepsForTest();
            resetConfigCache();
            Model.reset();
        }
    }
,

    /** [types] 声明未命中模型列表：打一行 warning（同一声明只打一次），列表未就绪/已命中时不提示 */
    testModelTypesUnusedDeclarationWarning(): void {
        const origEmit = (Logger as any).emit;
        const warnings: string[] = [];
        (Logger as any).emit = (level: string, ...data: any[]) => {
            if (level !== '警告') return;
            warnings.push(data.map(d => typeof d === 'string' ? d : JSON.stringify(d)).join(' '));
        };
        try {
            // 1) 拼写错误的声明 → 恰好一条 warning，且含声明的模型名
            seedPinnedConns([pinConnTyped('custom', ['real-model'], { 'ghost-model': 'embed' })]);
            assert.equal(warnings.length, 1, '未命中的声明应恰好提示一次');
            assert.ok(warnings[0].includes('ghost-model'), '提示应含声明的模型名');

            // 2) 重建/重拉不重复提示
            Model.rebuildEntries();
            assert.equal(warnings.length, 1, '同一进程内同一声明不重复提示');

            // 3) 命中的声明不提示
            warnings.length = 0;
            seedPinnedConns([pinConnTyped('custom', ['real-model'], { 'real-model': 'embed' })]);
            assert.equal(warnings.length, 0, '命中的声明不应提示');

            // 4) 列表未就绪（拉取中/失败）不误报
            warnings.length = 0;
            Model.reset();
            Model.bootstrap([{
                provider: 'openai', apiKey: 'k', baseUrl: 'https://o',
                ignore: false, models: null, modelTypes: { 'x': 'embed' }, request: {},
            }], [], { fetch: async () => { throw new Error('boom'); } });
            assert.equal(Model.states[0].status, 'pending', '拉取完成前不判定');
            assert.equal(warnings.length, 0, '列表未就绪时不应误报');

            // 5) ignore=1 的忽略连接不提示
            warnings.length = 0;
            seedPinnedConns([{ provider: 'custom', apiKey: 'k', baseUrl: 'https://x', ignore: true, models: ['real-model'], modelTypes: { 'ghost': 'embed' }, request: {} }]);
            assert.equal(warnings.length, 0, '忽略连接不应提示');
        } finally {
            (Logger as any).emit = origEmit;
            Model.reset();
        }
    }
,

    /** 列表接口能力位：真实解析路径（桩 HTTP 响应）下，供应商自报能力位参与分类 */
    async testModelListCapabilityHints(): Promise<void> {
        const origFetch = (globalThis as any).fetch;
        try {
            const data = {
                data: [
                    { id: 'gw-vec', type: 'embeddings' },
                    { id: 'gw-vl', architecture: { input_modalities: ['text', 'image'] } },
                    { id: 'gw-task', task: 'embed' },
                    { id: 'gw-caps', capabilities: ['completion', 'vision'] },
                    { id: 'gw-flag', supports_vision: true },
                    { id: 'claude-x', type: 'model' },   // anthropic 风格：type=model 不应误判
                    { id: 'plain-model' },                // 无能力位字段：退回命名猜测
                ],
            };
            (globalThis as any).fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
            Model.reset();
            Model.bootstrap([{ provider: 'openrouter', apiKey: 'k', baseUrl: 'https://o', ignore: false, models: null, request: {} }], []);
            await Model.ensureLoaded();
            assert.equal(Model.states[0].status, 'ok');

            const tagsOf = (name: string) => Model.entries.find(e => e.name === name)?.tags ?? [];
            assert.deepEqual(tagsOf('gw-vec'), ['embed'], 'type=embeddings 应识别为嵌入');
            assert.deepEqual(tagsOf('gw-vl'), ['vision'], 'input_modalities 含 image 应识别为多模态');
            assert.deepEqual(tagsOf('gw-task'), ['embed'], 'task=embed 应识别为嵌入');
            assert.deepEqual(tagsOf('gw-caps'), ['vision'], 'capabilities 含 vision 应识别为多模态');
            assert.deepEqual(tagsOf('gw-flag'), ['vision'], 'supports_vision 应识别为多模态');
            assert.deepEqual(tagsOf('claude-x'), ['text'], 'type=model 不应误判');
            assert.deepEqual(tagsOf('plain-model'), ['text'], '无能力位字段应退回命名猜测');

            // 候选生效：嵌入进嵌入候选且不进对话候选；多模态进识图候选
            assert.equal(Model.getEmbeddingModel('text-embedding')?.name, 'gw-vec');
            assert.equal(Model.listModelsForUse('chat').some(m => m.name === 'gw-vec'), false, '接口声明的嵌入模型不应进对话候选');
            assert.equal(Model.getMultimodalModel('image-understanding')?.name, 'gw-vl');

            // states 侧：模型名保序去重；能力位只存内存
            assert.deepEqual(Model.states[0].modelNames, ['gw-vec', 'gw-vl', 'gw-task', 'gw-caps', 'gw-flag', 'claude-x', 'plain-model']);
            assert.deepEqual(Model.states[0].hints['gw-vl'], { vision: true });
        } finally {
            (globalThis as any).fetch = origFetch;
            Model.reset();
        }
    }
,

    /** 接口能力位只取正向证据：保守元数据不降级命名判定；命名终值优先于接口能力位 */
    async testModelListHintsNoDowngrade(): Promise<void> {
        const origFetch = (globalThis as any).fetch;
        try {
            const data = {
                data: [
                    { id: 'glm-4v', capabilities: ['completion'] },   // 保守元数据：不产出 text，命名仍判视觉
                    { id: 'text-embedding-3-small', type: 'vlm' },    // 命名终值优先于接口（防网关元数据质量差）
                ],
            };
            (globalThis as any).fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
            Model.reset();
            Model.bootstrap([{ provider: 'openai', apiKey: 'k', baseUrl: 'https://o', ignore: false, models: null, request: {} }], []);
            await Model.ensureLoaded();

            const tagsOf = (name: string) => Model.entries.find(e => e.name === name)?.tags ?? [];
            // v5 起**不再靠命名猜视觉**：网关只报保守元数据、用户也没声明 kind 时，glm-4v 归 text。
            // 要识图请在配置里写 kind:"vision"（生成器会自动预填）。
            assert.deepEqual(tagsOf('glm-4v'), ['text'], 'v5 不再按命名猜视觉，未声明即为 text');
            assert.deepEqual(tagsOf('text-embedding-3-small'), ['embed'], '命名终值应优先于接口能力位');
            assert.equal(Model.getEmbeddingModel('text-embedding')?.name, 'text-embedding-3-small');
            assert.equal(Model.getMultimodalModel('image-understanding'), null, '未声明 vision 时识图无候选');
        } finally {
            (globalThis as any).fetch = origFetch;
            Model.reset();
        }
    }
,

    /** 老式 string[] 拉取结果仍按原行为工作（无能力位 → 纯命名猜测） */
    async testModelListLegacyStringResult(): Promise<void> {
        try {
            await seedAutoConns([{ provider: 'openai', apiKey: 'k', baseUrl: 'https://o', ignore: false, models: null, request: {} }], async () => ['m1', 'text-embedding-3-small']);
            assert.deepEqual(Model.states[0].modelNames, ['m1', 'text-embedding-3-small']);
            assert.deepEqual(Model.states[0].hints, {}, '字符串结果不应产生能力位');
            assert.equal(Model.getChatModel('chat')?.name, 'm1');
            assert.equal(Model.getEmbeddingModel('text-embedding')?.name, 'text-embedding-3-small');
            assert.ok(Model.entries.some(e => e.tags.includes('embed')), '拉取模型应完成分类');
        } finally {
            Model.reset();
        }
    }
,

    /** Agent.chat：多模态 user content 为内容块数组、纯文本为字符串；请求层收到解析出的模型实例 */
    async testAgentChatPassesResolvedModel(): Promise<void> {
        const origSend = (streamService as any).sendChatRequest;
        let captured: any = null;
        (streamService as any).sendChatRequest = async (messages: any, _tools: any, _tc: any, _rid: any, model: any) => {
            captured = { messages, model };
            return { content: '回复', tool_calls: [] };
        };
        try {
            // 多模态：content 为内容块数组，模型为视觉实例
            // v5 起视觉需显式声明（glm-4v 不再靠命名自动判为 vision）
            seedPinnedConns([pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' })]);
            const agent = new Agent();
            // D3：默认不解析图片（breaking）；需要模型看图必须显式 allowImages
            const ret = await agent.chat('看看[img:not_exist_zz]', { allowImages: true });
            assert.equal(ret, '回复');
            assert.ok(Array.isArray(captured.messages[0].content), '多模态 user content 应为内容块数组');
            assert.equal(captured.model.name, 'glm-4v', '请求层应收到解析出的多模态模型');
            assert.equal(captured.model.isMultimodal, true);

            await agent.chat('看看[img:not_exist_zz]');
            assert.equal(typeof captured.messages[0].content, 'string', '默认 chat() 不应把 [img:] 解析成图片块');

            // 纯文本：content 为字符串，模型为文本实例
            seedPinnedConns([pinConn('deepseek', ['text-a'])]);
            const agent2 = new Agent();
            await agent2.chat('你好');
            assert.equal(typeof captured.messages[0].content, 'string', '纯文本 user content 应为字符串');
            assert.equal(captured.model.name, 'text-a');
            assert.equal(captured.model.isMultimodal, false);
        } finally {
            (streamService as any).sendChatRequest = origSend;
            Model.reset();
        }
    }
,

    /** isMultimodalChat：跟随全局 chat 模型；默认取首个可用；覆盖指定视觉模型时按多模态处理 */
    testIsMultimodalChat(): void {
        const agent = new Agent();
        const stubSession = {} as any;
        try {
            // 首个文本候选在前的两个候选 → chat 默认 text-a → 按纯文本处理
            // （v5 起视觉需显式声明，故 glm-4v 标为 vision 才能参与本用例的比较）
            seedPinnedConns([pinConn('deepseek', ['text-a']), pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' })]);
            assert.equal((agent as any).isMultimodalChat(stubSession), false, '默认文本模型应按纯文本处理');
            // 覆盖指定视觉模型 → 多模态
            Model.purposeModelOverrides.chat = 'glm-4v';
            assert.equal((agent as any).isMultimodalChat(stubSession), true, '覆盖视觉模型时按多模态处理');
            // 覆盖指定文本模型 → 纯文本
            Model.purposeModelOverrides.chat = 'text-a';
            assert.equal((agent as any).isMultimodalChat(stubSession), false, '覆盖文本模型时按纯文本处理');
            // 视觉模型排在前 → 默认取它 → 多模态
            seedPinnedConns([pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' }), pinConn('deepseek', ['text-a'])]);
            assert.equal((agent as any).isMultimodalChat(stubSession), true, '首个候选为视觉模型时按多模态处理');
        } finally {
            Model.reset();
        }
    }
,

    /** .ai model：list 读加载快照（不联网）、pull 立即拉取并展示、分用途查看/设置/歧义/编号 */
    async testCmdModelSetAndQuery(): Promise<void> {
        const origReply = (globalThis as any).seal.replyToSender;
        const origModel = SubCmd.map['model'];
        let replied = '';
        (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { replied = text; };
        const base = {
            ctx: { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:10000', name: '测试员' } } as any,
            msg: {} as any,
            epId: 'QQ:10000',
            uid: 'QQ:10000',
            gid: '',
            sid: 'QQ:10000',
            page: 1,
            ret: {} as any
        };
        const runCmd = async (...args: string[]) => {
            replied = '';
            await SubCmd.map['model'].solve({ ...base, cmdArgs: { getArgN: (n: number) => args[n - 1] ?? '' } } as any);
        };
        try {
            registerCmdModel(); // 注册到 SubCmd.map（幂等覆盖）

            // list：使用钉住/加载保存的列表，不联网（pinned 来源），展示序号与模型
            seedPinnedConns([pinConn('deepseek', ['deepseek-v4-flash', 'deepseek-reasoner'], 'https://api.deepseek.com/v1')]);
            await runCmd('model', 'list');
            assert.ok(replied.includes('[0] deepseek · https://api.deepseek.com/v1 · 钉住 · 2 个模型'), 'list 应展示连接头: ' + replied);
            assert.ok(replied.includes('deepseek-v4-flash'), 'list 应包含模型: ' + replied);
            assert.ok(replied.includes('deepseek-reasoner'), 'list 应包含全部模型: ' + replied);

            // pull：自动连接 + 假 fetcher 立即拉取并更新列表
            await seedAutoConns(
                [pinConn('openai', [], 'https://api.openai.com/v1')],
                async (ctx: any) => { assert.equal(ctx.provider, 'openai'); return ['gpt-5.1', 'text-embedding-3-small']; }
            );
            await runCmd('model', 'pull');
            assert.ok(replied.includes('gpt-5.1'), 'pull 后应展示拉取到的模型: ' + replied);
            assert.equal(Model.states[0].source, 'auto', '自动拉取来源应为 auto');
            assert.equal(Model.entries.some(e => e.tags.includes('embed')), true, '嵌入模型应被分类');

            // 无参数总览应包含六个用途 + 连接状态
            await runCmd('model');
            assert.ok(replied.includes('对话（chat）'), '总览应包含 chat: ' + replied);
            assert.ok(replied.includes('识图（image-understanding）'), '总览应包含识图: ' + replied);
            assert.ok(replied.includes('嵌入（text-embedding）'), '总览应包含嵌入: ' + replied);
            assert.ok(replied.includes('连接状态'), '总览应包含连接状态: ' + replied);
            assert.ok(!replied.includes('候选模型'), '总览不应展示候选列表: ' + replied);

            // 分用途：chat 多候选 → 默认取首个可用；单用途视图展示该用途候选
            seedPinnedConns([pinConn('deepseek', ['text-a', 'text-b'])]);
            await runCmd('model', 'chat');
            assert.ok(replied.includes('对话（chat）: text-a（自动 · 首个可用）'), '默认应取首个可用: ' + replied);
            assert.ok(replied.includes('候选模型（按取用顺序）:'), '.ai model <用途> 应展示该用途候选: ' + replied);
            assert.ok(replied.includes('text-b'), '候选应含第二个模型: ' + replied);

            // 设置 chat：裸名 → 覆盖持久化；再查总览应标注**来自运行时覆盖层**
            await runCmd('model', 'chat', 'text-b');
            assert.equal(Model.purposeModelOverrides.chat, 'text-b');
            assert.ok(replied.includes('已设置对话（chat）全局模型: text-b'), replied);
            assert.equal(Model.getChatModel('chat')?.name, 'text-b', '覆盖应立即生效');
            await runCmd('model', 'chat');
            assert.ok(replied.includes('运行时覆盖 · 由 .ai model 设置'),
                '应标注当前值来自运行时覆盖层: ' + replied);

            // 覆盖失效（模型被移除）→ 自动回退默认，且失效标注保留
            seedPinnedConns([pinConn('deepseek', ['text-a'])]);
            Model.purposeModelOverrides.chat = 'text-b';
            await runCmd('model', 'chat');
            assert.equal(Model.getChatModel('chat')?.name, 'text-a', '失效覆盖回退默认（首个可用）');
            assert.ok(replied.includes('已失效并回退：运行时覆盖 text-b'), '应标注覆盖已失效: ' + replied);

            // ignore=1 的连接不在指令输出中（.ai model list 不显示忽略连接与“已忽略”行）
            Model.reset();
            Model.bootstrap([
                { provider: 'deepseek', apiKey: 'k', baseUrl: 'https://d', ignore: false, models: ['visible-a'], request: {} },
                { provider: 'openai', apiKey: 'k', baseUrl: 'https://o', ignore: true, models: ['hidden-b'], request: {} },
            ], []);
            await runCmd('model', 'list');
            assert.ok(replied.includes('visible-a'), 'list 应包含非忽略连接模型: ' + replied);
            assert.ok(!replied.includes('hidden-b'), '忽略连接的模型不应出现在 list: ' + replied);
            assert.ok(!replied.includes('已忽略'), '忽略连接不应以“已忽略”行出现: ' + replied);

            // 重名跨连接 → 裸名歧义；[序号]:模型名 精确
            seedPinnedConns([pinConn('deepseek', ['same']), pinConn('openai', ['same'])]);
            await runCmd('model', 'chat', 'same');
            assert.ok(replied.includes('多个同名模型'), '同名裸名应提示歧义: ' + replied);
            assert.ok(replied.includes('[0]:same'), '应列出 [0]:same: ' + replied);
            assert.ok(replied.includes('[1]:same'), '应列出 [1]:same: ' + replied);
            await runCmd('model', 'chat', '[1]:same');
            assert.equal(Model.purposeModelOverrides.chat, '[1]:same');
            assert.equal(Model.getChatModel('chat')?.provider, 'openai');

            // 编号选择（候选列表第 N 个）
            seedPinnedConns([pinConn('deepseek', ['model-x', 'model-y'])]);
            await runCmd('model', 'chat', '2');
            assert.equal(Model.purposeModelOverrides.chat, 'model-y', '编号 2 应命中第 2 个候选');

            // 不存在的模型应报错；clr 视为模型名不存在（无清除分支）
            await runCmd('model', 'chat', 'no-such');
            assert.ok(replied.includes('模型 no-such 不存在'), replied);
            await runCmd('model', 'clr');
            assert.ok(replied.includes('模型 clr 不存在'), '不应再有 clr 清除分支');

            // 识图/嵌入：视觉与嵌入候选可分别绑定
            // v5 起视觉需显式声明（否则 glm-4v 不进识图候选，绑定会被判为用途不符）
            seedPinnedConns([pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' }), pinConn('openai', ['text-embedding-3-small'])]);
            await runCmd('model', 'image-understanding', 'glm-4v');
            assert.equal(Model.purposeModelOverrides['image-understanding'], 'glm-4v');
            await runCmd('model', 'text-embedding', '1');
            assert.equal(Model.purposeModelOverrides['text-embedding'], 'text-embedding-3-small');
        } finally {
            (globalThis as any).seal.replyToSender = origReply;
            if (origModel) SubCmd.map['model'] = origModel; else delete SubCmd.map['model'];
            Model.reset();
        }
    }
,


    

    

    

    

    

    /** Agent.chatMessages：多模态 user content 转内容块数组、assistant content 保持字符串；纯文本保持字符串 */
    async testAgentChatMessagesMultimodal(): Promise<void> {
        const origSend = (streamService as any).sendChatRequest;
        let captured: any = null;
          (streamService as any).sendChatRequest = async (messages: any, _tools: any, _tc: any, _rid: any, model: any) => {
            captured = { messages, model };
            return { content: '回复', tool_calls: [] };
        };
        try {
            // 多模态：user content 为内容块数组，assistant content 保持字符串，模型为多模态实例
            // v5 起视觉需显式声明
            seedPinnedConns([pinConnTyped('zhipu', ['glm-4v'], { 'glm-4v': 'vision' })]);
            const agent = new Agent();
            const ret = await agent.chatMessages([
                { role: 'user', content: '看看[img:not_exist_zz]' },
                { role: 'assistant', content: '好的' }
            ], { allowImages: true });
            assert.equal(ret, '回复');
            assert.ok(Array.isArray(captured.messages[0].content), '多模态 user content 应为内容块数组');
            assert.ok(captured.messages[0].content.some((p: any) => p.type === 'text'), '内容块应含 text 块');
            assert.equal(captured.messages[1].content, '好的', 'assistant content 应保持字符串');
            assert.equal(captured.model.name, 'glm-4v', '请求层应收到解析出的多模态模型');
            assert.equal(captured.model.isMultimodal, true);

            // D3：默认不解析图片（breaking）
            await agent.chatMessages([{ role: 'user', content: '看看[img:not_exist_zz]' }]);
            assert.equal(typeof captured.messages[0].content, 'string', '默认 chatMessages() 不应把 [img:] 解析成图片块');

            // 纯文本：user content 保持字符串，模型为文本实例
            seedPinnedConns([pinConn('deepseek', ['text-a'])]);
            const agent2 = new Agent();
            await agent2.chatMessages([{ role: 'user', content: '看看[img:not_exist_zz]' }]);
            assert.equal(typeof captured.messages[0].content, 'string', '纯文本 user content 应为字符串');
            assert.equal(captured.model.name, 'text-a');
            assert.equal(captured.model.isMultimodal, false);
        } finally {
            (streamService as any).sendChatRequest = origSend;
            Model.reset();
        }
    }
,

    /** 识图模型配置：未配置 image-understanding 模型时查询一次、不写描述、不抛错；配置后调用 callITT 并写入描述 */
    async testImageUnderstandingSwitch(): Promise<void> {
        setupImageTestConfig();
        const origGet = Model.getMultimodalModel;
        try {
            // 未配置识图模型：查询一次后直接返回，不写描述、不抛错
            const imgOff = new Image();
            imgOff.imageId = 'img_itt_off';
            imgOff.url = 'https://example.com/off.png';
            let getCalled = 0;
            Model.getMultimodalModel = (_use: any) => { getCalled++; return null; };
            await imgOff.imageToText();
            assert.equal(getCalled, 1, '未配置识图模型时应查询一次多模态模型');
            assert.equal(imgOff.description, '', '未配置识图模型时不应设置描述');

            // 配置识图模型：调用识图模型的 callITT 并把结果写入 description
            const imgOn = new Image();
            imgOn.imageId = 'img_itt_on';
            imgOn.url = 'https://example.com/on.png';
            const vision: any = { name: 'vision-itt', isMultimodal: true, callITT: async () => '' };
            let capturedSrc = '';
            let capturedPrompt = '';
            vision.callITT = async (src: string, prompt: string) => {
                capturedSrc = src;
                capturedPrompt = prompt;
                return '图片中有一只猫';
            };
            Model.getMultimodalModel = (_use: any) => vision;
            await imgOn.imageToText('描述这张图');
            assert.equal(imgOn.description, '图片中有一只猫', '配置识图模型后识别结果应写入 description');
            assert.equal(capturedSrc, 'https://example.com/on.png', 'callITT 应收到图片 src');
            assert.equal(capturedPrompt, '描述这张图', 'callITT 应收到自定义提示词');
        } finally {
            Model.getMultimodalModel = origGet;
            Model.reset();
            restoreImageTestConfig();
        }
    }
,

    /** 图片识别文本超长改为 head 截断（不再压缩）：description=开头 N 字，rawDescription=完整原文 */
    async testImageTextTruncatedKeepsRawDescription(): Promise<void> {
        setupImageTestConfig();
        TC.intConfigs['图片识别展示截断字数'] = 20;
        resetConfigCache();
        const origGet = Model.getMultimodalModel;
        try {
            const full = '识别结果第一段描述文字较长'.repeat(5); // 远长于 20
            const vision: any = { name: 'vision-trunc', isMultimodal: true, callITT: async () => full };
            Model.getMultimodalModel = (_use: any) => vision;
            const img = new Image();
            img.imageId = 'img_trunc_1';
            img.url = 'https://example.com/trunc.png';
            await img.imageToText();
            assert.equal(img.description, full.slice(0, 20), 'description 应只展示开头 20 字');
            assert.equal(img.rawDescription, full, 'rawDescription 应保留完整识别原文');
            // 截断阈值 = 0：不截断、不保留 rawDescription
            TC.intConfigs['图片识别展示截断字数'] = 0;
            resetConfigCache();
            const img2 = new Image();
            img2.imageId = 'img_full_1';
            img2.url = 'https://example.com/full.png';
            await img2.imageToText();
            assert.equal(img2.description, full, '阈值=0 时展示完整内容');
            assert.equal(img2.rawDescription, '', '阈值=0 时不保留 rawDescription 副本');
        } finally {
            delete TC.intConfigs['图片识别展示截断字数'];
            Model.getMultimodalModel = origGet;
            Model.reset();
            restoreImageTestConfig();
        }
    }
,

    /** 模型配置（v4）：Config.model 返回 {conns, rules}；旧列表键全部移除 */
    testModelConfigKeys(): void {
        try {
            resetConfigCache();
            const cfg = (Config as any).model;
            assert.ok(Array.isArray(cfg.conns), '应包含 conns 数组');
            assert.ok(Array.isArray(cfg.rules), '应包含 rules 数组');
            assert.ok(!('MULTIMODAL_MODELS' in cfg), '旧键 MULTIMODAL_MODELS 应已移除');
            assert.ok(!('CHAT_MODELS' in cfg), '旧键 CHAT_MODELS 应已移除');
            assert.ok(!('EMBEDDING_MODELS' in cfg), '旧键 EMBEDDING_MODELS 应已移除');
        } finally {
            Model.reset();
        }
    }
,

    /** enabled:false 与钉住清单（v5）：禁用的连接进 states 但不产模型；空 models 触发自动拉取 */
    testModelIgnoreField(): void {
        try {
            const cfg = seedFromV5Config({
                version: 5,
                providers: [
                    v5Conn({
                        baseURL: 'https://api.deepseek.com/v1',
                        models: [v5Model('flash', 'deepseek-v4-flash'), v5Model('reasoner', 'deepseek-reasoner')],
                    }),
                    v5Conn({
                        baseURL: 'https://api.openai.com/v1',
                        enabled: false,
                        models: [v5Model('gpt51', 'gpt-5.1')],
                    }),
                    v5Conn({
                        baseURL: 'https://api.openai.com/v1',
                        models: [v5Model('gpt4o', 'gpt-4o')],
                    }),
                ],
            });

            assert.equal(cfg.conns.length, 3);
            assert.equal(cfg.rules.length, 0, '没有 per-model request 时不产规则');
            // enabled:false 的连接进 states（保持序号稳定）但不产模型
            assert.equal(Model.states.length, 3);
            assert.equal(Model.states[1].status, 'ignored');
            assert.deepEqual(Model.states.map(s => s.connIndex), [0, 1, 2]);
            assert.equal(Model.states.filter(s => s.status === 'ok').length, 2, '禁用连接不参与模型');
            assert.equal(Model.entries.some(e => e.name === 'gpt-5.1'), false, '禁用连接的模型不应进入注册表');
            assert.equal(Model.entries.some(e => e.name === 'deepseek-v4-flash'), true);
            assert.equal(Model.entries.some(e => e.name === 'gpt-4o'), true);
        } finally {
            delete TC.stringConfigs['模型配置'];
            resetModelConfigCacheForTest();
            setModelListDepsForTest();
            resetConfigCache();
            Model.reset();
        }
    }
,

    /** 会话停止信号（StopEvent/StopError/withTimeout）：stop 后同步唤醒等待者；已停止时不再执行 asyncFunc */
    async testStopEvent(): Promise<void> {
        // 1) 正常完成：带 stopEvent 的 withTimeout 在未 stop 时正常 resolve，并清理 waiter
        {
            const ev = createStopEvent();
            const out = await withTimeout(async () => 'ok', 1000, { stopEvent: ev });
            assert.equal(out, 'ok');
            assert.equal(ev.waiters.length, 0, '完成后应清理等待者');
            assert.equal(ev.fired, false);
        }

        // 2) 超时：未 stop 时按原语义 reject 超时错误
        {
            const ev = createStopEvent();
            await assert.rejects(
                withTimeout(async () => { await new Promise(r => setTimeout(r, 50)); return 'x'; }, 5, { stopEvent: ev }),
                /操作超时/
            );
            assert.equal(ev.waiters.length, 0, '超时后应清理等待者');
        }

        // 3) stop 触发：进行中的 withTimeout 立即以 StopError reject（不等超时/完成）
        {
            const ev = createStopEvent();
            const p = withTimeout(
                async () => { await new Promise(r => setTimeout(r, 200)); return 'done'; },
                5000,
                { stopEvent: ev }
            );
            fireStopEvent(ev);
            await assert.rejects(p, (e: any) => {
                assert.ok(e instanceof StopError, `应为 StopError，实际 ${e?.name}`);
                return true;
            });
            assert.equal(ev.waiters.length, 0, 'stop 后应清空等待者');
            assert.equal(ev.fired, true);
        }

        // 4) 已停止后调用：同步 reject StopError，且不再执行 asyncFunc
        {
            const ev = createStopEvent();
            fireStopEvent(ev);
            let called = 0;
            await assert.rejects(
                withTimeout(async () => { called++; return 'x'; }, 1000, { stopEvent: ev }),
                (e: any) => e instanceof StopError
            );
            assert.equal(called, 0, '已停止时不应再执行 asyncFunc');
        }

        // 5) resetStopEvent 后重新可用；重复 fire 不抛异常（waiters 已清空）
        {
            const ev = createStopEvent();
            resetStopEvent(ev);
            assert.equal(ev.fired, false);
            fireStopEvent(ev);
            fireStopEvent(ev);
            assert.equal(ev.fired, true);
            resetStopEvent(ev);
            const out = await withTimeout(async () => 'again', 1000, { stopEvent: ev });
            assert.equal(out, 'again');
        }
    }
,
    /** 定时器队列重载恢复：按 TimerInfo 实际存档字段（sid/isPrivate/epId）恢复；旧字段名（sessionId/sessionType）条目被跳过（历史 bug：过滤条件与存档字段不一致导致重载后队列恒空） */
    testTimerGetQueueRestoresFromArchive(): void {
        const origGet = (ext as any).storageGet;
        const origQueue = TimerManager.timerQueue;
        const origIntervalId = TimerManager.intervalId;
        TimerManager.timerQueue = [];
        TimerManager.intervalId = 1; // 阻止 add* 触发轮询
        const archived = [
            { sid: 'QQ:10000', isPrivate: true, epId: 'QQ:999', set: 100, target: 200, interval: 0, count: 1, type: 'target', content: '提醒喝水' },
            { sessionId: 'QQ:10000', sessionType: 'user', set: 300, target: 400, type: 'target' }, // 旧格式：应跳过
        ];
        (ext as any).storageGet = (key: string) => key === 'timerQueue' ? JSON.stringify(archived) : '';
        try {
            TimerManager.getTimerQueue();
            assert.equal(TimerManager.timerQueue.length, 1, '只应恢复带 sid 的条目');
            const t = TimerManager.timerQueue[0];
            assert.equal(t.sid, 'QQ:10000');
            assert.equal(t.isPrivate, true);
            assert.equal(t.epId, 'QQ:999');
            assert.equal(t.type, 'target');
            assert.equal(t.target, 200);
            assert.equal(t.content, '提醒喝水');
        } finally {
            (ext as any).storageGet = origGet;
            TimerManager.timerQueue = origQueue;
            TimerManager.intervalId = origIntervalId;
        }
    }
,

    /** 定时器添加即写穿：addTargetTimer 后存储与内存队列一致（变更即落盘，不依赖轮询回调） */
    testTimerAddPersistsImmediately(): void {
        const origSet = (ext as any).storageSet;
        const origQueue = TimerManager.timerQueue;
        const origIntervalId = TimerManager.intervalId;
        TimerManager.timerQueue = [];
        TimerManager.intervalId = 1;
        const writes = new Map<string, string>();
        (ext as any).storageSet = (key: string, value: string) => { writes.set(key, value); };
        try {
            const ctx = { ...makeCtx(), isPrivate: true };
            const session = { id: 'QQ:10000' } as any;
            TimerManager.addTargetTimer(ctx, session, 1234567890, '测试提醒');
            assert.equal(TimerManager.timerQueue.length, 1, '添加后内存队列应有 1 条');
            const raw = writes.get('timerQueue');
            assert.ok(raw, '添加后应立即写入 timerQueue 存档');
            const saved = JSON.parse(raw!);
            assert.equal(saved.length, 1);
            assert.equal(saved[0].sid, 'QQ:10000');
            assert.equal(saved[0].isPrivate, true);
            assert.equal(saved[0].epId, 'QQ:10000');
            assert.equal(saved[0].type, 'target');
            assert.equal(saved[0].target, 1234567890);
            assert.equal(saved[0].content, '测试提醒');
            assert.deepEqual(JSON.parse(raw!), JSON.parse(JSON.stringify(TimerManager.timerQueue)), '存档应与内存队列一致');
        } finally {
            (ext as any).storageSet = origSet;
            TimerManager.timerQueue = origQueue;
            TimerManager.intervalId = origIntervalId;
        }
    }
,

    /** 目标定时器到点执行：成功后从队列移除并立即落盘（写穿）；失败保留待下一轮重试 */
    async testTimerTaskFiredTargetWriteThrough(): Promise<void> {
        const origSet = (ext as any).storageSet;
        const origGet = (ext as any).storageGet;
        const origQueue = TimerManager.timerQueue;
        const origIntervalId = TimerManager.intervalId;
        const origIsTaskRunning = TimerManager.isTaskRunning;
        const origGetEndPoints = (globalThis as any).seal.getEndPoints;
        const origCreateTempCtx = (globalThis as any).seal.createTempCtx;

        const writes = new Map<string, string>();
        (ext as any).storageSet = (key: string, value: string) => { writes.set(key, value); };
        (ext as any).storageGet = (key: string) => writes.get(key) ?? '';
        (globalThis as any).seal.getEndPoints = () => [{ userId: 'QQ:10000' }];
        (globalThis as any).seal.createTempCtx = (_ep: any, msg: any) => ({
            player: { userId: 'QQ:10000', name: '测试员' },
            endPoint: { userId: 'QQ:10000' },
            isPrivate: msg?.messageType === 'private',
            group: null,
        });

        TimerManager.timerQueue = [];
        TimerManager.intervalId = 1;
        TimerManager.isTaskRunning = false;
        const svc = Agent.get('*').sessionService;
        const sid = 'QQ:10000';
        const origSession = svc.sessionMap[sid];
        try {
            let chatCalled = 0;
            svc.sessionMap[sid] = {
                id: sid,
                sessionId: sid,
                chat: async () => { chatCalled++; },
                context: { addSystemUserMessage: async () => { } },
            } as any;

            const now = Math.floor(Date.now() / 1000);
            const timer = new TimerInfo();
            timer.sid = sid;
            timer.isPrivate = true;
            timer.epId = 'QQ:10000';
            timer.set = now - 10;
            timer.target = now - 5; // 已到点
            timer.content = '到点提醒';
            TimerManager.timerQueue.push(timer);
            TimerManager.saveTimerQueue();

            await TimerManager.task();

            assert.equal(chatCalled, 1, '到点目标定时器应执行一次');
            assert.equal(TimerManager.timerQueue.length, 0, '执行成功后应从内存队列移除');
            assert.equal(JSON.parse(writes.get('timerQueue') || '[]').length, 0, '移除后应立即落盘空队列（写穿）');

            // 执行失败：定时器保留在队列（下一轮重试，不静默丢失）
            svc.sessionMap[sid] = {
                id: sid,
                sessionId: sid,
                chat: async () => { throw new Error('chat 失败'); },
                context: { addSystemUserMessage: async () => { } },
            } as any;
            TimerManager.timerQueue = [timer];
            TimerManager.saveTimerQueue();
            await TimerManager.task();
            assert.equal(TimerManager.timerQueue.length, 1, '执行失败应保留定时器');
            assert.equal(JSON.parse(writes.get('timerQueue') || '[]').length, 1, '失败保留的定时器应仍在存档中');
        } finally {
            svc.sessionMap[sid] = origSession;
            (ext as any).storageSet = origSet;
            (ext as any).storageGet = origGet;
            (globalThis as any).seal.getEndPoints = origGetEndPoints;
            (globalThis as any).seal.createTempCtx = origCreateTempCtx;
            TimerManager.timerQueue = origQueue;
            TimerManager.intervalId = origIntervalId;
            TimerManager.isTaskRunning = origIsTaskRunning;
        }
    }
,

    /** 挂起队列分片：savePending 只写轻量子集（epId/isPrivate 等），不含 ctx/msg/endPoint/player 运行时对象，变更即写穿 */
    async testSavePendingShardLightweight(): Promise<void> {
        const origSet = (ext as any).storageSet;
        const origGet = (ext as any).storageGet;
        const writes = new Map<string, string>();
        (ext as any).storageSet = (key: string, value: string) => { writes.set(key, value); };
        (ext as any).storageGet = (key: string) => writes.get(key) ?? '';
        try {
            const session = new Session();
            session.sessionId = 'sess_shard';
            session.sessionType = 'user';
            const ctx = { ...makeCtx(), isPrivate: true };
            const msg = { message: '挂起消息' } as any;
            const messageArray = [{ type: 'text', data: { text: '挂起消息' } }] as any;
            await session.deferReceipt(ctx, msg, messageArray, 'trigger', '因为关键词');
            session.savePending();
            const key = Session.pendingKey('sess_shard');
            const raw = writes.get(key);
            assert.ok(raw, 'savePending 应写入分片 key: ' + key);
            const parsed = JSON.parse(raw!);
            assert.equal(parsed.length, 1);
            const p = parsed[0];
            assert.equal(p.content, '挂起消息');
            assert.equal(p.kind, 'trigger');
            assert.equal(p.systemReason, '因为关键词');
            assert.equal(p.epId, 'QQ:10000');
            assert.equal(p.isPrivate, true);
            assert.ok(!('ctx' in p), '分片不应包含 ctx 运行时对象');
            assert.ok(!('msg' in p), '分片不应包含 msg 运行时对象');
            assert.ok(!('endPoint' in p), '分片不应包含 endPoint');
            assert.ok(!('player' in p), '分片不应包含 player');
        } finally {
            (ext as any).storageSet = origSet;
            (ext as any).storageGet = origGet;
        }
    }
,

    /** SessionService.getSession：从 pending 分片恢复轻量挂起队列（重载后不丢） */
    testSessionServiceRestoresPendingShard(): void {
        const origGet = (ext as any).storageGet;
        const origSet = (ext as any).storageSet;
        const writes = new Map<string, string>();
        (ext as any).storageSet = (key: string, value: string) => { writes.set(key, value); };
        (ext as any).storageGet = (key: string) => writes.get(key) ?? '';
        try {
            const sid = 'sess_restore';
            writes.set('session_' + sid + ':pending', JSON.stringify([
                { content: '恢复的消息', userId: 'QQ:10000', messageId: 'm1', kind: 'trigger', epId: 'QQ:10000', isPrivate: true },
            ]));
            const svc = new SessionService();
            const session = svc.getSession(sid);
            assert.equal(session.pendingQueue.length, 1, '应从分片恢复挂起队列');
            const p = session.pendingQueue[0] as any;
            assert.equal(p.content, '恢复的消息');
            assert.equal(p.epId, 'QQ:10000');
            assert.equal(p.isPrivate, true);
            assert.equal(p.kind, 'trigger');
        } finally {
            (ext as any).storageGet = origGet;
            (ext as any).storageSet = origSet;
        }
    }
,

    /** flushPending：入库后清空 pending 分片（写穿空串），避免重载后脏数据复活 */
    async testFlushPendingClearsShard(): Promise<void> {
        const origSet = (ext as any).storageSet;
        const origGet = (ext as any).storageGet;
        const writes = new Map<string, string>();
        (ext as any).storageSet = (key: string, value: string) => { writes.set(key, value); };
        (ext as any).storageGet = (key: string) => writes.get(key) ?? '';
        try {
            const session = new Session();
            session.sessionId = 'sess_flush_shard';
            session.sessionType = 'user';
            const ctx = { ...makeCtx(), isPrivate: true };
            const msg = { message: '挂起' } as any;
            await session.deferReceipt(ctx, msg, [{ type: 'text', data: { text: '挂起' } }] as any, 'record');
            session.savePending();
            const key = Session.pendingKey('sess_flush_shard');
            assert.equal(JSON.parse(writes.get(key)!).length, 1, 'deferReceipt + savePending 后分片应有 1 条');
            assert.equal(await session.flushPending(), false);
            assert.equal(writes.get(key), '', 'flushPending 后分片应清空');
        } finally {
            (ext as any).storageSet = origSet;
            (ext as any).storageGet = origGet;
        }
    }
,

    

    

    

    

    /** 知识库条目解析：库名/描述/平台来自 JSON 条目 */
    testKbParseEntry(): void {
        const lib = parseKnowledgeLibrary({
            name: '测试库',
            description: '测试描述',
            platforms: ['QQ'],
            content: '# 文档\n正文内容',
        }, 0);
        assert.equal(lib.name, '测试库');
        assert.equal(lib.description, '测试描述');
        assert.deepEqual(lib.platforms, ['QQ']);
        assert.ok(lib.chunks.length > 0, '应解析出分块');
        assert.ok(lib.chunks[0].libraryId === lib.id, '分块应携带库 ID');
        assert.ok(lib.chunks[0].libraryName === '测试库', '分块应携带库名');

        // 描述留空时用正文首段兜底
        const noDesc = parseKnowledgeLibrary({ name: '库', description: '', platforms: [], content: '# 标题\n第一段内容。' }, 1);
        assert.equal(noDesc.description, '第一段内容。');
    }
,

    /** 知识库静态段：超过 100 个库时只显示 100 个并提示总数 */
    testKbFormatLibrariesLimit100(): void {
        const svc = new KnowledgeBaseService();
        (svc as any).libraries = Array.from({ length: 120 }, (_, i) => ({
            id: `kb_lib_${i}`,
            name: `库${i}`,
            description: `描述${i}`,
            chunks: [],
        }));
        const out = svc.formatLibraries(100);
        assert.ok(out.includes('120 libraries total, showing at most 100'), '应提示总数');
        assert.ok(!out.includes('库120'), '不应显示第 120 个库');
        const libLines = out.split('\n').filter(l => l.startsWith('- '));
        assert.ok(libLines.length <= 100, `库行数应不超过 100，实际 ${libLines.length}`);
    }
,

    /** knowledge_docs 应返回库内文档/章节结构 */
    testKbDocsHierarchy(): void {
        const lib = parseKnowledgeLibrary({
            name: '测试库',
            description: '描述',
            platforms: [],
            content: '# 文档A\n## 章节1\n内容1\n## 章节2\n内容2',
        }, 0);
        const svc = new KnowledgeBaseService();
        (svc as any).libraries = [lib];
        (svc as any).chunks = lib.chunks;
        const out = svc.formatLibraryDocs(lib.id, 1, 20);
        assert.ok(out.includes(`Knowledge base: 测试库`), '应包含库名');
        assert.ok(out.includes('Document: 文档A'), '应包含文档标题');
        assert.ok(out.includes('章节1') && out.includes('章节2'), '应包含章节标题');
    }
,

    /** knowledge_search 支持按库过滤 */
    async testKnowledgeSearchByLibraryId(): Promise<void> {
        const lib1 = parseKnowledgeLibrary({
            name: '库A', description: '咖啡库', platforms: [], content: '# 咖啡文档\n咖啡因含量',
        }, 0);
        const lib2 = parseKnowledgeLibrary({
            name: '库B', description: '茶库', platforms: [], content: '# 茶文档\n茶多酚含量',
        }, 1);
        const svc = new KnowledgeBaseService();
        (svc as any).libraries = [lib1, lib2];
        (svc as any).chunks = [...lib1.chunks, ...lib2.chunks];
        (svc as any).loadedSignature = 'test';
        const result = await svc.search('咖啡', 5, lib1.id);
        assert.ok(result.length > 0, '应命中库A');
        assert.ok(result.every(c => c.libraryId === lib1.id), '搜索结果应限定在指定库内');
    }
,

    /** list_tools 支持分页 */
    async testListToolsPagination(): Promise<void> {
        registerDispatchTools();
        const fake = new Tool({
            type: 'function',
            function: {
                name: 'zzz_list_pagination_test',
                description: '分页测试工具',
                parameters: { type: 'object', properties: {} }
            }
        });
        try {
            const session = {
                sessionType: 'group',
                toolState: {
                    list_tools: true,
                    search_tools: true,
                    call_tool: true,
                    zzz_list_pagination_test: true,
                }
            } as any;
            const out = await toolMap['list_tools'].solve(makeCtx(), {} as any, session as any, { page: 1, page_size: 100 });
            assert.ok(out.includes('Available tools'), '应返回工具列表');
            assert.ok(out.includes('zzz_list_pagination_test'), '应包含测试工具');
            assert.ok(out.includes('Page 1 of'), '应包含页码信息');
        } finally {
            delete toolMap['zzz_list_pagination_test'];
        }
    }
,

    /** 原生 function calling 的 tools 只应包含 list_tools/search_tools/call_tool */
    testNativeRequestToolsOnlyListSearchCall(): void {
        registerDispatchTools();
        const fake = new Tool({
            type: 'function',
            function: {
                name: 'zzz_native_fake',
                description: '不应出现在原生 tools 中',
                parameters: { type: 'object', properties: {} }
            }
        });
        try {
            const session = {
                sessionType: 'group',
                toolState: {
                    list_tools: true,
                    search_tools: true,
                    call_tool: true,
                    zzz_native_fake: true,
                }
            } as any;
            const native = Tool.getNativeRequestTools(session);
            assert.ok(native, '应返回原生引导工具');
            assert.ok(native.every(t => ['list_tools', 'search_tools', 'call_tool'].includes(t.function.name)), '原生 tools 只应包含引导工具');
        } finally {
            delete toolMap['zzz_native_fake'];
        }
    }
,

    /**
     * 元工具列表只含已开启的元工具（旧 Tool.getToolSummaries 及其 limit 语义已随工具块重构移除，
     * 改为断言新入口 Tool.getMetaToolInfos 的状态门控）。
     */
    testMetaToolInfosOnlyEnabledMetaTools(): void {
        registerDispatchTools();
        const session = {
            sessionType: 'group',
            toolState: {
                list_tools: true,
                search_tools: true,
                call_tool: true,
            }
        } as any;
        assert.deepEqual(
            Tool.getMetaToolInfos(session, 'QQ').map(info => info.function.name),
            ['list_tools', 'search_tools', 'call_tool'],
            '应只返回已开启的元工具'
        );
        const partial = { sessionType: 'group', toolState: { call_tool: true } } as any;
        assert.deepEqual(
            Tool.getMetaToolInfos(partial, 'QQ').map(info => info.function.name),
            ['call_tool'],
            '未开启的元工具不应出现在提示词工程参数块中'
        );
    }
,

    /**
     * 提示词工程工具块（toolCallFormat）应包含调用格式和元工具摘要。
     *
     * #163 D1-11：**不再渲染各元工具的 parameters JSON**（那会让 S 随工具注册/开关漂移），
     * 只列 `META_TOOL_SUMMARIES` 的名字 + 一句话用途，参数 schema 由 search_tools 现场返回。
     */
    testPromptEngineeringToolBlockContainsMetaParams(): void {
        registerDispatchTools();
        const block = toolCallFormat();
        assert.ok(block.includes('## Tool calls'), '应包含调用格式说明');
        assert.ok(block.includes('### list_tools'), '应包含 list_tools 摘要');
        assert.ok(block.includes('### search_tools'), '应包含 search_tools 摘要');
        assert.ok(block.includes('### call_tool'), '应包含 call_tool 摘要');
        assert.ok(!block.includes('page_size'), '不再内联元工具参数（改由 search_tools 现场返回）');
        assert.ok(block.includes('search_tools'), '应指引用 search_tools 取参数');

        // 关键断言（R1）：常量 —— 无论会话工具开关如何，输出逐字节相同
        const session = { sessionType: 'group', toolState: {} } as any;
        const withInfos = toolCallFormat(Tool.getMetaToolInfos(session, 'QQ').map(info => ({
            name: info.function.name,
            description: String(info.function.description || ''),
            parameters: info.function.parameters ?? { type: 'object', properties: {} },
        })) as any);
        assert.equal(withInfos, block, 'toolCallFormat 不随元工具开关/注册变化（常量段）');
    }
,

    /** skill_list 支持分页参数 */
    async testSkillListPagination(): Promise<void> {
        registerSkills();
        const out = await toolMap['skill_list'].solve(makeCtx(), {} as any, {} as any, { page: 1, page_size: 2 });
        assert.ok(out.includes('Skills ('), '应返回技能列表');
        assert.ok(out.includes('Page 1 of'), '应包含页码信息');
    }
,

    /** 技能摘要按条数上限截断（条数上限是字符预算之外的第二道保险） */
    testSkillSummariesLimit(): void {
        const r = getSkillSummariesBudgeted(1000000, SKILL_INJECT_MAX_ITEMS);
        assert.ok(r.summaries.length <= SKILL_INJECT_MAX_ITEMS, '技能摘要条数应不超过 100');
        if (r.truncated) {
            assert.ok(r.total > r.summaries.length, '截断时 total 应大于已展示条数');
        } else {
            assert.equal(r.total, r.summaries.length, '未截断时 total 应等于已展示条数');
        }
    }
,

    /** 提示词工程工具块不应列出普通工具名称，只保留元工具说明 */
    testPromptEngineeringToolBlockDoesNotListOrdinaryTools(): void {
        registerDispatchTools();
        const fake = new Tool({
            type: 'function',
            function: {
                name: 'zzz_ordinary_tool_not_in_prompt',
                description: '普通工具不应出现在 system prompt 工具块中',
                parameters: { type: 'object', properties: {} }
            }
        });
        try {
            const session = {
                sessionType: 'group',
                toolState: {
                    list_tools: true,
                    search_tools: true,
                    call_tool: true,
                    zzz_ordinary_tool_not_in_prompt: true,
                }
            } as any;
            const infos = Tool.getMetaToolInfos(session, 'QQ');
            const block = toolCallFormat(infos.map(info => ({
                name: info.function.name,
                description: String(info.function.description || ''),
                parameters: info.function.parameters ?? { type: 'object', properties: {} },
            })));
            assert.ok(!block.includes('zzz_ordinary_tool_not_in_prompt'), '普通工具名称不应出现在提示词工程工具块中');
            assert.ok(block.includes('## Meta tools'), '应包含元工具说明');
        } finally {
            delete toolMap['zzz_ordinary_tool_not_in_prompt'];
        }
    }
};
