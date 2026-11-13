// 单元测试入口（拆分自 scripts/unit-test-entry.ts）：config-tools 域，47 个用例。
// 用例顺序与拆分前一致；随 scripts/test-unit.cjs 打包后加载运行，不会启动 SealDice/QQ。
// @ts-nocheck
import {
    Agent, ApiError, BUILTIN_CATEGORY_ORDER, CORE_TOOL_NAMES,
    Config, DEFAULT_CATEGORY, DEFAULT_KB, DEFAULT_KB_JSON,
    DEFAULT_MCP_JSON, DEFAULT_ROLES_JSON, DEFAULT_SKILLS_JSON, EXTERNAL_CATEGORY,
    Image, Model, SKILL_INJECT_MAX_CHARS, SKILL_INJECT_MAX_ITEMS,
    Session, SubCmd, TC, Tool,
    allowSendNow, assert, buildContent, classifyApiError,
    computeArchiveTarget, defaultCmdPriv, escapeToolResultBoundary, ext,
    formatSkillSummaryBlock, getEntryById, getSkillNames, getSkillSummariesBudgeted,
    getSkillViews, isQQLikePlatform, knowledgeService, listBotEntries,
    listEntries, listGroups, makeCtx, makeTestMentalModel,
    markersSection, matchesPlatform, mergeMentalModels, parseKbConfig,
    parseKnowledgeLibrary, parseMaxContextTokens, parseMcpConfig, parseRolesConfig,
    parseSkillsConfig, pinConn, purgeOffline, recordSend,
    refreshSkills, registerCmdKb, registerCmdMcp, registerCmdPub,
    registerCmdSkill, registerCmdTool, registerDispatchTools, registerKnowledgeTools,
    registerPubRead, registerPubSend, registerResourceTools, registerSkills,
    registerSubCommands, registerTools, removeEntry, renderPubSnapshot,
    resetConfigCache, resetImageConfigCacheForTest, resetMCPCacheForTest, resetModelConfigCacheForTest,
    resetPubRegistryForTest, resetResourceConfigCacheForTest, resetSendHistoryForTest, resetWebConfigCacheForTest,
    resolveEntryByPrefix, resolveSessionAddress, runSubCmd, seedFromV5Config,
    seedPinnedConns, setModelListDepsForTest, setPubSessionLoaderForTest, setToolGroupState,
    stripCQCode, toolMap, upsertEntry, v5Conn,
    v5Model,
} from './unit-test-helpers';

export const tests: Record<string, () => void | Promise<void>> = {
/** get_resource_path：本地文件/图片资源应返回解析后的路径，兼容 resource: 与 [img:] */
    async testGetResourcePathLocalAndImage(): Promise<void> {
        const keys = ["本地图片路径", "本地语音路径", "本地文件路径", "本地视频路径"];
        const saved = keys.map(k => [k, TC.templateConfigs[k]] as const);
        TC.templateConfigs["本地图片路径"] = ["unit_img=data/images/unit.png"];
        TC.templateConfigs["本地语音路径"] = ["unit_audio=records/unit.mp3"];
        TC.templateConfigs["本地文件路径"] = ["unit_file=data/files/unit.pdf"];
        TC.templateConfigs["本地视频路径"] = ["unit_video=data/videos/unit.mp4"];
        resetResourceConfigCacheForTest();
        resetImageConfigCacheForTest();
        resetConfigCache();
        registerResourceTools();
        try {
            const tool = toolMap["get_resource_path"];
            assert.ok(tool, "get_resource_path 应已注册");
            const file = JSON.parse(await tool.solve(makeCtx(), {} as any, {} as any, { type: "file", id: "unit_file" }));
            assert.equal(file.ok, true);
            assert.equal(file.type, "file");
            assert.equal(file.id, "unit_file");
            assert.equal(file.scheme, "local");
            assert.ok(String(file.path).includes("unit.pdf"), "本地路径应包含文件名");
            const prefixed = JSON.parse(await tool.solve(makeCtx(), {} as any, {} as any, { type: "file", id: "resource:unit_file" }));
            assert.equal(prefixed.ok, true);
            assert.equal(prefixed.id, "unit_file");
            const image = JSON.parse(await tool.solve(makeCtx(), {} as any, {} as any, { type: "image", id: "[img:unit_img:测试图]" }));
            assert.equal(image.ok, true);
            assert.equal(image.id, "unit_img");
            assert.equal(image.scheme, "local");
            assert.ok(String(image.path).includes("unit.png"), "图片路径应包含文件名");
        } finally {
            for (const [k, v] of saved) {
                if (v === undefined) delete TC.templateConfigs[k];
                else TC.templateConfigs[k] = v;
            }
            resetResourceConfigCacheForTest();
            resetImageConfigCacheForTest();
            resetConfigCache();
        }
    }
,

    /** get_resource_path：mcp:// 默认只做结构解析，不触发 export_file */
    async testGetResourcePathMCPDefault(): Promise<void> {
        const saved = TC.templateConfigs["本地文件路径"];
        TC.templateConfigs["本地文件路径"] = ["unit_mcp=mcp://mcp-files-exec/output/unit.pdf"];
        resetResourceConfigCacheForTest();
        resetImageConfigCacheForTest();
        resetConfigCache();
        registerResourceTools();
        try {
            const tool = toolMap["get_resource_path"];
            const out = JSON.parse(await tool.solve(makeCtx(), {} as any, {} as any, { type: "file", id: "unit_mcp" }));
            assert.equal(out.ok, true);
            assert.equal(out.scheme, "mcp");
            assert.equal(out.server, "mcp-files-exec");
            assert.equal(out.mcp_path, "output/unit.pdf");
            assert.equal(out.download_url, undefined);
        } finally {
            if (saved === undefined) delete TC.templateConfigs["本地文件路径"];
            else TC.templateConfigs["本地文件路径"] = saved;
            resetResourceConfigCacheForTest();
            resetImageConfigCacheForTest();
            resetConfigCache();
        }
    }
,

    /** get_resource_path：类型错误和未找到资源返回结构化错误 */
    async testGetResourcePathErrors(): Promise<void> {
        const saved = TC.templateConfigs["本地文件路径"];
        TC.templateConfigs["本地文件路径"] = ["unit_file=data/files/unit.pdf"];
        resetResourceConfigCacheForTest();
        resetImageConfigCacheForTest();
        resetConfigCache();
        registerResourceTools();
        try {
            const tool = toolMap["get_resource_path"];
            const invalidType = JSON.parse(await tool.solve(makeCtx(), {} as any, {} as any, { type: "foo", id: "unit_file" }));
            assert.equal(invalidType.ok, false);
            assert.equal(invalidType.error.code, "INVALID_PARAMS");
            const missing = JSON.parse(await tool.solve(makeCtx(), {} as any, {} as any, { type: "file", id: "missing" }));
            assert.equal(missing.ok, false);
            assert.equal(missing.error.code, "NOT_FOUND");
            assert.ok(String(missing.error.message).includes("missing"), "错误信息应包含缺失的资源 ID");
        } finally {
            if (saved === undefined) delete TC.templateConfigs["本地文件路径"];
            else TC.templateConfigs["本地文件路径"] = saved;
            resetResourceConfigCacheForTest();
            resetImageConfigCacheForTest();
            resetConfigCache();
        }
    }
,

    /** system prompt 消息标记段应引导：当前会话直接输出 [img:image-id] */
    testSystemPromptPrefersImgTagForSendingImages(): void {
        const rendered = markersSection(true);
        assert.ok(rendered.includes('[img:image-id]'), '应包含图片标签说明');
        assert.ok(rendered.includes('prefer writing'), '应包含优先使用图片标签的指令');
        assert.ok(rendered.includes('list_resources(type=image)'), '应包含先查询本地图片 ID 的说明');
    }
,

    /** list_resources 描述应指向新的图片发送优先规则与 get_resource_path */
    testResourceToolDescriptionsSynced(): void {
        registerResourceTools();
        const list = toolMap["list_resources"];
        assert.ok(list, "list_resources 应已注册");
        assert.ok(list.toolInfo.function.description.includes("[img:image ID]"), "list_resources 描述应提到优先使用 [img]");
        assert.ok(list.toolInfo.function.description.includes("get_resource_path"), "list_resources 描述应提到 get_resource_path");
        const pathTool = toolMap["get_resource_path"];
        assert.ok(pathTool, "get_resource_path 应已注册");
        assert.ok(pathTool.toolInfo.function.parameters.required.includes("type"), "get_resource_path 应要求 type");
        assert.ok(pathTool.toolInfo.function.parameters.required.includes("id"), "get_resource_path 应要求 id");
    }
,

    /** 新增 .ai kb / .ai skill / .ai mcp：完整注册命令表后应存在，并并入默认权限表 */
    testAiPlatformSubCommandsRegistered(): void {
        const beforeMap = { ...SubCmd.map };
        const beforeAiArgs = defaultCmdPriv.ai.args;
        try {
            registerSubCommands();
            assert.ok(SubCmd.map['kb'] && SubCmd.map['kb'].desc.includes('知识库'), '.ai kb 子命令应注册（知识库管理）');
            assert.ok(SubCmd.map['skill'] && SubCmd.map['skill'].desc.includes('技能'), '.ai skill 子命令应注册');
            assert.ok(SubCmd.map['mcp'] && SubCmd.map['mcp'].desc.includes('MCP'), '.ai mcp 子命令应注册');
            assert.ok(defaultCmdPriv.ai.args && defaultCmdPriv.ai.args['kb'] && defaultCmdPriv.ai.args['skill'] && defaultCmdPriv.ai.args['mcp'], '新子命令应并入 .ai 默认权限表');
            assert.ok(SubCmd.map['memory'], 'memory 子命令应保留');
            assert.ok(SubCmd.map['tool'], 'tool 子命令应保留');
        } finally {
            for (const key of Object.keys(SubCmd.map)) {
                if (!Object.prototype.hasOwnProperty.call(beforeMap, key)) delete SubCmd.map[key];
            }
            defaultCmdPriv.ai.args = beforeAiArgs;
        }
    }
,

    

    

    

    

    /** mergeMentalModels：固定在前、语义补余、limit 截断、同 id 去重 */
    testMergeMentalModelsFixedFirst(): void {
        const mk = (id: string) => makeTestMentalModel(id, id, 'a', [], 0);
        const fixed = [mk('f1'), mk('f2')];
        const ranked = [mk('f2'), mk('c1'), mk('c2')];
        assert.deepEqual(mergeMentalModels(fixed, ranked, 3).map(m => m.id), ['f1', 'f2', 'c1'], '固定优先且去重');
        assert.deepEqual(mergeMentalModels(fixed, ranked, 2).map(m => m.id), ['f1', 'f2'], 'limit 应截断');
        assert.deepEqual(mergeMentalModels([], ranked, 10).map(m => m.id), ['f2', 'c1', 'c2'], '无固定时全量语义补余');
    }
,

    

    

    

    

    

    /** 模型报错分类：跨厂商真实/典型报文 → 语义类别（含各陷阱：阿里 insufficient_quota 是限流非欠费等） */
    testClassifyApiErrorKinds(): void {
        const c = (provider: string, status: number, raw: string) => classifyApiError(provider, status, raw);
        // OpenAI 系
        assert.equal(c('openai', 429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'), 'balance');
        assert.equal(c('openai', 429, '{"error":{"message":"Insufficient credits","type":"insufficient_quota","code":"credit_balance_exhausted"}}'), 'balance');
        assert.equal(c('', 429, '{"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}'), 'rate_limit');
        assert.equal(c('openai', 400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, you requested 130000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}'), 'context_too_long');
        assert.equal(c('openai', 401, '{"error":{"message":"Incorrect API key provided: sk-xxx.","type":"invalid_request_error","code":"invalid_api_key"}}'), 'auth');
        assert.equal(c('', 403, '{"error":{"message":"You do not have permission","type":"permission_error"}}'), 'permission');
        assert.equal(c('openai', 400, '{"error":{"message":"The response was filtered due to the prompt triggering Azure OpenAI\'s content management policy.","code":"content_filter","type":"content_filter"}}'), 'content_filter');
        assert.equal(c('openai', 404, '{"error":{"message":"The model `gpt-7` does not exist","code":"model_not_found"}}'), 'model_not_found');
        assert.equal(c('openai', 422, '{"error":{"message":"Range of max_tokens should be [1, 65536]","type":"invalid_request_error"}}'), 'invalid_request');
        assert.equal(c('openai', 500, '{"error":{"message":"The server had an error","type":"server_error"}}'), 'server');
        // DeepSeek：402=欠费；401 的 code 不可信（是 invalid_request_error）但仍应归 auth
        assert.equal(c('deepseek', 402, '{"error":{"message":"Insufficient Balance","type":"insufficient_quota"}}'), 'balance');
        assert.equal(c('deepseek', 401, '{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error","code":"invalid_request_error"}}'), 'auth');
        // Kimi/Moonshot：429 三态细分
        assert.equal(c('moonshot', 429, '{"error":{"type":"exceeded_current_quota_error","message":"账户欠费或已停用。检查余额与账单。"}}'), 'balance');
        assert.equal(c('moonshot', 429, '{"error":{"type":"rate_limit_reached_error","message":"Your account reached TPM rate limit"}}'), 'rate_limit');
        assert.equal(c('moonshot', 429, '{"error":{"type":"engine_overloaded_error","message":"The engine is currently overloaded, please try again later"}}'), 'overloaded');
        assert.equal(c('moonshot', 400, '{"error":{"type":"invalid_request_error","message":"Input token length too long"}}'), 'context_too_long');
        assert.equal(c('moonshot', 401, '{"error":{"type":"invalid_authentication_error","message":"Invalid Authentication"}}'), 'auth');
        // Anthropic：原生 messages 协议
        assert.equal(c('anthropic', 403, '{"type":"error","error":{"type":"billing_error","message":"Your account has insufficient credits"}}'), 'balance');
        assert.equal(c('anthropic', 529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 'overloaded');
        assert.equal(c('anthropic', 400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 400 tokens > 200000 maximum"}}'), 'context_too_long');
        assert.equal(c('anthropic', 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'auth');
        // 智谱：code 是字符串
        assert.equal(c('zhipu', 429, '{"error":{"code":"1113","message":"您的账户已欠费，请充值后重试"}}'), 'balance');
        assert.equal(c('zhipu', 400, '{"error":{"code":"1261","message":"Prompt 超长"}}'), 'context_too_long');
        assert.equal(c('zhipu', 400, '{"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}}'), 'content_filter');
        assert.equal(c('zhipu', 429, '{"error":{"code":"1302","message":"您的账户已达到速率限制"}}'), 'rate_limit');
        assert.equal(c('zhipu', 429, '{"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}'), 'overloaded');
        // 阿里百炼：欠费 400 Arrearage；⚠ insufficient_quota 别名是 TPM 限流不是余额不足
        assert.equal(c('alibaba', 400, '{"error":{"message":"Access denied, please make sure your account is in good standing.","code":"Arrearage","type":"Arrearage"}}'), 'balance');
        assert.equal(c('alibaba', 400, '{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}'), 'balance');
        assert.equal(c('alibaba', 429, '{"error":{"message":"Allocated quota exceeded, please increase your quota limit.","code":"Throttling.AllocationQuota"}}'), 'rate_limit');
        assert.equal(c('alibaba', 429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}'), 'rate_limit', '阿里 insufficient_quota 别名应判限流而非欠费');
        assert.equal(c('alibaba', 403, '{"error":{"message":"Access denied.","code":"AccessDenied"}}'), 'permission');
        assert.equal(c('alibaba', 400, '{"error":{"message":"Input or output data may contain inappropriate content.","code":"DataInspectionFailed"}}'), 'content_filter');
        assert.equal(c('alibaba', 404, '{"error":{"message":"The model qwen-xxx does not exist.","code":"model_not_found"}}'), 'model_not_found');
        assert.equal(c('alibaba', 400, '{"error":{"message":"Range of input length should be [1, 64000]","code":"InvalidParameter"}}'), 'context_too_long');
        // SiliconFlow：顶层数字 code（无码表，靠 status/message）
        assert.equal(c('siliconflow', 401, '{"code":30014,"message":"Token is invalid.","data":null}'), 'auth');
        assert.equal(c('siliconflow', 402, '{"code":20002,"message":"账户欠费，请充值后重试","data":null}'), 'balance');
        assert.equal(c('siliconflow', 400, '{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}'), 'model_not_found');
        // Google（原生或 OpenAI 兼容端点都可能出现）
        assert.equal(c('google', 400, '{"error":{"code":400,"message":"The input token count (202188) exceeds the maximum number of tokens allowed (131072).","status":"INVALID_ARGUMENT"}}'), 'context_too_long');
        assert.equal(c('google', 429, '{"error":{"code":429,"message":"Quota exceeded for quota metric","status":"RESOURCE_EXHAUSTED"}}'), 'rate_limit');
        assert.equal(c('google', 403, '{"error":{"code":403,"message":"Permission denied","status":"PERMISSION_DENIED"}}'), 'permission');
        // 其它：纯 message 中文兜底 / 未知 / 成功态带错误对象
        assert.equal(c('', 400, '{"error":{"message":"输入内容超出模型限制，请精简后重试"}}'), 'context_too_long');
        assert.equal(c('', 200, '{"error":{"message":"some gateway error","code":"X"}}'), 'unknown');
        assert.equal(c('', 0, 'fetch failed'), 'unknown');
    }
,

    /** 超长报文的模型窗口 N 解析 + 归档目标预算计算 */
    testParseMaxContextTokensAndArchiveTarget(): void {
        assert.equal(parseMaxContextTokens('This model\'s maximum context length is 128,000 tokens. However, you requested 130000 tokens. Please reduce the length of the messages before retrying.'), 128000);
        assert.equal(parseMaxContextTokens('The input token count (202188) exceeds the maximum number of tokens allowed (131072).'), 131072);
        assert.equal(parseMaxContextTokens('prompt is too long: 402 tokens > 200000 maximum'), 200000);
        assert.equal(parseMaxContextTokens('Range of input length should be [1, 64000]'), 64000);
        assert.equal(parseMaxContextTokens('Total message token length exceed model limit (10000000 tokens).'), 10000000);
        assert.equal(parseMaxContextTokens('{"error":{"message":"Prompt 超长"}}'), undefined, '无数字上限应返回 undefined');
        assert.equal(parseMaxContextTokens(''), undefined);

        // 报文窗口 < 本地预算 → min(N, budget)×0.8
        assert.equal(computeArchiveTarget(1000000, 'maximum context length is 128000 tokens'), Math.floor(128000 * 0.8));
        // 本地预算更小 → min 取本地
        assert.equal(computeArchiveTarget(20000, 'exceeds the maximum number of tokens allowed (131072)'), Math.floor(20000 * 0.8));
        // 无 N 但本地预算存在 → 按本地预算×0.8（超长归档仍可按配置预算收敛）
        assert.equal(computeArchiveTarget(1000000, '{"error":{"message":"Prompt 超长"}}'), Math.floor(1000000 * 0.8));
        // 都没有 → undefined（调用方放弃自动动作）
        assert.equal(computeArchiveTarget(0, ''), undefined);
        assert.equal(computeArchiveTarget(0, 'maximum context length is 128000 tokens'), Math.floor(128000 * 0.8));
    }
,

    /** 备用模型选择（v4）：跨厂商优先 / 连接顺序 / 无候选 */
    testPickFallbackModelStrategy(): void {
        const agent: any = Object.create(Agent.prototype);
        try {
            // 跨厂商优先：候选 model-a/deepseek、model-b/openai、model-c/anthropic、model-e/deepseek，
            // 当前 a → 第一个不同厂商 = b（跳过同厂商 e）；order 策略取候选顺序第一个不同模型 = b
            seedPinnedConns([
                pinConn('deepseek', ['model-a']),
                pinConn('openai', ['model-b']),
                pinConn('anthropic', ['model-c']),
                pinConn('deepseek', ['model-e']),
            ]);
            Model.purposeModelOverrides.chat = 'model-a';
            assert.equal(agent.pickFallbackModel(Model.getChatModel('chat'), 'cross').ref, 'model-b');
            assert.equal(agent.pickFallbackModel(Model.getChatModel('chat'), 'order').ref, 'model-b');

            // 无跨厂商候选时 cross 回退连接顺序第一个不同模型
            seedPinnedConns([pinConn('deepseek', ['model-a', 'model-e'])]);
            Model.purposeModelOverrides.chat = 'model-a';
            assert.equal(agent.pickFallbackModel(Model.getChatModel('chat'), 'cross').ref, 'model-e');

            // 候选里只剩自己（无其它可用）→ null
            seedPinnedConns([pinConn('deepseek', ['model-a'])]);
            assert.equal(agent.pickFallbackModel(Model.getChatModel('chat'), 'cross'), null);
        } finally {
            Model.reset();
        }
    }
,

    

    /** handleModelError 动作三：余额不足 → 自动切 chat 备用模型 + ctx.notice，同 run 只切一次 */
    async testHandleModelErrorAutoSwitch(): Promise<void> {
        const savedOv = Model.purposeModelOverrides;
        try {
            seedPinnedConns([pinConn('deepseek', ['model-a']), pinConn('openai', ['model-b'])]);
            Model.purposeModelOverrides.chat = 'model-a';

            const agent: any = Object.create(Agent.prototype);
            const notices: string[] = [];
            const ctx: any = { notice: (t: string) => notices.push(t) };
            const session: any = { context: { archiveByTokenIfNeeded: async () => 'converged' } };
            const err = ApiError.fromResponse(429, 'deepseek', '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}');

            const handled = { archived: false, switched: false };
            assert.equal(err.kind, 'balance');
            const action = await agent.handleModelError(ctx, session, err, handled);
            assert.equal(action, 'retry');
            assert.equal(Model.purposeModelOverrides.chat, 'model-b', '应把 chat 覆盖切到备用模型并持久化');
            assert.equal(notices.length, 1);
            assert.ok(notices[0].includes('已自动切换为 model-b'), '应通过 ctx.notice 通知');
            assert.equal(handled.switched, true);

            // 同一 run 再次失败：不再切换，返回 giveup
            const action2 = await agent.handleModelError(ctx, session, err, handled);
            assert.equal(action2, 'giveup');
            assert.equal(notices.length, 1, '不应重复通知');
        } finally {
            Model.purposeModelOverrides = savedOv;
            Model.reset();
        }
    }
,

    /** handleModelError 动作二：模型无法下载上下文图片（QQ 直链过期）→ 标记这些图片不可用并降级重发一次 */
    async testHandleModelErrorImageDegrade(): Promise<void> {
        const agent: any = Object.create(Agent.prototype);
        const ctx: any = { notice: () => undefined };
        const session: any = { context: {} };
        const url = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=d&spec=0&rkey=d';
        // 线上原文：模型侧下载图片失败 → 整轮 400 invalid_request
        const err = ApiError.fromResponse(400, 'deepseek', `{"error":{"message":".messages[28].image[0]: Failed to download image from ${url}","type":"invalid_request_error"}}`);
        const img = new Image();
        img.imageId = 'img_err_deg';
        img.url = url;
        (Image as any).imageMap['img_err_deg'] = img;
        const origSet = (ext as any).storageSet;
        (ext as any).storageSet = () => undefined;
        try {
            assert.equal(err.kind, 'invalid_request');
            const handled = { archived: false, switched: false, imageDegraded: false };
            const action = await agent.handleModelError(ctx, session, err, handled, [url]);
            assert.equal(action, 'retry', '应降级图片后重发一次');
            assert.equal(handled.imageDegraded, true);
            assert.equal(img.urlBroken, true, '该 URL 对应的图片应被标记为不可用');
            assert.equal(img.isUrlUnusable(), true, '后续组包应只留文本标签');
            // 同 run 再次同样报错：不再降级，giveup（不会死循环）
            const action2 = await agent.handleModelError(ctx, session, err, handled, [url]);
            assert.equal(action2, 'giveup');
            // 请求里没有可降级的图片 URL 时不做无意义重发
            const handled2 = { archived: false, switched: false, imageDegraded: false };
            const action3 = await agent.handleModelError(ctx, session, err, handled2, []);
            assert.equal(action3, 'giveup');
            assert.equal(handled2.imageDegraded, false, '未实际降级时不应置限流标记');
            // 普通参数错误不应走图片降级
            const handled3 = { archived: false, switched: false, imageDegraded: false };
            const err2 = ApiError.fromResponse(400, 'openai', '{"error":{"message":"invalid max_tokens","type":"invalid_request_error"}}');
            assert.equal(await agent.handleModelError(ctx, session, err2, handled3, [url]), 'giveup');
            assert.equal(handled3.imageDegraded, false);
            // 报错自动处理总开关关闭时不降级（与归档/切模型动作一致）
            const origEnabled = TC.boolConfigs['启用报错自动处理'];
            TC.boolConfigs['启用报错自动处理'] = false;
            resetConfigCache();
            try {
                const handled4 = { archived: false, switched: false, imageDegraded: false };
                assert.equal(await agent.handleModelError(ctx, session, err, handled4, [url]), 'giveup');
                assert.equal(handled4.imageDegraded, false, '总开关关闭时不应自动降级');
            } finally {
                if (origEnabled === undefined) delete TC.boolConfigs['启用报错自动处理'];
                else TC.boolConfigs['启用报错自动处理'] = origEnabled;
                resetConfigCache();
            }
        } finally {
            delete (Image as any).imageMap['img_err_deg'];
            (ext as any).storageSet = origSet;
        }
    }
,

    /** handleModelError 动作一：上下文超长 → 按 min(本地预算, 报文窗口)×0.8 归档后重发；开关关闭时给 giveup */
    async testHandleModelErrorContextArchive(): Promise<void> {
        const agent: any = Object.create(Agent.prototype);
        const ctx: any = { notice: () => undefined };
        const targets: number[] = [];
        const session: any = { context: { archiveByTokenIfNeeded: async (t: number) => { targets.push(t); return 'converged'; } } };
        const raw = '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, you requested 130000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}';
        const err = ApiError.fromResponse(400, 'openai', raw);

        // 配置：上下文归档重试开（默认 true），本地预算经 TC 配置为 1000000 → target = min(1e6, 128000)*0.8
        const origEnabled = TC.boolConfigs['启用报错自动处理'];
        const origArchive = TC.boolConfigs['上下文超长自动归档重试'];
        const origTokens = TC.intConfigs['上下文预算'];
        TC.boolConfigs['启用报错自动处理'] = true;
        TC.boolConfigs['上下文超长自动归档重试'] = true;
        TC.intConfigs['上下文预算'] = 1000000;
        resetConfigCache();
        try {
            assert.equal(err.kind, 'context_too_long');
            const handled = { archived: false, switched: false };
            const action = await agent.handleModelError(ctx, session, err, handled);
            assert.equal(action, 'retry');
            assert.deepEqual(targets, [Math.floor(128000 * 0.8)], '归档目标应为 min(本地预算, 报文窗口)×0.8');
            assert.equal(handled.archived, true);

            // 同 run 再次超长：不再归档，giveup
            const action2 = await agent.handleModelError(ctx, session, err, handled);
            assert.equal(action2, 'giveup');
            assert.equal(targets.length, 1);

            // 开关关闭 → giveup 且不触发归档
            TC.boolConfigs['上下文超长自动归档重试'] = false;
            resetConfigCache();
            const handled2 = { archived: false, switched: false };
            const action3 = await agent.handleModelError(ctx, session, err, handled2);
            assert.equal(action3, 'giveup');
            assert.equal(targets.length, 1, '开关关闭时不应归档');

            // 归档未收敛（返回 false，例如被并发锁挡下或 summarize 失败）→ 不重发、不标记已处理（修 M8）
            TC.boolConfigs['上下文超长自动归档重试'] = true;
            resetConfigCache();
            const targets2: number[] = [];
            const session2: any = { context: { archiveByTokenIfNeeded: async (t: number) => { targets2.push(t); return 'failed'; } } };
            const handled3 = { archived: false, switched: false };
            const action4 = await agent.handleModelError(ctx, session2, err, handled3);
            assert.equal(action4, 'giveup', '归档未完成时不应重发');
            assert.equal(handled3.archived, false, '未收敛时不得标记 archived（否则后续重试直接放弃）');
            assert.equal(targets2.length, 1);

            // 归档在飞（busy）→ 允许重发一次（重试会用归档后的上下文重建请求），不再误判为失败
            const session3: any = { context: { archiveByTokenIfNeeded: async () => 'busy' } };
            const handled4 = { archived: false, switched: false };
            assert.equal(await agent.handleModelError(ctx, session3, err, handled4), 'retry', 'busy 应允许重发一次');
            assert.equal(handled4.archived, true);
        } finally {
            if (origEnabled === undefined) delete TC.boolConfigs['启用报错自动处理']; else TC.boolConfigs['启用报错自动处理'] = origEnabled;
            if (origArchive === undefined) delete TC.boolConfigs['上下文超长自动归档重试']; else TC.boolConfigs['上下文超长自动归档重试'] = origArchive;
            if (origTokens === undefined) delete TC.intConfigs['上下文预算']; else TC.intConfigs['上下文预算'] = origTokens;
            resetConfigCache();
        }
    }
,

    /**
     * handleModelError 动作一（v2 快速路径）：事件账本存在时 context_too_long **只收紧本轮请求预算**后重发，
     * 不做摘要/不走旧归档（0 次 LLM）；同一 run 第二次同错误 giveup，不重复收紧。
     */
    async testHandleModelErrorContextTooLongV2FastPath(): Promise<void> {
        const agent: any = Object.create(Agent.prototype);
        const ctx: any = { notice: () => undefined };
        const caps: Array<number | null> = [];
        let archiveCalls = 0;
        let summaryCalls = 0;
        const contextV2: any = {
            head: () => { summaryCalls++; return { unsummarizedTokens: 0 }; },
            lastCompile: () => { summaryCalls++; return null; },
            compact: async () => { summaryCalls++; return { advanced: false }; },
            flush: async () => ({ ok: true }),
            resetLastCompile: () => undefined,
        };
        const session: any = {
            context: {
                setV2BudgetCap: (t: number | null) => { caps.push(t); },
                archiveByTokenIfNeeded: async () => { archiveCalls++; return 'converged'; },
            },
            contextV2,
        };
        const raw = '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, you requested 130000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}';
        const err = ApiError.fromResponse(400, 'openai', raw);

        const origEnabled = TC.boolConfigs['启用报错自动处理'];
        const origArchive = TC.boolConfigs['上下文超长自动归档重试'];
        const origTokens = TC.intConfigs['上下文预算'];
        TC.boolConfigs['启用报错自动处理'] = true;
        TC.boolConfigs['上下文超长自动归档重试'] = true;
        TC.intConfigs['上下文预算'] = 1000000;
        resetConfigCache();
        try {
            assert.equal(err.kind, 'context_too_long');
            const expected = Math.floor(128000 * 0.8);
            const handled = { archived: false, switched: false };
            const action = await agent.handleModelError(ctx, session, err, handled);
            assert.equal(action, 'retry', 'v2 路径应收紧预算后直接重发');
            assert.deepEqual(caps, [expected], '只调用 setV2BudgetCap(target)，目标=min(本地预算,报文窗口)×0.8');
            assert.equal(handled.archived, true);
            assert.equal(archiveCalls, 0, 'v2 路径不得走旧 archiveByTokenIfNeeded');
            assert.equal(summaryCalls, 0, 'v2 快速路径不得触发摘要（0 次 LLM / 不读 head/lastCompile/compact）');

            // 同 run 再次同错误：已 archived → giveup，不再收紧预算
            const action2 = await agent.handleModelError(ctx, session, err, handled);
            assert.equal(action2, 'giveup');
            assert.equal(caps.length, 1, '第二次不应重复收紧');

            // 开关关闭 → giveup 且不收紧预算
            TC.boolConfigs['上下文超长自动归档重试'] = false;
            resetConfigCache();
            const handled2 = { archived: false, switched: false };
            assert.equal(await agent.handleModelError(ctx, session, err, handled2), 'giveup');
            assert.equal(caps.length, 1, '开关关闭时不应收紧预算');
            assert.equal(handled2.archived, false);
        } finally {
            if (origEnabled === undefined) delete TC.boolConfigs['启用报错自动处理']; else TC.boolConfigs['启用报错自动处理'] = origEnabled;
            if (origArchive === undefined) delete TC.boolConfigs['上下文超长自动归档重试']; else TC.boolConfigs['上下文超长自动归档重试'] = origArchive;
            if (origTokens === undefined) delete TC.intConfigs['上下文预算']; else TC.intConfigs['上下文预算'] = origTokens;
            resetConfigCache();
        }
    }
,

    /** 模型规则用途组模板：body 模板命中合并、重叠行后覆盖先；request 覆盖可取回 */
    testModelRuleTemplateAndRequestOverrides(): void {
        try {
            // 单行模板：chat/summarization 命中 body 覆盖，judge 未命中走代码兜底
            seedPinnedConns([pinConn('deepseek', ['text-a'])], [{
                use: ['chat', 'summarization'],
                body: { max_tokens: 4096, temperature: 0.7 },
                request: { auth_header_name: 'x-custom', headers: { 'X-Tag': 'v1' }, timeout: 5 },
            }]);
            assert.equal(Model.getBodyDefaultsFor('chat').max_tokens, 4096, '规则 body 应覆盖代码兜底');
            assert.equal(Model.getBodyDefaultsFor('chat').temperature, 0.7);
            assert.equal(Model.getBodyDefaultsFor('summarization').max_tokens, 4096);
            assert.equal(Model.getBodyDefaultsFor('judge').max_tokens, 65536, '未命中规则走对话代码兜底');
            const ov = Model.requestOverridesFor('chat');
            assert.equal(ov?.auth_header_name, 'x-custom');
            assert.equal(ov?.headers['X-Tag'], 'v1');
            assert.equal(ov?.timeout, 5);
            assert.equal(Model.requestOverridesFor('judge'), null, '未命中规则无 request 覆盖');

            // 重叠规则按框顺序逐键合并、后面的框覆盖前面的
            seedPinnedConns([pinConn('deepseek', ['text-a'])], [
                { use: ['chat'], body: { max_tokens: 1000, temperature: 0.1 }, request: {} },
                { use: ['chat'], body: { max_tokens: 2000 }, request: {} },
            ]);
            assert.equal(Model.getBodyDefaultsFor('chat').max_tokens, 2000, '后写覆盖先写');
            assert.equal(Model.getBodyDefaultsFor('chat').temperature, 0.1, '未被覆盖的键保留先写值');

            // 嵌入维度读取规则模板 body.dimensions
            seedPinnedConns([pinConn('openai', ['text-embedding-3-small'])], [{
                use: ['text-embedding'],
                body: { dimensions: 1536 },
                request: {},
            }]);
            assert.equal(Model.getEmbeddingDimension(), 1536, '维度应取 text-embedding 规则模板');
            // 未配置 → 代码兜底 1024
            seedPinnedConns([pinConn('openai', ['text-embedding-3-small'])], []);
            assert.equal(Model.getEmbeddingDimension(), 1024);
        } finally {
            Model.reset();
        }
    }
,

    /** 自动拉取：失败按连接降级（error、不进注册表、不抛）；模型只存内存、不持久化（无缓存回退）；pull 可重试 */
    async testModelListAutoLoadMemoryOnly(): Promise<void> {
        try {
            // 1) 拉取失败 → 该连接 error，注册表为空，ensureLoaded 不抛
            Model.reset();
            Model.bootstrap([{ provider: 'openai', apiKey: 'k', baseUrl: 'https://o', ignore: false, models: null, request: {} }], [], {
                fetch: async () => { throw new Error('boom'); },
            });
            await Model.ensureLoaded();
            assert.equal(Model.states[0].status, 'error', '拉取失败应降级为 error');
            assert.equal(Model.states[0].modelNames.length, 0);
            assert.equal(Model.entries.length, 0, '失败时不应有模型');

            // 2) 失败后 .ai model pull 重试成功 → auto 来源、内存更新（不依赖任何持久化）
            Model.reset();
            let fail = true;
            Model.bootstrap([{ provider: 'openai', apiKey: 'k', baseUrl: 'https://o', ignore: false, models: null, request: {} }], [], {
                fetch: async (ctx: any) => {
                    if (fail) throw new Error('boom');
                    assert.equal(ctx.baseUrl, 'https://o');
                    assert.equal(ctx.apiKey, 'k');
                    return ['m1', 'text-embedding-3-small'];
                },
            });
            await Model.ensureLoaded();
            assert.equal(Model.states[0].status, 'error');
            fail = false;
            await Model.pull();
            assert.equal(Model.states[0].status, 'ok');
            assert.equal(Model.states[0].source, 'auto');
            assert.deepEqual(Model.states[0].modelNames, ['m1', 'text-embedding-3-small']);
            assert.ok(Model.entries.some(e => e.tags.includes('embed')), '拉取模型应完成分类');

            // 3) pinned 钉住清单不受网络影响（只存内存的例外：来自配置本身）
            Model.reset();
            Model.bootstrap([{ provider: 'deepseek', apiKey: 'k', baseUrl: 'https://d', ignore: false, models: ['deepseek-v4-flash'], request: {} }], [], {
                fetch: async () => { throw new Error('不应拉取 pinned 连接'); },
            });
            assert.equal(Model.states[0].status, 'ok');
            assert.equal(Model.states[0].source, 'pinned');
            assert.equal(Model.entries[0].name, 'deepseek-v4-flash');
        } finally {
            Model.reset();
        }
    }
,

    /**
     * v5：baseURL 必填（不再兜默认），vendor 由 URL 反查；未收录的地址 vendor 为空。
     * v4 这个位置测的是"省略 provider 取默认地址"和"两者都缺则跳过"——v5 两处语义都变了。
     */
    testV5BaseUrlRequiredAndVendorDerived(): void {
        try {
            const cfg = seedFromV5Config({
                version: 5,
                providers: [
                    // 未收录的网关 → vendor 为空（按 OpenAI 兼容处理）
                    v5Conn({ baseURL: 'https://my-gateway/v1', models: [v5Model('gw', 'gw-model')] }),
                    // 已收录 → vendor 由 URL 反查
                    v5Conn({ baseURL: 'https://api.deepseek.com/v1', models: [v5Model('flash', 'deepseek-v4-flash')] }),
                ],
            });
            assert.equal(cfg.conns.length, 2);
            assert.equal(cfg.conns[0].provider, '', '未收录地址的 vendor 应为空');
            assert.equal(cfg.conns[0].baseUrl, 'https://my-gateway/v1');
            assert.equal(cfg.conns[1].provider, 'deepseek', 'vendor 应由 URL 反查得到');
            assert.equal(Model.states.length, 2);
            assert.equal(Model.states[0].status, 'ok');
            assert.equal(Model.states[0].source, 'pinned');

            // baseURL 缺失 → 整份配置被拒（v5 不再兜默认值）
            const bad = seedFromV5Config({
                version: 5,
                providers: [{ api: 'openai-completions', apiKey: 'k' }],
            });
            assert.ok(bad.issues.length > 0, '缺 baseURL 应报错');
            assert.equal(bad.conns.length, 0, '缺 baseURL 应整体拒绝');
        } finally {
            delete TC.stringConfigs['模型配置'];
            resetModelConfigCacheForTest();
            setModelListDepsForTest();
            resetConfigCache();
            Model.reset();
        }
    }
,

    /** .ai model pull：无视配置里的 models 钉住字段，一律向网络拉取并用结果覆盖 */
    async testModelPullIgnoresPinnedModels(): Promise<void> {
        try {
            let callCount = 0;
            Model.reset();
            Model.bootstrap([{ provider: 'deepseek', apiKey: 'k', baseUrl: 'https://d', ignore: false, models: ['pinned-model'], request: {} }], [], {
                fetch: async () => { callCount++; return ['fetched-x', 'fetched-y']; },
            });
            // 加载时 pinned 生效：不请求网络
            assert.equal(Model.states[0].status, 'ok');
            assert.equal(Model.states[0].source, 'pinned');
            assert.deepEqual(Model.states[0].modelNames, ['pinned-model']);
            assert.equal(callCount, 0, '加载时钉住清单不应触发拉取');

            // pull：无视 models 字段强制拉取并覆盖
            await Model.pull();
            assert.equal(callCount, 1, 'pull 应请求网络一次');
            assert.equal(Model.states[0].status, 'ok');
            assert.equal(Model.states[0].source, 'auto');
            assert.deepEqual(Model.states[0].modelNames, ['fetched-x', 'fetched-y'], 'pull 结果应覆盖钉住清单');

            // pull 再次执行也会重新拉取（不会因为已 ok 而跳过）
            await Model.pull();
            assert.equal(callCount, 2, '重复 pull 每次都会请求网络');
        } finally {
            Model.reset();
        }
    }
,

    /** 公开会话目录：CRUD / 浏览分级 / ID 前缀 / 净化 / 限频 */
    testPubRegistryCrudAndBrowse(): void {
        const origEndpoints = (globalThis as any).seal.getEndPoints;
        try {
            (globalThis as any).seal.getEndPoints = () => [
                { userId: 'QQ:10000', platform: 'QQ', state: 1, nickname: '骰娘A' },
                { userId: 'QQ:20000', platform: 'QQ', state: 0, nickname: '骰娘B' },
                { userId: 'DISCORD:30000', platform: 'DISCORD', state: 1, nickname: 'DiceD' },
            ];
            resetPubRegistryForTest();

            // upsert：新增 + 同 botId+sid 更新（不重复建条目）
            const a = upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1001', title: '跑团主群', addedBy: 'QQ:10000' });
            assert.equal(a.scope, 'group');
            assert.ok(a.id.startsWith('p'), '条目 id 应以 p 开头');
            const a2 = upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1001', title: '改名' });
            assert.equal(listEntries().length, 1, '同 botId+sid 更新不应新增条目');
            assert.equal(listEntries()[0].title, '改名');

            const b = upsertEntry({ platform: 'QQ', botId: 'QQ:20000', sid: 'QQ-Group:2002', title: 'B群' });
            const c = upsertEntry({ platform: 'DISCORD', botId: 'DISCORD:30000', sid: 'DISCORD-Group:g1/c1', title: 'DC频道' });
            const d = upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ:9999', title: '私聊', scope: 'private' });
            assert.equal(listEntries().length, 4);

            // 浏览分级
            const groups = listGroups();
            const qq = groups.find(g => g.platform === 'QQ');
            assert.ok(qq, '目录应含 QQ 平台');
            assert.equal(qq!.bots.length, 2, 'QQ 平台应有 2 个 bot');
            assert.equal(qq!.bots.find(x => x.botId === 'QQ:10000')!.count, 2);
            assert.equal(qq!.bots.find(x => x.botId === 'QQ:10000')!.online, true);
            assert.equal(qq!.bots.find(x => x.botId === 'QQ:20000')!.online, false, '离线端点应标注');
            const botEntries = listBotEntries('QQ:10000');
            assert.equal(botEntries.length, 2, 'bot 下应含群与私聊两条（无权限过滤）');

            // ID 前缀唯一命中（用完整 id 与接近完整的唯一前缀）
            assert.equal(resolveEntryByPrefix(a.id).match!.id, a.id);
            assert.equal(resolveEntryByPrefix(a.id.slice(0, a.id.length - 1)).match!.id, a.id, '唯一前缀应命中');
            const e2 = upsertEntry({ platform: 'QQ', botId: 'QQ:30000', sid: 'QQ-Group:1999', title: 'E2' });
            void e2;
            // 造两个同前缀 id 验证歧义
            resetPubRegistryForTest([
                { id: 'pxxxxx1', platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:3001', scope: 'group', title: 't1' } as any,
                { id: 'pxxxxx2', platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:3002', scope: 'group', title: 't2' } as any,
            ]);
            assert.equal(resolveEntryByPrefix('px').ambiguous, true, '同前缀多条应歧义');
            assert.equal(resolveEntryByPrefix('pxxxxx1').match!.title, 't1');
            resetPubRegistryForTest();
            // 重新种回 CRUD 数据继续
            const a1 = upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1001', title: '跑团主群', addedBy: 'QQ:10000' });
            const b1 = upsertEntry({ platform: 'QQ', botId: 'QQ:20000', sid: 'QQ-Group:2002', title: 'B群' });
            upsertEntry({ platform: 'DISCORD', botId: 'DISCORD:30000', sid: 'DISCORD-Group:g1/c1', title: 'DC频道' });
            upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ:9999', title: '私聊', scope: 'private' });

            // 会话寻址：条目ID / botId/sid 路径（不必在目录中）
            const byAddr = resolveSessionAddress(`${b1.botId}/${b1.sid}`);
            assert.equal(byAddr.match!.botId, b1.botId);
            assert.equal(byAddr.match!.sid, b1.sid);
            assert.equal(byAddr.match!.title, 'B群', '目录中会话的路径解析应回填标题');
            const byId = resolveSessionAddress(b1.id);
            assert.equal(byId.match!.entry!.id, b1.id, '条目ID应命中目录条目');
            // 不在目录的路径也解析成功（entry=null），且可在给出准确路径时读/发
            const outside = resolveSessionAddress('QQ:00000/QQ-Group:none');
            assert.ok(outside.match, '不在目录的路径也应解析成功');
            assert.equal(outside.match!.entry, null, '路径不在目录时 entry 应为 null');
            assert.equal(outside.match!.scope, 'group');

            // 删除
            assert.equal(removeEntry(a1.id), true);
            assert.equal(getEntryById(a1.id), null);

            // purge：指向离线端点的条目被清掉（离线端点 QQ:20000 一条，其余保留）
            const before = listEntries().length;
            const { removed } = purgeOffline();
            assert.equal(removed, 1, 'QQ:20000 离线应被清理 1 条');
            assert.equal(listEntries().length, before - 1);

            // 净化与平台判定
            assert.equal(isQQLikePlatform('QQ'), true);
            assert.equal(isQQLikePlatform('OpenQQ'), true);
            assert.equal(isQQLikePlatform('DISCORD'), false);
            assert.equal(stripCQCode('hi[CQ:at,qq=1]bye'), 'hibye');
        } finally {
            (globalThis as any).seal.getEndPoints = origEndpoints;
            resetPubRegistryForTest();
        }
    }
,

    /** pub_send 外发限频 */
    testPubSendRateLimit(): void {
        resetSendHistoryForTest();
        try {
            assert.deepEqual(allowSendNow('QQ:10000', 0), { ok: true, waitSec: 0 }, '间隔 0 应不限频');
            recordSend('QQ:10000');
            const r = allowSendNow('QQ:10000', 60);
            assert.equal(r.ok, false, '60 秒内应限频');
            assert.ok(r.waitSec > 0 && r.waitSec <= 60, '应给出剩余等待秒数');
            // 其他来源不受影响
            assert.deepEqual(allowSendNow('QQ:20000', 60), { ok: true, waitSec: 0 }, '不同来源会话互不影响');
            // 重置后放行
            resetSendHistoryForTest();
            assert.deepEqual(allowSendNow('QQ:10000', 60), { ok: true, waitSec: 0 }, '重置后应放行');
        } finally {
            resetSendHistoryForTest();
        }
    }
,

    /** 公开会话快照渲染：保留 msg_id/from/img，跳过 system/工具，token 预算从最新往前取 */
    testPubSnapshotRenderer(): void {
        const msgs: any[] = [
            {
                role: 'user', contentItems: [
                    { userId: 'QQ:10001', messageId: 'aaa', time: 0, text: '晚上好 [img:pic1]' },
                    { systemName: '测试事件', time: 0, text: 'xxx进群' },
                    { userId: 'QQ:10002', messageId: 'bbb', time: 0, text: '第二条' },
                ]
            },
            { role: 'assistant', contentItems: [{ messageId: 'ccc', time: 0, text: '你好呀' }] },
            { role: 'tool', text: '工具返回', toolCallId: 't1' },
            { role: 'assistant', toolCalls: [{ id: 't2' }], contentItems: [] },
            {
                role: 'user', contentItems: [
                    { userId: 'QQ:10003', messageId: 'ddd', time: 0, text: '再来一轮' },
                ]
            },
            { role: 'assistant', contentItems: [{ messageId: 'eee', time: 0, text: '好嘞' }] },
            {
                role: 'user', contentItems: [
                    { userId: 'QQ:10004', messageId: 'fff', time: 0, text: '长消息：' + '长'.repeat(600) },
                ]
            },
        ];
        const resolve = (uid: string) => (uid === 'QQ:10001' ? '小明' : '');
        const out = renderPubSnapshot(msgs, { tokens: 8000 }, resolve);
        assert.ok(out, '快照应有内容');
        assert.ok(out!.includes('[msg_id:aaa]'), '应保留 msg_id');
        assert.ok(out!.includes('[from:小明(10001)]'), '应渲染 from 名字(QQ号)');
        assert.ok(out!.includes('[img:pic1]'), '应保留图片标签');
        assert.ok(out!.includes('第二条'), '多用户条目都应包含');
        assert.ok(out!.includes('Bot reply: 你好呀'), '助手消息应带 Bot reply 前缀');
        assert.ok(!out!.includes('[system:'), '不应出现系统条目');
        assert.ok(!out!.includes('xxx进群'), '系统名义条目内容不应出现');
        assert.ok(!out!.includes('工具返回'), '工具返回不应出现');

        // token 预算从最新往前取：tokens=20 装不下最新块 → 最新块必留、更旧消息不选
        const one = renderPubSnapshot(msgs, { tokens: 20 }, resolve);
        assert.ok(one!.includes('长消息'), '最新消息应包含');
        assert.ok(!one!.includes('晚上好'), '旧消息不应包含');

        // 最新块自身超预算：按 token 截断并给标记（不再有 500 字下限）
        const tiny = renderPubSnapshot(msgs, { tokens: 200 }, resolve);
        assert.ok(tiny!.includes('[snapshot truncated: exceeded 200 tokens'), `超长应截断并注明: ${tiny!.slice(-120)}`);
        assert.ok(!tiny!.includes('晚上好'), '截断后不应回退去展示更旧消息');

        // tokens=0：不返回内容（0 = 不读取，不是「无限」）
        assert.equal(renderPubSnapshot(msgs, { tokens: 0 }, resolve), null);

        // 旧参数 rounds/chars 兼容一版：接受但忽略，结果与缺省一致（不报错）
        const legacy = renderPubSnapshot(msgs, { rounds: 6, chars: 8000 } as any, resolve);
        const defaults = renderPubSnapshot(msgs, {}, resolve);
        assert.equal(legacy, defaults, '旧参数 rounds/chars 应被忽略（仅兼容一版）');
    }
,

    /** .ai pub 子命令：list / add（本会话）/ rm（无参=本会话，带过滤=按平台/bot/会话删） */
    async testCmdPubSubcommand(): Promise<void> {
        const origReply = (globalThis as any).seal.replyToSender;
        const orig = SubCmd.map['pub'];
        const origEndpoints = (globalThis as any).seal.getEndPoints;
        let replied = '';
        (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { replied = text; };
        (globalThis as any).seal.getEndPoints = () => [
            { userId: 'QQ:10000', platform: 'QQ', state: 1, nickname: '骰娘A' },
            { userId: 'QQ:20000', platform: 'QQ', state: 1, nickname: '骰娘B' },
            { userId: 'DISCORD:30000', platform: 'DISCORD', state: 1, nickname: 'DiceD' },
        ];
        try {
            registerCmdPub();
            const makeScc = (args: string[], ctxOverride?: any) => {
                const ctx = {
                    endPoint: { userId: 'QQ:10000', platform: 'QQ' },
                    player: { userId: 'QQ:10000', name: '骰主' },
                    group: { groupId: 'QQ-Group:1001', groupName: '主群' },
                    isPrivate: false,
                    privilegeLevel: 100,
                    ...ctxOverride,
                };
                const sid = ctxOverride && ctxOverride.sidOverride !== undefined ? ctxOverride.sidOverride : 'QQ-Group:1001';
                return {
                    ctx, msg: {} as any, sid,
                    cmdArgs: {
                        getArgN: (n: number) => args[n - 1] ?? '',
                        getKwarg: (name: string) => {
                            const hit = args.find(a => a.startsWith(`--${name}=`));
                            if (hit) {
                                return { name, valueExists: true, value: hit.slice(`--${name}=`.length), asBool: true };
                            }
                            return null;
                        },
                        kwargs: [],
                    },
                    page: 1, ret: {} as any,
                } as any;
            };
            resetPubRegistryForTest();

            // add：公开当前会话（平台/Bot/会话/会话名），无 --title 等参数
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'add']));
            assert.ok(replied.includes('已公开当前会话'), 'add 应成功: ' + replied);
            assert.equal(listEntries().length, 1);
            const added = listEntries()[0];
            assert.equal(added.platform, 'QQ');
            assert.equal(added.botId, 'QQ:10000');
            assert.equal(added.sid, 'QQ-Group:1001');
            assert.equal(added.title, '主群', '会话名应自动取群名');
            assert.equal(Object.prototype.hasOwnProperty.call(added, 'allowRead'), false, '不应存在 allowRead 死状态');
            assert.equal(Object.prototype.hasOwnProperty.call(added, 'allowWrite'), false, '不应存在 allowWrite 死状态');
            assert.equal(Object.prototype.hasOwnProperty.call(added, 'echoToContext'), false, '不应存在 echoToContext 死状态');

            // 重复 add → 更新不重复
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'add']));
            assert.equal(listEntries().length, 1, '重复 add 不新增条目');

            // list：树状分段（平台头 + botid + 缩进会话）
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'list']));
            assert.ok(replied.includes('QQ：'), 'list 应含平台头: ' + replied);
            assert.ok(replied.includes('QQ:10000'), 'list 应含 botid: ' + replied);
            assert.ok(replied.includes('QQ-Group:1001'), 'list 应含会话: ' + replied);
            assert.ok(!replied.includes('主群'), 'list 不应含会话名: ' + replied);
            assert.ok(!replied.includes(' | '), 'list 不应使用 | 分隔: ' + replied);

            // rm 无参：移出当前会话
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm']));
            assert.equal(listEntries().length, 0, 'rm 无参应移出当前会话');
            assert.ok(replied.includes('已把当前会话移出目录'), replied);

            // rm 无参但不在目录 → 提示
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm']));
            assert.ok(replied.includes('未在目录中'), '不在目录应提示: ' + replied);

            // 预置多层条目，验证 rm 过滤删除
            upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1001', title: 'A群' });
            upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1002', title: 'B群' });
            upsertEntry({ platform: 'QQ', botId: 'QQ:20000', sid: 'QQ-Group:2001', title: 'C群' });
            upsertEntry({ platform: 'QQ', botId: 'QQ:20000', sid: 'QQ-Group:1001', title: 'D同群号' });
            upsertEntry({ platform: 'DISCORD', botId: 'DISCORD:30000', sid: 'DISCORD-Group:g1/c1', title: 'DC频道' });
            assert.equal(listEntries().length, 5);

            // 只写 --session：跨 bot 同名会话全删
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--session=QQ-Group:1001']));
            assert.equal(listEntries().length, 3, '同名会话 QQ-Group:1001 两条应全删');
            assert.ok(replied.includes('删除 2 条'), replied);

            // --botid 加 --platform 缩小：删 QQ 平台 QQ:10000 下剩余条目
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--platform=QQ', '--botid=QQ:10000']));
            assert.equal(listEntries().length, 2, '删后剩 QQ:20000 与 DISCORD 两条');
            assert.ok(replied.includes('删除 1 条'), replied);

            // 只写 --platform：删整个平台
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--platform=DISCORD']));
            assert.equal(listEntries().length, 1, '删后只剩 QQ:20000 条目');
            assert.ok(replied.includes('删除 1 条'), replied);

            // 无命中 → 提示
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--platform=Telegram']));
            assert.ok(replied.includes('没有命中条目'), '无命中应提示: ' + replied);

            // 非 UNI-ID 形态的裸 ID 也按原样匹配（不做格式假设）：无命中 → 提示而非拒绝
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--botid=10000']));
            assert.ok(replied.includes('没有命中条目'), '裸 botid 应按原样匹配而非拒绝: ' + replied);
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--session=123']));
            assert.ok(replied.includes('没有命中条目'), '裸 session 应按原样匹配而非拒绝: ' + replied);

            // 目录中存在非 UNI-ID 形态会话（如裸数字 sid）时可按其原样删除
            upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'raw123', title: '裸ID会话' });
            replied = '';
            await SubCmd.map['pub'].solve(makeScc(['pub', 'rm', '--session=raw123']));
            assert.ok(replied.includes('删除 1 条'), '裸 sid 应能按原样命中删除: ' + replied);
        } finally {
            (globalThis as any).seal.replyToSender = origReply;
            (globalThis as any).seal.getEndPoints = origEndpoints;
            if (orig) SubCmd.map['pub'] = orig; else delete SubCmd.map['pub'];
            resetPubRegistryForTest();
        }
    }
,

    /** pub_read 工具：概览 / bot 列表 / 快照 / 权限位 */
    async testPubReadTool(): Promise<void> {
        const origRead = toolMap['pub_read'];
        try {
            resetPubRegistryForTest();
            upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1001', title: '跑团主群' });
            const other = upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ-Group:1002', title: '另一群' });
            const priv = upsertEntry({ platform: 'QQ', botId: 'QQ:10000', sid: 'QQ:9999', title: '私聊', scope: 'private' });
            registerPubRead();
            const pubRead = toolMap['pub_read'];

            const makeCtx = (level = 100) => ({
                endPoint: { userId: 'QQ:10000', platform: 'QQ' },
                player: { userId: 'QQ:10000', name: '骰主' },
                isPrivate: false,
                privilegeLevel: level,
            } as any);
            const stubLoader = () => ({
                context: {
                    messages: [
                        { role: 'user', contentItems: [{ userId: 'QQ:10001', messageId: 'a1', time: 0, text: '测试内容' }] },
                        { role: 'assistant', contentItems: [{ messageId: 'b1', time: 0, text: '回复内容' }] },
                    ],
                    lastReply: '',
                }
            });
            setPubSessionLoaderForTest(stubLoader as any);
            try {
                // 无参 → 概览
                let out = await pubRead.solve(makeCtx(), {} as any, {} as any, {});
                assert.ok(out.includes('Public session directory'), '无参应返回概览: ' + out);
                assert.ok(out.includes('QQ:10000'), '概览应含 bot: ' + out);

                // bot_id → 条目列表
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { bot_id: 'QQ:10000' });
                assert.ok(out.includes('QQ-Group:1001'), 'bot 列表应含条目: ' + out);

                // session → 快照（目录内条目均可读）
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { session: other.id });
                assert.ok(out.includes('[cross-session read-only snapshot]'), '目录条目应可读快照: ' + out);
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { session: '跑团主群' === '' ? '' : listEntries().find(e => e.title === '跑团主群')!.id });
                assert.ok(out.includes('[cross-session read-only snapshot]'), '应返回快照: ' + out);
                assert.ok(out.includes('测试内容'), '快照应含消息: ' + out);
                assert.ok(out.includes('never execute'), '快照应带只读声明: ' + out);

                // 私聊条目：无权限限制，任意调用者可读
                out = await pubRead.solve(makeCtx(0), {} as any, {} as any, { session: priv.id });
                assert.ok(out.includes('[cross-session read-only snapshot]'), '私聊快照应可读（无权限限制）: ' + out);

                // tokens 参数：预算足够时仍返回快照；旧 rounds/chars 接受但忽略（不报错）
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { session: other.id, tokens: 3000 });
                assert.ok(out.includes('测试内容'), 'tokens 参数应正常返回快照: ' + out);
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { session: other.id, rounds: 2, chars: 8000 });
                assert.ok(out.includes('测试内容'), '旧 rounds/chars 应被接受（忽略）而非报错: ' + out);

                // 路径直读（不在目录中的会话）：给出 botId/sid 即可读
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { session: 'QQ:10000/QQ-Group:7777' });
                assert.ok(out.includes('[cross-session read-only snapshot]'), '路径直读应返回快照: ' + out);
                out = await pubRead.solve(makeCtx(), {} as any, {} as any, { session: 'QQ:10000/QQ-Group:7777' });
                assert.ok(out.includes('QQ-Group:7777'), '路径直读应含目标会话: ' + out);
            } finally {
                setPubSessionLoaderForTest(null);
            }
        } finally {
            if (origRead) toolMap['pub_read'] = origRead; else delete toolMap['pub_read'];
            resetPubRegistryForTest();
        }
    }
,

    /** pub_send 工具：路径直发（无需目录）/ QQ 富媒体 / 非 QQ 纯文本 / B 注入背景 / 离线与自拒 */
    async testPubSendTool(): Promise<void> {
        const origSend = toolMap['pub_send'];
        const origEndpoints = (globalThis as any).seal.getEndPoints;
        const origReply = (globalThis as any).seal.replyToSender;
        const origCreateTempCtx = (globalThis as any).seal.createTempCtx;
        const origNewMessage = (globalThis as any).seal.newMessage;
        let sent: string[] = [];
        try {
            resetPubRegistryForTest();
            registerPubSend();
            const pubSend = toolMap['pub_send'];

            // 目标会话 loader：记录 B 注入（addSystemUserMessage/save）
            const injected: { [sid: string]: { notes: string[]; saved: number } } = {};
            setPubSessionLoaderForTest((sid: string) => {
                if (!injected[sid]) injected[sid] = { notes: [], saved: 0 };
                return {
                    context: {
                        messages: [],
                        lastReply: '',
                        addSystemUserMessage: (note: string) => { injected[sid].notes.push(note); },
                    },
                    save: () => { injected[sid].saved++; },
                };
            });

            (globalThis as any).seal.getEndPoints = () => [
                { userId: 'QQ:10000', platform: 'QQ', state: 1, nickname: '骰娘A' },
                { userId: 'QQ:20000', platform: 'QQ', state: 1, nickname: '骰娘B' },
                { userId: 'DISCORD:30000', platform: 'DISCORD', state: 1, nickname: 'DiceD' },
            ];
            (globalThis as any).seal.createTempCtx = (_ep: any, msg: any) => ({
                endPoint: { userId: _ep.userId, platform: _ep.platform },
                player: { userId: msg.sender ? msg.sender.userId : '', name: '' },
                group: msg.messageType === 'group' ? { groupId: msg.groupId } : null,
                isPrivate: msg.messageType !== 'group',
            });
            (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { sent.push(text); };
            (globalThis as any).seal.newMessage = () => ({ sender: {}, messageType: 'group', segment: [], groupId: '', guildId: '', channelId: '' });

            const ctx = {
                endPoint: { userId: 'QQ:10000', platform: 'QQ' },
                player: { userId: 'QQ:10000', name: '骰娘A' },
                group: { groupId: 'QQ-Group:1001', groupName: '本群' },
                isPrivate: false,
                privilegeLevel: 100,
            } as any;
            const sessionStub = { sessionId: 'QQ:10000', context: { findImage: async () => null, lastReply: '' } };

            // QQ 富媒体目标（不在目录中）：路径直发 → 编码 CQ 发送 + 注入 [system:跨端消息]
            sent = [];
            resetSendHistoryForTest();
            let out = await pubSend.solve(ctx, {} as any, sessionStub as any, { session: 'QQ:20000/QQ-Group:2001', message: '[at:12345] 你好呀', reason: '测试' });
            assert.ok(out.includes('已由 QQ:20000 发送'), '路径直发应成功: ' + out);
            assert.ok(out.includes('QQ系富媒体'), 'QQ 目标应标注富媒体档: ' + out);
            assert.equal(sent.length, 1);
            assert.ok(sent[0].includes('[CQ:at'), 'QQ 富媒体应编码 at 为 CQ: ' + sent[0]);
            assert.ok(sent[0].includes('你好呀'), '正文应发送: ' + sent[0]);
            assert.ok(injected['QQ-Group:2001'], '目标会话应被加载以注入背景');
            assert.equal(injected['QQ-Group:2001'].notes.length, 1, '发送成功应注入一条跨端背景');
            assert.ok(injected['QQ-Group:2001'].notes[0].includes('Received a cross-session message from'), '背景应标注跨端消息: ' + injected['QQ-Group:2001'].notes[0]);
            assert.ok(injected['QQ-Group:2001'].notes[0].includes('你好呀'), '背景应含正文: ' + injected['QQ-Group:2001'].notes[0]);
            assert.ok(injected['QQ-Group:2001'].notes[0].includes('QQ:10000'), '背景应标注来源 Bot（调用方）: ' + injected['QQ-Group:2001'].notes[0]);
            assert.ok(injected['QQ-Group:2001'].notes[0].includes('本群'), '背景应标注来源会话名: ' + injected['QQ-Group:2001'].notes[0]);
            assert.ok(!injected['QQ-Group:2001'].notes[0].includes('QQ:20000'), '背景不应误标目标 Bot: ' + injected['QQ-Group:2001'].notes[0]);
            assert.equal(injected['QQ-Group:2001'].saved, 1, '注入后应持久化目标会话');

            // 非 QQ（DISCORD）目标：路径直发 → 剥 CQ/at 标签纯文本发送，同样注入背景
            sent = [];
            resetSendHistoryForTest();
            out = await pubSend.solve(ctx, {} as any, sessionStub as any, { session: 'DISCORD:30000/DISCORD-Group:g1/c1', message: '[at:123] 大家好 [CQ:face,id=1] 测试', reason: '测试' });
            assert.ok(out.includes('纯文本'), '非 QQ 目标应标注纯文本档: ' + out);
            assert.equal(sent.length, 1);
            assert.ok(!sent[0].includes('[CQ:'), '纯文本不应含 CQ: ' + sent[0]);
            assert.ok(!sent[0].includes('[at:'), '纯文本不应含 at 标签: ' + sent[0]);
            assert.ok(sent[0].includes('大家好') && sent[0].includes('测试'), '纯文本正文应保留: ' + sent[0]);
            assert.equal(injected['DISCORD-Group:g1/c1'].notes.length, 1, '非 QQ 发送成功也应注入背景');

            // 目录中已有条目的会话：仍可发送，标题回填
            upsertEntry({ platform: 'QQ', botId: 'QQ:20000', sid: 'QQ-Group:2001', title: '跨bot群' });
            sent = [];
            resetSendHistoryForTest();
            out = await pubSend.solve(ctx, {} as any, sessionStub as any, { session: 'QQ:20000/QQ-Group:2001', message: '再来一次', reason: '测试' });
            assert.ok(out.includes('跨bot群'), '目录标题应回填到回执: ' + out);
            assert.equal(sent.length, 1);

            // 目标即当前会话 → 拒绝
            sent = [];
            resetSendHistoryForTest();
            out = await pubSend.solve(ctx, {} as any, sessionStub as any, { session: 'QQ:10000/QQ-Group:1001', message: 'hi', reason: 'x' });
            assert.ok(out.includes('当前会话'), '目标=当前会话应拒绝: ' + out);
            assert.equal(sent.length, 0);

            // 离线 bot → 拒绝且不发送
            sent = [];
            resetSendHistoryForTest();
            out = await pubSend.solve(ctx, {} as any, sessionStub as any, { session: 'QQ:40000/QQ-Group:4004', message: 'hi', reason: 'x' });
            assert.ok(out.includes('未找到目标 Bot') || out.includes('未连接'), '离线目标应报错: ' + out);
            assert.equal(sent.length, 0);

            // 私聊路径：无权限限制，普通调用者也可发送
            sent = [];
            resetSendHistoryForTest();
            out = await pubSend.solve(ctx, {} as any, sessionStub as any, { session: 'QQ:20000/QQ:8888', message: '你好', reason: 'x' });
            assert.ok(out.includes('已由 QQ:20000 发送'), '私聊路径直发应成功（无权限限制）: ' + out);
            assert.equal(sent.length, 1);
        } finally {
            setPubSessionLoaderForTest(null);
            (globalThis as any).seal.getEndPoints = origEndpoints;
            (globalThis as any).seal.createTempCtx = origCreateTempCtx;
            (globalThis as any).seal.replyToSender = origReply;
            (globalThis as any).seal.newMessage = origNewMessage;
            if (origSend) toolMap['pub_send'] = origSend; else delete toolMap['pub_send'];
            resetPubRegistryForTest();
        }
    }
,

    // ---------------- platform / domain JSON / MCP / skill / kb / dispatch 单测 ----------------

    /** 联网默认项来自「联网」页的 5 个独立配置项，不再读 JSON defaults */
    testWebDefaultsFromConfigItems(): void {
        const keys = {
            count: '联网搜索返回条数',
            detail: '联网搜索详细程度',
            timeout: '联网搜索超时',
            maxContentChars: '联网搜索正文截断',
            fallback: '联网搜索失败回退',
            config: '联网配置',
        };
        const saved = {
            count: TC.intConfigs[keys.count],
            timeout: TC.intConfigs[keys.timeout],
            maxContentChars: TC.intConfigs[keys.maxContentChars],
            detail: TC.optionConfigs[keys.detail],
            fallback: TC.boolConfigs[keys.fallback],
            config: TC.stringConfigs[keys.config],
        };
        try {
            TC.stringConfigs[keys.config] = JSON.stringify({ version: 1, providers: [{ dialect: 'searxng' }] });
            TC.intConfigs[keys.count] = 7;
            TC.intConfigs[keys.timeout] = 33;
            TC.intConfigs[keys.maxContentChars] = 1234;
            TC.optionConfigs[keys.detail] = 'content';
            TC.boolConfigs[keys.fallback] = false;
            resetConfigCache();
            resetWebConfigCacheForTest();
            const cfg = (Config as any).web;
            assert.deepEqual(cfg.defaults, { count: 7, detail: 'content', timeout: 33, maxContentChars: 1234, fallback: false });
            assert.equal(cfg.providers.length, 1);
        } finally {
            const restore = (obj: any, key: string, value: any) => { if (value === undefined) delete obj[key]; else obj[key] = value; };
            restore(TC.intConfigs, keys.count, saved.count);
            restore(TC.intConfigs, keys.timeout, saved.timeout);
            restore(TC.intConfigs, keys.maxContentChars, saved.maxContentChars);
            restore(TC.optionConfigs, keys.detail, saved.detail);
            restore(TC.boolConfigs, keys.fallback, saved.fallback);
            restore(TC.stringConfigs, keys.config, saved.config);
            resetConfigCache();
            resetWebConfigCacheForTest();
        }
    }
,

    /** .ai skill refresh 必须绕过 Config 的 60s 缓存，读到新 JSON */
    async testDomainRefreshPicksUpNewJson(): Promise<void> {
        const key = '技能列表';
        const prior = TC.stringConfigs[key];
        try {
            TC.stringConfigs[key] = JSON.stringify({ version: 1, skills: [{ name: 'refresh-old', content: 'x' }] });
            resetConfigCache();
            refreshSkills();
            assert.ok(getSkillNames().includes('refresh-old'), '初始应读到旧技能');

            TC.stringConfigs[key] = JSON.stringify({ version: 1, skills: [{ name: 'refresh-new', content: 'x' }] });
            if (!SubCmd.map['skill']) registerCmdSkill();
            const out = await runSubCmd('skill', ['', 'refresh'], { session: new Session() });
            assert.ok(out.includes('已重新解析'), `refresh 应提示，实际: ${out}`);
            const names = getSkillNames();
            assert.ok(names.includes('refresh-new'), `refresh 后应读到新技能: ${names.join(',')}`);
            assert.ok(!names.includes('refresh-old'), `refresh 后不应残留旧技能: ${names.join(',')}`);
        } finally {
            if (prior === undefined) delete TC.stringConfigs[key]; else TC.stringConfigs[key] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** platform 匹配工具函数 */
    testPlatformUtils(): void {
        assert.equal(matchesPlatform(undefined, 'QQ'), true, '缺省 = 所有平台');
        assert.equal(matchesPlatform([], 'QQ'), true, '空数组 = 所有平台');
        assert.equal(matchesPlatform(['QQ'], 'QQ'), true);
        assert.equal(matchesPlatform(['qq'], 'QQ'), true, '应忽略大小写');
        assert.equal(matchesPlatform(['QQ-Group'], 'QQ'), true, '应剥 -Group 后缀');
        assert.equal(matchesPlatform(['DISCORD'], 'QQ'), false);
        assert.equal(matchesPlatform(['QQ'], ''), false, '未知平台不误放行受限内容');
    }
,

    /** 四个分区 JSON 解析：合法 / 非法 / 默认值 / platform */
    testDomainConfigParsers(): void {
        // ---- 角色
        const roles = parseRolesConfig(JSON.stringify({
            version: 1,
            roles: [
                { name: '测试角色', prompt: '你是测试角色' },
                { name: '这是一个超过二十个字符的角色名称啊啊啊啊啊', prompt: '设定' },
            ],
        }));
        assert.equal(roles.issues.length, 0, JSON.stringify(roles.issues));
        assert.equal(roles.config!.roles.length, 2);
        assert.equal(roles.config!.roles[1].name.length, 20, '角色名应截断到 20 字符');
        assert.ok(roles.warnings.some(w => w.path.includes('.name')), '超长名称应有 warning');
        assert.equal(parseRolesConfig('{"version":2,"roles":[]}').config, null);
        assert.equal(parseRolesConfig('{"version":1,"roles":[{"name":"","prompt":"x"}]}').config, null);
        assert.equal(parseRolesConfig('').config, null, '空文本由调用方回退默认值');

        // ---- 技能
        const skills = parseSkillsConfig(JSON.stringify({
            version: 1,
            skills: [
                { name: 'QQ技能', platform: ['QQ', 'DISCORD'], content: '正文' },
                { name: '通用技能', content: '正文2', description: '描述' },
            ],
        }));
        assert.equal(skills.issues.length, 0, JSON.stringify(skills.issues));
        assert.deepEqual(skills.config!.skills[0].platforms, ['QQ', 'DISCORD']);
        assert.equal(skills.config!.skills[1].description, '描述');
        assert.equal(parseSkillsConfig('{"version":1,"skills":[{"name":"A","content":"1"},{"name":"A","content":"2"}]}').config, null, '重复名应拒绝');
        assert.equal(parseSkillsConfig('{"version":1,"skills":[{"name":"A"}]}').config, null, '缺 content 应拒绝');

        // ---- MCP（标准 mcpServers）
        const mcp = parseMcpConfig(JSON.stringify({
            mcpServers: {
                'srv-a': { type: 'http', url: 'http://a/mcp', platform: ['QQ'], headers: { Authorization: 'Bearer x' } },
                'srv-b': { url: 'http://b/mcp' },
                'srv-skip': { command: 'node', args: ['x.js'] },
            },
        }));
        assert.equal(mcp.issues.length, 0, JSON.stringify(mcp.issues));
        assert.equal(mcp.config!.servers.length, 2, 'stdio 应跳过');
        assert.equal(mcp.config!.servers[0].name, 'srv-a');
        assert.deepEqual(mcp.config!.servers[0].platforms, ['QQ']);
        assert.equal(mcp.config!.servers[1].type, 'http', 'type 缺省 http');
        assert.ok(mcp.warnings.some(w => /stdio/.test(w.msg)), 'stdio 应有 warning');
        assert.equal(parseMcpConfig('{"servers":[]}').config, null, '非标准顶层应拒绝');
        assert.equal(parseMcpConfig('{"mcpServers":{"a":{"url":"ftp://x"}}}').config, null, '非法 url 应拒绝');
        const onlySse = parseMcpConfig('{"mcpServers":{"a":{"type":"sse","url":"http://x"}}}');
        assert.equal(onlySse.config!.servers.length, 0, 'SSE 服务器应被跳过');
        assert.ok(onlySse.warnings.some(w => /SSE/.test(w.msg)), 'SSE 应有 warning');
        // imageRefs：图片引用生产者（image-host）
        const withImageRefs = parseMcpConfig('{"mcpServers":{"image-host":{"url":"http://x/mcp","imageRefs":true}}}');
        assert.equal(withImageRefs.config!.servers[0].imageRefs, true, 'imageRefs=true 应保留');
        assert.equal(parseMcpConfig('{"mcpServers":{"a":{"url":"http://x","imageRefs":"yes"}}}').config, null, 'imageRefs 非布尔应拒绝');

        // ---- 知识库
        const kb = parseKbConfig(JSON.stringify({
            version: 1,
            libraries: [{ name: '库Q', platform: ['QQ'], content: '# 咖啡\n咖啡因' }, { name: '库D', content: '# 茶\n茶多酚' }],
        }));
        assert.equal(kb.issues.length, 0, JSON.stringify(kb.issues));
        assert.equal(kb.config!.libraries.length, 2);
        assert.deepEqual(kb.config!.libraries[0].platforms, ['QQ']);
        assert.equal(parseKbConfig('{"version":1,"libraries":[{"name":"K","content":"1"},{"name":"K","content":"2"}]}').config, null);

        // ---- 默认 JSON 可解析，内容与旧默认一致
        assert.equal(parseRolesConfig(DEFAULT_ROLES_JSON).config!.roles[0].name, '测试机器人');
        assert.equal(parseSkillsConfig(DEFAULT_SKILLS_JSON).config!.skills[0].name, '录卡');
        const defaultMcp = parseMcpConfig(DEFAULT_MCP_JSON).config!;
        assert.equal(defaultMcp.servers.length, 0, '插件侧 MCP 默认配置为空（生成器仍保留示例）');
        const defaultKb = parseKbConfig(DEFAULT_KB_JSON).config!;
        assert.deepEqual(defaultKb.libraries.map(l => l.name), ['核心指令', '扩展指令', 'ob11-api']);
        assert.deepEqual(defaultKb.libraries[2].platforms, ['QQ']);
    }
,

    /** 技能：platform 平台过滤 + 会话级开关（use_skill 守卫 + .ai skill on/off） */
    async testSkillPlatformAndSessionToggle(): Promise<void> {
        const prior = TC.stringConfigs['技能列表'];
        TC.stringConfigs['技能列表'] = JSON.stringify({
            version: 1,
            skills: [
                { name: 'qq-skill', platform: ['QQ'], content: '# QQ技能正文\nQQ 独有内容' },
                { name: 'dc-skill', platform: ['DISCORD'], content: '# DC技能正文' },
                { name: 'any-skill', content: '# 通用技能正文' },
            ],
        });
        resetConfigCache();
        refreshSkills();
        registerSkills();
        try {
            if (!SubCmd.map['skill']) registerCmdSkill();
            const ctxQQ = makeCtx();
            const qqViews = getSkillViews(s => matchesPlatform(s.platforms, 'QQ'), () => true);
            const names = qqViews.map(v => v.name);
            assert.ok(names.includes('qq-skill') && names.includes('any-skill'), `QQ 平台应含 qq-skill/any-skill，实际: ${names.join(',')}`);
            assert.ok(!names.includes('dc-skill'), 'QQ 平台不应含 dc-skill');
            const outDeny = await toolMap['use_skill'].solve(ctxQQ, {} as any, {} as any, { name: 'dc-skill' });
            assert.ok(String(outDeny).includes('is unavailable'), `平台外技能应拒绝: ${outDeny}`);
            const outClosed = await toolMap['use_skill'].solve(ctxQQ, {} as any, { skillState: { 'qq-skill': false } } as any, { name: 'qq-skill' });
            assert.ok(String(outClosed).includes('is unavailable'), `会话关闭技能应拒绝: ${outClosed}`);
            const outOk = await toolMap['use_skill'].solve(ctxQQ, {} as any, {} as any, { name: 'qq-skill' });
            assert.ok(String(outOk).includes('QQ技能正文'), `可用技能应返回正文: ${outOk}`);
            // .ai skill off/on 按会话切换
            const session = new Session();
            session.sessionId = 'QQ:1';
            const r1 = await runSubCmd('skill', ['', 'off', 'qq-skill'], { session });
            assert.ok(r1.includes('已关闭技能'), `off 应提示，实际: ${r1}`);
            assert.equal(session.skillState['qq-skill'], false, 'off 后 skillState 应为 false');
            const r2 = await runSubCmd('skill', ['', 'on', 'qq-skill'], { session });
            assert.ok(r2.includes('已开启技能'), `on 应提示，实际: ${r2}`);
            assert.equal(session.skillState['qq-skill'], undefined, 'on 后应清除关闭标记');
            const r3 = await runSubCmd('skill', ['', 'on', 'dc-skill'], { session });
            assert.ok(r3.includes('当前平台不可用'), `跨平台技能应提示不可用，实际: ${r3}`);
            const pageOut = await toolMap['skill_list'].solve(ctxQQ, {} as any, {} as any, { page: 99 });
            assert.ok(String(pageOut).includes('Page 1 of'), `越界页码应收敛到最后一页: ${pageOut}`);
            const listed = await runSubCmd('skill', ['', 'list'], { session: new Session() });
            assert.ok(listed.includes('qq-skill'), `list 应含 qq-skill: ${listed.slice(0, 300)}`);
            assert.ok(!listed.includes('dc-skill'), 'list 不应含 dc-skill');
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** 技能摘要：单条超预算跳过不阻塞后续；描述单行化/截断/空描述取首段 */
    testSkillSummaryBudgetAndDescription(): void {
        const prior = TC.stringConfigs['技能列表'];
        TC.stringConfigs['技能列表'] = JSON.stringify({
            version: 1,
            skills: [
                { name: 'long-desc', description: '长'.repeat(3000), content: 'x' },
                { name: 'no-desc', content: '# 标题\n\n目标：把表格录入。\n\n二、后续步骤' },
                { name: 'multi-line', description: '第一行\n第二行', content: 'x' },
                { name: '超'.repeat(260), description: '描述', content: 'x' },
            ],
        });
        resetConfigCache();
        refreshSkills();
        try {
            const tiny = getSkillSummariesBudgeted(60);
            assert.ok(!tiny.summaries.some(s => s.startsWith('long-desc')), '单条超预算应跳过');
            assert.ok(tiny.summaries.some(s => s.startsWith('no-desc')), '跳过超长条后仍应列出后续短条目');
            const big = getSkillSummariesBudgeted(1000000);
            const noDesc = big.summaries.find(s => s.startsWith('no-desc')) || '';
            assert.ok(noDesc.includes('目标：把表格录入'), `空描述应取正文首段：${noDesc}`);
            const multi = big.summaries.find(s => s.startsWith('multi-line')) || '';
            assert.ok(!multi.includes('\n') && multi.includes('第一行 第二行'), `描述应单行化：${multi}`);
            const long = big.summaries.find(s => s.startsWith('long-desc')) || '';
            assert.ok(long.length <= 260, `长描述应截断为 200 字符左右，实际 ${long.length}`);
            assert.ok(long.endsWith('…'), '截断应带省略号');
            const longName = '超'.repeat(260);
            assert.ok(big.summaries.some(s => s.startsWith(longName)), '超长技能名不得被截断（截断后模型无法调用）');
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** 技能摘要：150 个技能时条数上限 100，块渲染带截断提示 */
    testSkillSummaryMaxItems(): void {
        const prior = TC.stringConfigs['技能列表'];
        const skills = Array.from({ length: 150 }, (_, i) => ({ name: `many-${i}`, content: 'x' }));
        TC.stringConfigs['技能列表'] = JSON.stringify({ version: 1, skills });
        resetConfigCache();
        refreshSkills();
        try {
            const r = getSkillSummariesBudgeted(1000000, SKILL_INJECT_MAX_ITEMS);
            assert.equal(r.summaries.length, SKILL_INJECT_MAX_ITEMS, '摘要条数应为 100');
            assert.ok(r.total >= 150, `总数应至少 150，实际 ${r.total}`);
            assert.equal(r.truncated, true, '超过条数上限应标记截断');
            const block = formatSkillSummaryBlock(r);
            assert.ok(block.includes(`${r.total} skills total, ${r.summaries.length} listed within budget`), `块应提示截断：${block.slice(0, 120)}`);
            assert.ok(block.length <= 1500 + 120, `摘要块不得超预算，实际 ${block.length}`);
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** 技能摘要：长描述场景下整段渲染必须受 1500 字符预算约束（防“只按条数截断”回归） */
    testSkillSummaryBlockBudgetBound(): void {
        const prior = TC.stringConfigs['技能列表'];
        const skills = Array.from({ length: 60 }, (_, i) => ({
            name: `budget-${i}`,
            description: '描'.repeat(200),
            content: 'x',
        }));
        TC.stringConfigs['技能列表'] = JSON.stringify({ version: 1, skills });
        resetConfigCache();
        refreshSkills();
        try {
            const r = getSkillSummariesBudgeted(SKILL_INJECT_MAX_CHARS);
            assert.ok(r.summaries.length < r.total, `长描述场景应触发截断：${r.summaries.length}/${r.total}`);
            const block = formatSkillSummaryBlock(r);
            // 预算只约束条目行；标题、截断提示行与页脚是固定额外开销
            const overhead = '\n## Available skills'.length + 1
                + `( ${r.total} skills total, ${r.summaries.length} listed within budget; use skill_list to see the rest)`.length + 1
                + 'Full list: skill_list; skill content: use_skill.'.length;
            assert.ok(block.length <= SKILL_INJECT_MAX_CHARS + overhead, `摘要块超预算：${block.length}（上限 ${SKILL_INJECT_MAX_CHARS + overhead}）`);
            assert.ok(block.includes('skills total') && block.includes('listed within budget'), `块应提示截断：${block.slice(0, 120)}`);
            assert.ok(!block.includes('\n\n('), '截断提示不应破坏段落结构');
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** use_skill：正文边界、12000 截断与 offset 续读 */
    async testUseSkillFramingAndOffset(): Promise<void> {
        const prior = TC.stringConfigs['技能列表'];
        TC.stringConfigs['技能列表'] = JSON.stringify({
            version: 1,
            skills: [{
                name: 'long-skill',
                description: '长技能',
                content: 'A'.repeat(13000),
            }],
        });
        resetConfigCache();
        refreshSkills();
        registerSkills();
        try {
            const out = await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'long-skill' });
            assert.ok(String(out).startsWith('## Skill: long-skill'), `应带技能标题：${String(out).slice(0, 80)}`);
            assert.ok(String(out).includes('this call returns 0-12000'), '应提示截断区间');
            assert.ok(String(out).includes('use_skill(name="long-skill", offset=12000)'), '应提示带名称的续读调用');
            const rest = await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'long-skill', offset: 12000 });
            assert.ok(String(rest).includes('end of skill content'), `续读应提示结尾：${String(rest)}`);
            assert.ok(String(rest).includes('AAAA'), '续读应返回剩余正文');
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** use_skill：{{skill:}} 循环/未开启/不存在/超深度的边界处理 */
    async testUseSkillReferenceEdges(): Promise<void> {
        const prior = TC.stringConfigs['技能列表'];
        TC.stringConfigs['技能列表'] = JSON.stringify({
            version: 1,
            skills: [
                { name: 'A', content: 'A {{skill:B}}' },
                { name: 'B', content: 'B {{skill:A}}' },
                { name: 'C', content: 'C {{skill:dc-only}}' },
                { name: 'dc-only', platform: ['DISCORD'], content: 'DC' },
                { name: 'D', content: 'D {{skill:missing}}' },
                { name: 'deep1', content: '1 {{skill:deep2}}' },
                { name: 'deep2', content: '2 {{skill:deep3}}' },
                { name: 'deep3', content: '3 {{skill:deep4}}' },
                { name: 'deep4', content: '4' },
                { name: 'multi', content: 'M {{skill:B1}} + {{skill:B2}}' },
                { name: 'B1', content: 'b1' },
                { name: 'B2', content: 'b2' },
            ],
        });
        resetConfigCache();
        refreshSkills();
        registerSkills();
        try {
            const a = String(await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'A' }));
            assert.ok(a.includes('circular reference'), `循环引用应有明确标记：${a}`);
            const c = String(await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'C' }));
            assert.ok(c.includes('is unavailable'), `平台受限引用应提示不可用：${c}`);
            const d = String(await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'D' }));
            assert.ok(d.includes('does not exist'), `缺失引用应提示不存在：${d}`);
            const deep = String(await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'deep1' }));
            assert.ok(deep.includes('exceeds max resolution depth'), `超深引用应有标记：${deep}`);
            assert.ok(!deep.includes('{{skill:'), '输出不得残留未解析的模板语法');
            const multi = String(await toolMap['use_skill'].solve(makeCtx(), {} as any, {} as any, { name: 'multi' }));
            assert.ok(multi.includes('b1') && multi.includes('b2'), `同一正文多个引用都应展开：${multi}`);
            assert.equal((multi.match(/b1/g) || []).length, 1, `引用不得重复展开：${multi}`);
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** 技能配置自动重载：改配置不 refresh 即生效；坏 JSON 保留上一份可用技能 */
    testSkillConfigAutoReload(): void {
        const prior = TC.stringConfigs['技能列表'];
        try {
            TC.stringConfigs['技能列表'] = JSON.stringify({
                version: 1,
                skills: [{ name: 'auto-one', content: '1' }],
            });
            resetConfigCache();
            refreshSkills();
            assert.ok(getSkillNames().includes('auto-one'), '首次加载应含 auto-one');

            TC.stringConfigs['技能列表'] = JSON.stringify({
                version: 1,
                skills: [{ name: 'auto-two', content: '2' }],
            });
            assert.ok(getSkillNames().includes('auto-two'), '配置变化应自动生效，无需 refresh');

            TC.stringConfigs['技能列表'] = '{"version":1,"skills":[';
            const afterBad = getSkillNames();
            assert.ok(afterBad.includes('auto-two'), `坏 JSON 应保留上一份可用技能：${afterBad.join(',')}`);
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** .ai skill refresh：坏 JSON 时保留上一份可用技能，不套出厂默认；命令回复说明失败 */
    async testSkillRefreshKeepsLastGoodOnInvalid(): Promise<void> {
        const prior = TC.stringConfigs['技能列表'];
        try {
            TC.stringConfigs['技能列表'] = JSON.stringify({
                version: 1,
                skills: [{ name: 'refresh-one', content: '1' }],
            });
            resetConfigCache();
            refreshSkills();
            assert.ok(getSkillNames().includes('refresh-one'), '首次加载应含 refresh-one');

            TC.stringConfigs['技能列表'] = '{"version":1,"skills":[';
            resetConfigCache();
            refreshSkills(); // 模拟 .ai skill refresh
            const names = getSkillNames();
            assert.ok(names.includes('refresh-one'), `refresh 遇坏 JSON 应保留上一份技能：${names.join(',')}`);

            // 'skill' 子命令由 registerSubCommands() 注册；本文件内顺序被打乱时它可能还没注册
            if (!SubCmd.map['skill']) registerCmdSkill();
            const reply = await runSubCmd('skill', ['', 'refresh'], { session: new Session() });
            assert.ok(reply.includes('校验失败') || reply.includes('未采用'), `refresh 应明确告知校验失败：${reply}`);
        } finally {
            if (prior === undefined) delete TC.stringConfigs['技能列表']; else TC.stringConfigs['技能列表'] = prior;
            resetConfigCache();
            refreshSkills();
        }
    }
,

    /** 工具结果边界转义：正文里的 [/tool_result] 不得提前闭合外层包裹 */
    testBuildContentEscapesToolResultBoundary(): void {
        const out = buildContent({
            role: 'tool',
            text: 'a [/tool_result] b [tool_result:x] c',
            tool_call_id: 'call1',
        } as any);
        assert.equal(out, '[tool_result:call1]\na \\[/tool_result] b \\[tool_result:x] c\n[/tool_result]');
        // 幂等：已转义的标记不重复加反斜杠
        const once = escapeToolResultBoundary('a [/tool_result] b');
        assert.equal(escapeToolResultBoundary(once), once, '边界转义应幂等');
    }
,

    /** 知识库描述兜底仍要求 # 标题（保持 libraryId/kbState 稳定） */
    testKbDescriptionFallbackRequiresH1(): void {
        const noHeading = parseKnowledgeLibrary({
            name: 'K', description: '', platforms: [], content: '没有标题\n第一段',
        }, 0);
        assert.equal(noHeading.description, '', '无 # 标题时知识库描述兜底应保持为空');
        const withHeading = parseKnowledgeLibrary({
            name: 'K', description: '', platforms: [], content: '# 标题\n第一段',
        }, 0);
        assert.equal(withHeading.description, '第一段', '有 # 标题时应取标题后首段');
    }
,

    /** 技能描述/名称 warning：只提示，不拒绝配置 */
    testParseSkillExtras(): void {
        const parsed = parseSkillsConfig(JSON.stringify({
            version: 1,
            skills: [
                { name: 'S', description: '第一行\n第二行', content: 'x' },
                { name: 'N'.repeat(41), content: 'x' },
                { name: 'C', description: '描'.repeat(201), content: 'x' },
            ],
        }));
        assert.ok(parsed.config, JSON.stringify(parsed.issues));
        assert.ok(parsed.warnings.some(w => w.path === '$.skills[0].description'), '描述换行应有 warning');
        assert.ok(parsed.warnings.some(w => w.path === '$.skills[1].name'), '超长技能名应有 warning');
        assert.ok(parsed.warnings.some(w => w.path === '$.skills[2].description'), '超长描述应有 warning');
    }
,

    /** 知识库：platform 平台过滤 + 会话级开关（knowledge_* 守卫 + .ai kb on/off） */
    async testKnowledgePlatformAndSessionToggle(): Promise<void> {
        const prior = TC.stringConfigs['知识库配置'];
        TC.stringConfigs['知识库配置'] = JSON.stringify({
            version: 1,
            libraries: [
                { name: '库Q', platform: ['QQ'], content: '# 咖啡文档\n咖啡因含量' },
                { name: '库D', platform: ['DISCORD'], content: '# 茶文档\n茶多酚含量' },
            ],
        });
        resetConfigCache();
        registerKnowledgeTools();
        await knowledgeService.refresh();
        try {
            const libs = knowledgeService.getLibraries();
            const qLib = libs.find(l => l.name === '库Q')!;
            const dLib = libs.find(l => l.name === '库D')!;
            const ctxQQ = makeCtx();
            const hit = await toolMap['knowledge_search'].solve(ctxQQ, {} as any, {} as any, { query: '咖啡' });
            assert.ok(String(hit).includes('咖啡因含量'), `QQ 会话应命中库Q: ${hit}`);
            const miss = await toolMap['knowledge_search'].solve(ctxQQ, {} as any, {} as any, { query: '茶多酚' });
            assert.ok(!String(miss).includes('茶多酚'), `QQ 会话不应命中库D: ${miss}`);
            const dChunk = knowledgeService.list().find(c => c.libraryId === dLib.id)!;
            const denyRead = await toolMap['knowledge_read'].solve(ctxQQ, {} as any, {} as any, { id: dChunk.id });
            assert.ok(String(denyRead).includes('不可用'), `跨平台 read 应拒绝: ${denyRead}`);
            const qChunk = knowledgeService.list().find(c => c.libraryId === qLib.id)!;
            const okRead = await toolMap['knowledge_read'].solve(ctxQQ, {} as any, {} as any, { id: qChunk.id });
            assert.ok(String(okRead).includes('咖啡因含量'), `平台内 read 应成功: ${okRead}`);
            // 会话关闭库：list/search 均不可见
            const session = new Session();
            session.sessionId = 'QQ:1';
            session.kbState[qLib.id] = false;
            const listed = await toolMap['knowledge_list'].solve(ctxQQ, {} as any, session as any, { page: 1, page_size: 100 });
            assert.ok(!String(listed).includes('库Q'), `关闭的库不应列出: ${listed}`);
            // .ai kb off/on 按会话切换
            if (!SubCmd.map['kb']) registerCmdKb();
            const s2 = new Session();
            s2.sessionId = 'QQ:1';
            const off = await runSubCmd('kb', ['', 'off', qLib.id], { session: s2 });
            assert.ok(off.includes('已关闭知识库'), `kb off 应提示: ${off}`);
            assert.equal(s2.kbState[qLib.id], false);
            const on = await runSubCmd('kb', ['', 'on', qLib.id], { session: s2 });
            assert.ok(on.includes('已开启知识库'), `kb on 应提示: ${on}`);
            assert.equal(s2.kbState[qLib.id], undefined, 'on 后应清除关闭标记');
        } finally {
            if (prior === undefined) delete TC.stringConfigs['知识库配置']; else TC.stringConfigs['知识库配置'] = prior;
            resetConfigCache();
            await knowledgeService.refresh();
        }
    }
,

    /** dispatch：list_tools 分组展示 / search_tools mcp 参数 / call_tool 平台守卫 */
    async testDispatchGroupFilterAndPlatformGuard(): Promise<void> {
        registerDispatchTools();
        const mcpFile = new Tool({
            type: 'function',
            function: { name: 'zz_mcp_file', description: '读文件', parameters: { type: 'object', properties: {} } }
        }, false, 'mcp-files-exec', ['QQ']);
        const browser = new Tool({
            type: 'function',
            function: { name: 'zz_browser', description: '浏览器操作', parameters: { type: 'object', properties: {} } }
        }, false, 'mcp-browser', ['DISCORD']);
        const plain = new Tool({
            type: 'function',
            function: { name: 'zz_plain_calc', description: '计算', parameters: { type: 'object', properties: {} } }
        });
        try {
            const session = {
                sessionType: 'group',
                toolState: {
                    list_tools: true, search_tools: true, call_tool: true, list_mcps: true,
                    zz_mcp_file: true, zz_browser: true, zz_plain_calc: true
                }
            } as any;
            const ctxQQ = makeCtx();
            const listOut = await toolMap['list_tools'].solve(ctxQQ, {} as any, session as any, { page: 1, page_size: 100 });
            assert.ok(String(listOut).includes('## mcp-files-exec'), `list_tools 应有 mcp-files-exec 分组: ${listOut}`);
            assert.ok(String(listOut).includes('zz_mcp_file'), 'list_tools 应含 mcp 工具');
            assert.ok(!String(listOut).includes('zz_browser'), 'DISCORD 平台工具不应出现在 QQ 列表');
            const searchOut = await toolMap['search_tools'].solve(ctxQQ, {} as any, session as any, { mcp: 'mcp-files-exec', query: 'zz' });
            assert.ok(String(searchOut).includes('zz_mcp_file') && String(searchOut).includes('source: mcp-files-exec'), `search_tools mcp 应命中并标注来源: ${searchOut}`);
            const missOut = await toolMap['search_tools'].solve(ctxQQ, {} as any, session as any, { mcp: 'mcp-browser', query: 'zz' });
            assert.ok(String(missOut).includes('No tools found in source group'), `不匹配分组应提示: ${missOut}`);
            const callOut = await toolMap['call_tool'].solve(ctxQQ, {} as any, session as any, { name: 'zz_browser', arguments: {} });
            assert.ok(String(callOut).includes('not available on the current platform'), `call_tool 应拦截平台外工具: ${callOut}`);
            const grouped = Tool.getGroupedAvailableTools(session, 'QQ');
            const labels = grouped.map(g => g.group);
            // 未打分类的工具（本用例直接 new Tool 注册）落兜底分类：显示为 `builtin · Other`
            assert.ok(labels.includes(`builtin · ${DEFAULT_CATEGORY}`) && labels.includes('mcp-files-exec'), `分组应含 builtin · Other 与 mcp-files-exec: ${labels.join(',')}`);
            assert.ok(!labels.includes('mcp-browser'), '平台过滤后的分组不应含 mcp-browser');
        } finally {
            for (const k of ['zz_mcp_file', 'zz_browser', 'zz_plain_calc']) delete toolMap[k];
        }
    }
,

    /** .ai mcp：按服务器批量开关工具（会话级）+ list 视图 */
    async testAiMcpCommandBatchToggle(): Promise<void> {
        TC.stringConfigs['MCP服务器'] = JSON.stringify({
            mcpServers: {
                'mcp-files-exec': { type: 'http', url: 'http://127.0.0.1:9/mcp' },
            },
        });
        resetMCPCacheForTest();
        registerDispatchTools();
        const fake = new Tool({
            type: 'function',
            function: { name: 'zz_mcp_tool_a', description: 'A 工具', parameters: { type: 'object', properties: {} } }
        }, false, 'mcp-files-exec');
        try {
            if (!SubCmd.map['mcp']) registerCmdMcp();
            const session = new Session();
            session.sessionId = 'QQ:1';
            session.tool.state['zz_mcp_tool_a'] = false;
            const off = await runSubCmd('mcp', ['', 'on', 'mcp-files-exec'], { session });
            assert.ok(off.includes('已开启'), `mcp on 应批量开启: ${off}`);
            assert.equal(session.tool.state['zz_mcp_tool_a'], true, 'on 后工具应为开');
            const listOut = await runSubCmd('mcp', ['', 'list'], { session });
            assert.ok(listOut.includes('mcp-files-exec') && listOut.includes('zz_mcp_tool_a'), `mcp list 应含服务器与工具: ${listOut.slice(0, 300)}`);
            const off2 = await runSubCmd('mcp', ['', 'off', 'mcp-files-exec'], { session });
            assert.ok(off2.includes('已关闭'), `mcp off 应批量关闭: ${off2}`);
            assert.equal(session.tool.state['zz_mcp_tool_a'], false, 'off 后工具应为关');
        } finally {
            delete toolMap['zz_mcp_tool_a'];
            delete TC.stringConfigs['MCP服务器'];
            resetMCPCacheForTest();
        }
    }
,

    /** 工具组：内置工具必须打上分类；技能/知识库不参与组维度（无 category） */
    testToolCategoryCoverage(): void {
        // 复位注册表后只跑内置注册链，断言不受其它用例临时注册的工具干扰
        Tool.reset();
        registerTools();
        registerSkills();

        const builtin = Object.keys(toolMap).filter(n => !toolMap[n].group);
        const missing = builtin.filter(n => !toolMap[n].category);
        assert.deepEqual(missing, [], `内置工具必须打上分类（缺: ${missing.join('、')}）`);
        assert.equal(builtin.length, 65, `内置工具数应为 65（新增 resolve_context_ref + 触发规则三件套 + get_time），实际 ${builtin.length}`);

        const byCategory: { [k: string]: string[] } = {};
        for (const n of builtin) (byCategory[Tool.categoryOf(toolMap[n])] = byCategory[Tool.categoryOf(toolMap[n])] || []).push(n);
        assert.equal(byCategory['Triggers'].length, 4, `Triggers 应有 4 个: ${byCategory['Triggers']}`);
        assert.equal(byCategory['Dispatch'].length, 4, `Dispatch 应有 4 个: ${byCategory['Dispatch']}`);
        assert.ok(byCategory['Dispatch'].includes('list_tools') && byCategory['Dispatch'].includes('call_tool'), '调度组应含 list_tools/call_tool');
        assert.equal(byCategory['Memory'].length, 7, `Memory 应有 7 个: ${byCategory['Memory']}`);
        assert.equal(byCategory['Subagents'].length, 8, `Subagents 应有 8 个: ${byCategory['Subagents']}`);
        assert.ok(byCategory['Subagents'].includes('subagent') && byCategory['Subagents'].includes('job_kill'), '子代理组应含 subagent/job_kill');
        assert.ok(byCategory['Images'].includes('meme_generator') && byCategory['Resources'].includes('search_music'), 'Images/Resources 分类应命中各自的工具');
        // 未列入固定顺序表的分类只允许兜底 Other（防新增工具漏加分类）
        const unknown = Object.keys(byCategory).filter(k => !BUILTIN_CATEGORY_ORDER.includes(k));
        assert.deepEqual(unknown, [], `分类必须在 BUILTIN_CATEGORY_ORDER 内: ${unknown.join('、')}`);
        assert.equal(byCategory[DEFAULT_CATEGORY], undefined, '分类完整时不应出现兜底分类');

        // 技能/知识库：来源分组明确、且不参与组维度
        assert.equal(toolMap['use_skill'].group, 'Skills');
        assert.equal(toolMap['skill_list'].group, 'Skills');
        assert.equal(toolMap['knowledge_search'].group, 'Knowledge');
        for (const n of ['use_skill', 'skill_list', 'knowledge_search', 'knowledge_read', 'knowledge_list', 'knowledge_docs']) {
            assert.equal(Tool.categoryOf(toolMap[n]), '', `${n} 不应参与工具组维度（无 category）`);
            assert.equal(Tool.isGroupable(toolMap[n]), false, `${n} 不应是可切换组工具`);
        }
        // 外部插件注册的工具归入固定分类
        const external = Tool.withCategory(EXTERNAL_CATEGORY, () => new Tool({
            type: 'function',
            function: { name: 'zz_external_probe', description: '外部插件工具', parameters: { type: 'object', properties: {} } }
        }));
        assert.equal(Tool.categoryOf(external), EXTERNAL_CATEGORY);
        assert.equal(Tool.groupDisplay(external), `builtin · ${EXTERNAL_CATEGORY}`);
        delete toolMap['zz_external_probe'];
    }
,

    /** 工具组：分组视图（内置分类 + MCP 服务器；排序、平台过滤、技能/知识库排除） */
    testToolGroupsView(): void {
        registerTools();
        registerSkills();
        const fakeQQ = new Tool({
            type: 'function',
            function: { name: 'zz_group_mcp_qq', description: 'MCP 工具', parameters: { type: 'object', properties: {} } }
        }, false, 'zz-mcp-server', ['QQ']);
        const fakeDC = new Tool({
            type: 'function',
            function: { name: 'zz_group_mcp_dc', description: '仅 Discord 的 MCP 工具', parameters: { type: 'object', properties: {} } }
        }, false, 'zz-mcp-server', ['DISCORD']);
        try {
            const session = new Session();
            session.sessionId = 'QQ:1';
            const groups = Tool.getToolGroups(session, 'QQ');
            const keys = groups.map(g => g.key);

            // 内置分类组按固定顺序排列，且都在顺序表内
            const builtinKeys = groups.filter(g => g.kind === 'builtin').map(g => g.key);
            assert.deepEqual(builtinKeys, BUILTIN_CATEGORY_ORDER.filter(k => builtinKeys.includes(k)), `内置分类顺序错误: ${builtinKeys.join('、')}`);
            // MCP 服务器组排在内置之后，键=服务器名
            const mcpKeys = groups.filter(g => g.kind === 'mcp').map(g => g.key);
            assert.deepEqual(mcpKeys, ['zz-mcp-server'], `MCP 组应为服务器名: ${mcpKeys.join('、')}`);
            assert.equal(groups[groups.length - 1].kind, 'mcp', 'MCP 组应排在内置分类之后');

            // 平台过滤：DISCORD 限定工具不进 QQ 视图；组内计数与实际开关一致
            const memory = groups.find(g => g.key === 'Memory')!;
            assert.equal(memory.names.length, 7);
            assert.equal(memory.on, 7);
            assert.equal(memory.off, 0);
            assert.equal(memory.label, 'builtin · Memory');
            const mcp = groups.find(g => g.key === 'zz-mcp-server')!;
            assert.deepEqual(mcp.names, ['zz_group_mcp_qq'], '平台不符的 MCP 工具不应进组');
            assert.equal(Tool.isAllowedPlatform(toolMap['zz_group_mcp_dc'], 'QQ'), false);

            // 技能/知识库不作为组出现
            assert.ok(!keys.includes('Skills') && !keys.includes('Knowledge'), `Skills/Knowledge 不应作为工具组: ${keys.join('、')}`);
            assert.ok(!mcp.names.concat(memory.names).some(n => n.startsWith('knowledge_')), '知识库工具不应进任何组');

            // 开关状态参与计数
            session.tool.state['memory_add'] = false;
            session.tool.state['memory_delete'] = false;
            const memory2 = Tool.getToolGroups(session, 'QQ').find(g => g.key === 'Memory')!;
            assert.equal(memory2.on, 5);
            assert.equal(memory2.off, 2);

            // 显示名/分类名/服务器名都能解析；未命中与多命中给可读错误
            assert.equal((Tool.resolveToolGroup('Memory', groups) as any).key, 'Memory');
            assert.equal((Tool.resolveToolGroup('builtin · Memory', groups) as any).key, 'Memory');
            assert.equal((Tool.resolveToolGroup('zz-mcp-server', groups) as any).key, 'zz-mcp-server');
            assert.equal((Tool.resolveToolGroup('mcp-server', groups) as any).key, 'zz-mcp-server', '唯一包含匹配应命中该组');
            assert.ok(typeof Tool.resolveToolGroup('不存在的组', groups) === 'string', '未命中应返回错误说明');
            // 多命中：再加一台同前缀服务器 → 报歧义而不是随便挑一个
            const fakeQQ2 = new Tool({
                type: 'function',
                function: { name: 'zz_group_mcp_qq2', description: 'MCP 工具 2', parameters: { type: 'object', properties: {} } }
            }, false, 'zz-mcp-server-2', ['QQ']);
            const groups2 = Tool.getToolGroups(session, 'QQ');
            assert.ok(String(Tool.resolveToolGroup('zz-mcp', groups2)).includes('匹配多个'), '多命中应提示歧义');
            assert.deepEqual(groups2.filter(g => g.kind === 'mcp').map(g => g.key), ['zz-mcp-server', 'zz-mcp-server-2'], 'MCP 组应按服务器名排序');
            delete toolMap['zz_group_mcp_qq2'];
        } finally {
            delete toolMap['zz_group_mcp_qq'];
            delete toolMap['zz_group_mcp_dc'];
            delete toolMap['zz_group_mcp_qq2'];
        }
    }
,

    /** 工具组：批量开关（核心常驻跳过 / --force 覆盖 / 禁用名单跳过） */
    testToolGroupToggleRules(): void {
        registerTools();
        const session = new Session();
        session.sessionId = 'QQ:1';

        // 普通分类：整组关闭 / 开启
        const memory = Tool.getToolGroups(session, 'QQ').find(g => g.key === 'Memory')!;
        const off = setToolGroupState(session, memory.names, false, { skipCore: true });
        assert.equal(off.changed, 7);
        assert.equal(session.toolState['memory_add'], false);
        const on = setToolGroupState(session, memory.names, true, { skipBlocked: true });
        assert.equal(on.changed, 7);
        assert.equal(session.toolState['memory_add'], true);
        const again = setToolGroupState(session, memory.names, true, { skipBlocked: true });
        assert.equal(again.changed, 0);
        assert.equal(again.unchanged, 7, '已是目标状态应计入 unchanged');

        // 核心常驻工具：默认跳过，--force（skipCore=false）才真正关闭
        const dispatch = Tool.getToolGroups(session, 'QQ').find(g => g.key === 'Dispatch')!;
        assert.deepEqual(dispatch.names, ['call_tool', 'list_mcps', 'list_tools', 'search_tools']);
        assert.ok(dispatch.names.every(n => CORE_TOOL_NAMES.includes(n)), 'Dispatch 组应全部是核心常驻工具');
        const skipped = setToolGroupState(session, dispatch.names, false, { skipCore: true });
        assert.equal(skipped.changed, 0);
        assert.equal(skipped.skippedCore, 4);
        assert.equal(session.toolState['list_tools'], true, '核心常驻工具默认不被关闭');
        const forced = setToolGroupState(session, dispatch.names, false, { skipCore: false });
        assert.equal(forced.changed, 4);
        assert.equal(session.toolState['list_tools'], false, '--force 应能关闭核心常驻工具');
        setToolGroupState(session, dispatch.names, true, { skipBlocked: true });

        // 禁用名单：on 时跳过并计数；名单内工具也不进入组视图
        const prior = TC.templateConfigs['禁止调用的函数'];
        TC.templateConfigs['禁止调用的函数'] = ['memory_add'];
        resetConfigCache();
        try {
            const s2 = new Session();
            s2.sessionId = 'QQ:2';
            const memory2 = Tool.getToolGroups(s2, 'QQ').find(g => g.key === 'Memory')!;
            assert.equal(memory2.names.includes('memory_add'), false, '禁止调用的函数不应出现在组内');
            assert.equal(memory2.names.length, 6);
            s2.tool.state['memory_delete'] = false;
            const r = setToolGroupState(s2, ['memory_add', 'memory_delete'], true, { skipBlocked: true });
            assert.equal(r.skippedBlocked, 1, '禁用名单内的工具应被跳过');
            assert.equal(r.changed, 1, '仅未被跳过的工具被开启');
            assert.equal(s2.toolState['memory_delete'], true);
        } finally {
            if (prior === undefined) delete TC.templateConfigs['禁止调用的函数']; else TC.templateConfigs['禁止调用的函数'] = prior;
            resetConfigCache();
        }
    }
,

    /** .ai tool：组概览 / 组明细 / 组开关 / --group= / --force / 兼容旧用法 */
    async testAiToolCommandGroups(): Promise<void> {
        registerTools();
        registerSkills();
        if (!SubCmd.map['tool']) registerCmdTool();
        const session = new Session();
        session.sessionId = 'QQ:1';

        // 组概览：只列组与统计，不展开工具名
        const overview = await runSubCmd('tool', [''], { session });
        assert.ok(overview.startsWith('工具组（当前平台 QQ'), `应输出组概览: ${overview.slice(0, 120)}`);
        assert.ok(overview.includes('1. Dispatch（4，开 4 关 0）'), `概览应含 Dispatch 统计: ${overview}`);
        assert.ok(overview.includes('Memory（7，开 7 关 0）'), `概览应含 Memory 统计: ${overview}`);
        assert.ok(!overview.includes('memory_add'), '概览不应展开组内工具');
        assert.ok(overview.includes('技能/知识库工具不在工具组范围'), '概览应提示技能/知识库管理入口');
        assert.ok(!overview.includes('Skills（'), '概览不应把技能列为工具组');

        // 组明细
        const detail = await runSubCmd('tool', ['', 'Memory'], { session });
        assert.ok(detail.includes('工具组「Memory」（内置）：7 个，开 7 关 0'), `组明细头部错误: ${detail.slice(0, 120)}`);
        assert.ok(detail.includes('memory_add[开]') && detail.includes('memory_recall[开]'), '组明细应列出组内工具与开关');
        assert.ok(detail.includes('.ai tool on/off Memory'), '组明细应给出批量开关提示');

        // 组开关：关 → 概览与状态同步，开 → 恢复
        const off = await runSubCmd('tool', ['', 'off', 'Memory'], { session });
        assert.ok(off.includes('已关闭工具组「Memory」') && off.includes('实际变更 7 个'), `组关闭回复错误: ${off}`);
        assert.equal(session.toolState['memory_add'], false);
        const overviewOff = await runSubCmd('tool', [''], { session });
        assert.ok(overviewOff.includes('Memory（7，开 0 关 7）'), `关闭后概览统计应更新: ${overviewOff}`);
        const on = await runSubCmd('tool', ['', 'on', 'Memory'], { session });
        assert.ok(on.includes('已开启工具组「Memory」'), `组开启回复错误: ${on}`);
        assert.equal(session.toolState['memory_add'], true);

        // 核心常驻：组 off 默认跳过并提示 --force；--force 才真正关闭
        const offCore = await runSubCmd('tool', ['', 'off', 'Dispatch'], { session });
        assert.ok(offCore.includes('跳过核心常驻工具 4 个'), `应报告跳过的核心工具: ${offCore}`);
        assert.ok(offCore.includes('--force'), '应提示 --force 用法');
        assert.equal(session.toolState['list_tools'], true);
        const forced = await runSubCmd('tool', ['', 'off', 'Dispatch'], { session }, [{ name: 'force', valueExists: false }]);
        assert.ok(forced.includes('实际变更 4 个'), `--force 应真正关闭: ${forced}`);
        assert.equal(session.toolState['list_tools'], false);
        await runSubCmd('tool', ['', 'on', 'Dispatch'], { session });
        assert.equal(session.toolState['list_tools'], true);

        // 无参 off：跳过核心常驻工具（AI 的工具入口不会静默失效）
        const offAll = await runSubCmd('tool', ['', 'off'], { session });
        assert.ok(offAll.includes('全部工具') && offAll.includes('跳过核心常驻工具'), `无参 off 应跳过核心工具: ${offAll}`);
        assert.equal(session.toolState['list_tools'], true, '无参 off 默认保留核心常驻工具');
        assert.equal(session.toolState['memory_add'], false, '无参 off 应关闭普通工具');
        const offAllForced = await runSubCmd('tool', ['', 'off'], { session }, [{ name: 'force', valueExists: false }]);
        assert.ok(offAllForced.includes('实际变更'), `无参 off --force 应执行: ${offAllForced}`);
        assert.equal(session.toolState['list_tools'], false, '无参 off --force 应关闭核心常驻工具');
        await runSubCmd('tool', ['', 'on'], { session });

        // 显式 --group= 写法（绕开保留字与撞名）
        const byFlag = await runSubCmd('tool', [''], { session }, [{ name: 'group', value: 'Memory', valueExists: true }]);
        assert.ok(byFlag.includes('工具组「Memory」'), `--group= 应列出该组: ${byFlag.slice(0, 120)}`);
        const offByFlag = await runSubCmd('tool', ['', 'off'], { session }, [{ name: 'group', value: 'Memory', valueExists: true }]);
        assert.ok(offByFlag.includes('已关闭工具组「Memory」'), `--group= off 应关闭该组: ${offByFlag}`);
        await runSubCmd('tool', ['', 'on'], { session });

        // 兼容：技能/知识库仍可按单工具开关；工具名照旧查看详情
        const offSkill = await runSubCmd('tool', ['', 'off', 'use_skill'], { session });
        assert.ok(offSkill.includes('已关闭工具函数 use_skill'), `单工具开关应保持原行为: ${offSkill}`);
        assert.equal(session.toolState['use_skill'], false);
        await runSubCmd('tool', ['', 'on', 'use_skill'], { session });
        const toolDetail = await runSubCmd('tool', ['', 'memory_add'], { session });
        assert.ok(toolDetail.includes('memory_add') && toolDetail.includes('来源:builtin · Memory'), `工具名应展示详情: ${toolDetail.slice(0, 120)}`);
        const helpDetail = await runSubCmd('tool', ['', 'help', 'memory_add'], { session });
        assert.ok(helpDetail.includes('来源:builtin · Memory'), 'help 详情应标注分类来源');

        // 未命中给可读提示；.ai tool all 保留扁平全量视图（含技能/知识库）
        const miss = await runSubCmd('tool', ['', '不存在的组'], { session });
        assert.ok(miss.includes('未找到工具组') && miss.includes('可用组：'), `未命中应有候选提示: ${miss}`);
        const all = await runSubCmd('tool', ['', 'all'], { session });
        assert.ok(all.includes('use_skill') && all.includes('knowledge_search'), '.ai tool all 应含技能/知识库工具');
        assert.ok(all.includes('builtin · Memory:'), 'all 视图应沿用分类组头');
        const listAlias = await runSubCmd('tool', ['', 'list'], { session });
        assert.ok(listAlias.startsWith('工具组（当前平台 QQ'), 'list 别名应输出组概览');
    }
,

    // ---------------- 媒体生成（issue #127）：用途标签 / 模板 / 归一 / 适配 / 队列 / 命令 ----------------

    /** OB11 知识库的「协议端自带 AI 语音」段落：模板插值必须真的渲染出角色名 */
    testOb11KnowledgeProtocolAiVoice(): void {
        const kb = DEFAULT_KB.map(l => l.content).join('\n');
        assert.ok(kb.includes('get_ai_characters'), '知识库应指导 AI 调 get_ai_characters 查角色');
        assert.ok(kb.includes('send_group_ai_record'), '知识库应包含 send_group_ai_record 用法');
        assert.ok(kb.includes('character_id'), '应说明 character 传角色 ID 而非中文名');
        // 角色名由 PROTOCOL_AI_VOICE_CHARACTERS 插值注入（不得残留未求值的模板表达式）
        assert.ok(!kb.includes('${PROTOCOL_AI_VOICE_CHARACTERS'), '角色名模板表达式应已求值');
        for (const name of ['小新', '妲己', '书香少女']) {
            assert.ok(kb.includes(name), `常见角色名应渲染进知识库: ${name}`);
        }
        // 与插件 TTS 链路的区分（避免再次把两条链路搞混）
        assert.ok(kb.includes('generate_audio') && kb.includes('自建 TTS'), '应说明与插件 TTS 链路的区别');
    }
};
