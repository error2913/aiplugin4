// 单测共享前置：seal 桩宿主注入、配置注册、以及各域入口共用的辅助函数。
// 由 scripts/unit-test-entry.ts 拆分而来；本文件不含任何用例，只提供导入与 helper。
// @ts-nocheck
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installTestHost } from "./test-host";
import Config from "../src/config/config";
import { MEMORY_PROMPT_TOKEN_BUDGET } from "../src/config/configs/memory";
import { resetJudgeConfigCacheForTest, resetTimerTomlConfigCacheForTest } from "../src/config/configs/trigger";

// 与生产一致：先注入测试宿主，再注册配置（配置应用钩子会预热模型注册表）
Config.registerConfig();
import { buildContent, buildMultimodalContent, collectImageUrls, estimateTextTokens, estimateMessageTokens, foldContextMessages, handleMessages, pickTier, renderFoldBudget, textToMultimodalContent, windowCharsForTier } from "../src/utils/message";
import { TokenCalibration } from "../src/token_calibration";
import { buildContentParts, normalizeMCPResult } from "../src/tool/mcp/result";
import { IMAGE_PROMPT_TEMPLATE } from "../src/resource/image_prompt";
import { markersSection, toolCallFormat } from "../src/prompt/texts/en";
import { escapeToolResultBoundary, handleReply, stripInternalTags, stripRenderTags, stripUserTags } from "../src/utils/string";
import { stripRawMarkers } from "../src/utils/raw_marker";
import { createCtx } from "../src/utils/seal";
import { fetchData } from "../src/utils/web";
import { backendAuthHeaders, backendAuthHint, backendStatusHint } from "../src/utils/backend";
import { buildEventDedupExtra, buildEventDedupKey, buildNativeNoticeText, buildNoticeText, buildRequestText, isDuplicateEvent, isNoticeInWhitelist, isOb11EventPayload, isSelfCoveredNoticeEvent, parseNoticeWhitelist, resetEventGuards } from "../src/event/notice";
import { registerRawToolSet } from "../src/tool/tools/raw/init";
import { registerImageTools } from "../src/tool/tools/image/init";
import { registerAllTools } from "../src/tool/bootstrap";
import { getRegexConfig } from "../src/config/regex";
import { ext } from "../src/config/ext";
import { resolveSendMessage } from "../src/transport/ob11/message_segments";
import { resolveEndpointId } from "../src/pipeline";
import { getSession, SessionService } from "../src/session/session_service";
import { registerSubCommands, registerAllCmds } from "../src/cmd/bootstrap";
import { setHost } from "../src/core/host";
import { SubCmd } from "../src/cmd/root_cmd";
import { defaultCmdPriv, M, U } from "../src/cmd/privilege";
import { registerCmdStatus } from "../src/cmd/sub_cmd/status";
import { registerCmdModel } from "../src/cmd/sub_cmd/model";
import { registerCmdOff } from "../src/cmd/sub_cmd/off";
import { registerContextEditTools } from "../src/tool/tools/context/tool_context";
import { registerCmdBalance } from "../src/cmd/sub_cmd/balance";
import { registerCmdMemory, resolveMmAddOptions } from "../src/cmd/sub_cmd/memory";
import { getPlatform, isGroupId, makeGroupId, makeUserId, normalizeGroupId, normalizeTargetId, normalizeUserId, platformOf } from "../src/utils/target_id";
import { MemoryManager, parseOccurredAt } from "../src/memory/manager";
import { MemoryService, SECTION_RECALL_MAX_TOKENS, setMemoryEngineFactory } from "../src/memory/service";
import { resetAuxBreaker } from "../src/model/aux_breaker";
import { canReadByTags } from "../src/memory/v2/access";
import { applyDeltaOps, parseMarkdown, blockSnapshot } from "../src/memory/v2/structured";
import { migrateBankV3 } from "../src/memory/v2/migrate_v3";
import { MemoryScheduler, resetMemorySchedulerForTest } from "../src/agent/memory_scheduler";
import { getAuxLlm, getAuxLlmImpl, setAuxLlm } from "../src/core/ports/aux_llm";
import { KnowledgeBaseService, parseKnowledgeLibrary } from "../src/memory/knowledge_base";
import SessionMemoryService, { parseLooseJson } from "../src/memory/session_memory";
import { MemoryEngine } from "../src/memory/v2/engine";
import { migrateLegacyMemory } from "../src/memory/v2/migrate";
import { resolveBankId } from "../src/memory/v2/bank_resolver";
import { buildMemoryPrompt, DEFAULT_MEMORY_PROMPT_TOKENS, MAX_MENTAL_MODELS, MAX_OBSERVATIONS, mergeMentalModels, OBSERVATION_STALE_DAYS, selectInjectionCandidates } from "../src/memory/v2/prompt";
import { InMemoryMemoryStorage, SealMemoryStorage } from "../src/memory/v2/storage";
import "../src/memory/v2";
import { getMemoryRevision } from "../src/memory/revision";
import { requestLimiter } from "../src/utils/concurrency";
import { ApiError, classifyApiError, computeArchiveTarget, isImageDownloadFailure, parseMaxContextTokens } from "../src/model/api_error";
import { describeBalanceError, fetchBalance, parseBalancePayload, resolveBalanceEndpoint } from "../src/model/balance";
import { ARCHIVE_CHUNK_TOKENS, buildRoundSegments, Context, dropOldestRound, estimateContextMessagesTokens, getKeepStart, isRealUserMessage, splitMessagesByToken, truncateMiddle } from "../src/context/context";
import { evictExpiredShards, readShard, writeShardIfAbsent } from "../src/context/archive_store";
import { registerCmdToken } from "../src/cmd/sub_cmd/token";
import { QuotaManager } from "../src/quota/manager";
import { resetStoreCacheForTest } from "../src/quota/store";
import { UsageManager, chartImageCQ, get_chart_url } from "../src/usage";
import { resolveEffectiveMaxTokens } from "../src/model/api_error";
import { getProbedContextWindow, rememberProbedContextWindow } from "../src/model/window_cache";
import Agent from "../src/agent/agent";
import { streamService } from "../src/agent/stream";
import Model from "../src/model/model";
import Logger, { setLoggerConfigProvider } from "../src/logger";
import { fetchModelList, ModelListResult } from "../src/model/list";
import { resetModelConfigCacheForTest, setModelListDepsForTest } from "../src/config/apply/model";
import { getAuxLlm, hasAuxLlm } from "../src/core/ports/aux_llm";
import { hasConfigHook, registerConfigHook, runConfigHook } from "../src/config/hooks";
import { isIgnoredConfig } from "../src/model/model";
import { Session } from "../src/session/session";
import { activeTimeSegmentIndex, computeSessionState, HOT_HOLD_MS } from "../src/session/rhythm";
import { SESSION_RUNTIME_KEYS, serializePendingQueue, serializeSession, shouldDeferCoalescedSave } from "../src/session/persistence";
import { JudgeManager } from "../src/judge/judge_manager";
import { TimerInfo, TimerManager } from "../src/timer";
import Image from "../src/resource/image";
import Tool, { BUILTIN_CATEGORY_ORDER, CORE_TOOL_NAMES, DEFAULT_CATEGORY, EXTERNAL_CATEGORY, toolMap } from "../src/tool/tool";
import { setToolGroupState } from "../src/tool/tool_group";
import { registerTools } from "../src/tool/tools/init";
import { registerCmdTool } from "../src/cmd/sub_cmd/tool";
import { formatSkillSummaryBlock, getSkillSummariesBudgeted, registerSkills, SKILL_INJECT_MAX_CHARS, SKILL_INJECT_MAX_ITEMS } from "../src/tool/skills";
import { registerDispatchTools } from "../src/tool/tools/core/tool_dispatch";
import { executeTool } from "../src/tool/executor";
import { createStopEvent, fireStopEvent, resetStopEvent, StopError, withTimeout } from "../src/utils/timeout";
import { revive } from "../src/utils/revive";
import { normalizeMsgId, transformMsgId, transformMsgIdBack } from "../src/utils/message_id";
import { registerResolveSpecialId } from "../src/tool/tools/ob11/tool_resolve_id";
import { resetResourceConfigCacheForTest } from "../src/resource/local_paths";
import { resetImageConfigCacheForTest } from "../src/config/configs/image";
import { resetWebConfigCacheForTest } from "../src/config/configs/web";
import { registerResourcePathTool } from "../src/tool/tools/resource/tool_resource_path";
import { registerResourceTools } from "../src/tool/tools/resource/init";
import { normalizeSpecialIdParams, validateSpecialIdParams } from "../src/transport/ob11/special_id_params";
import { registerSpecialResource } from "../src/utils/special_id";
import { resetPubRegistryForTest, upsertEntry, removeEntry, listEntries, listGroups, listBotEntries, resolveEntryByPrefix, resolveSessionAddress, purgeOffline, isQQLikePlatform, stripCQCode, allowSendNow, recordSend, resetSendHistoryForTest, getEntryById } from "../src/pub/registry";
import { renderPubSnapshot } from "../src/pub/snapshot";
import { registerCmdPub } from "../src/cmd/sub_cmd/pub";
import { registerPubRead, registerPubSend, setPubSessionLoaderForTest } from "../src/tool/tools/pub/tool_pub";
import { matchesPlatform } from "../src/utils/target_id";
import { formatMcpError, getConfiguredMCPServers, resetMCPCacheForTest } from "../src/tool/mcp";
import {
    parseKbConfig, parseMcpConfig, parseRolesConfig, parseSkillsConfig,
} from "../src/config/domain/parse";
import {
    DEFAULT_KB_JSON, DEFAULT_MCP_JSON, DEFAULT_ROLES_JSON, DEFAULT_SKILLS_JSON,
} from "../src/config/domain/defaults";
import { registerCmdMcp } from "../src/cmd/sub_cmd/mcp";
import { registerCmdSkill } from "../src/cmd/sub_cmd/skill";
import { registerCmdKb } from "../src/cmd/sub_cmd/kb";
import { registerKnowledgeTools } from "../src/tool/tools/memory/tool_knowledge";
import { knowledgeService } from "../src/memory/knowledge";
import { getSkillNames, getSkillViews, refreshSkills } from "../src/tool/skills";
import { DEFAULT_KB } from "../src/config/domain/defaults";
import { PROVIDER_MAP } from "../src/config/static_config/providers";
import { pickNextModel } from "../src/agent/agent";
import { adaptV5 } from "../src/config/v5/adapt";
import { parseBaseUrl } from "../src/model/base_url";
import { normalizePurposeList, parseV5Config } from "../src/config/v5/schema";
import { classifyModel } from "../src/model/catalog";
import { buildProviderBody, extractUsage } from "../src/model/adapter";
import { MEDIA_PRESETS, resolveMediaPreset } from "../src/config/static_config/media_presets";
import {
    collectPlaceholders,
    buildMediaParamHint,
    composeMediaTemplate,
    joinMediaUrl,
    normalizeMediaParams,
    renderMediaBody,
    renderMediaText,
    resolveMediaUrl,
    templateParamKeys,
    useParamSummary,
} from "../src/model/media_template";
import {
    bodyDefaultsFor,
    defaultMediaParamsFor,
    promptExtraFor,
    requestOverridesFor,
    resetRuleRowsForTest,
    responseRuleFor,
    ruleBodyFor,
    ruleParamsFor,
    setRuleRows,
} from "../src/model/request_rules";
import {
    extractMediaData,
    mediaErrorHint,
    numOrDefault,
    extractMediaError,
    getByPath,
    hexToBase64,
    normalizeMediaData,
    responseDataType,
} from "../src/model/media";
import { MediaTaskManager, sanitizeImageName } from "../src/media/task_queue";
import { buildMediaSubmitReply } from "../src/tool/tools/media/shared";
import { registerCmdMedia, buildQueueText } from "../src/cmd/sub_cmd/media";
import { formatTaskLine } from "../src/tool/tools/media/tool_media_tasks";
import { registerCmdTti } from "../src/cmd/sub_cmd/tti";
import { registerCmdTts } from "../src/cmd/sub_cmd/tts";
const TC = (globalThis as any).__TEST_CONFIG__;

const TEST_JUDGE_TOML = 'version = 2';

function resetConfigCache() {
    (Config as any).cache = {};
    resetJudgeConfigCacheForTest();
    resetTimerTomlConfigCacheForTest();
    resetModelConfigCacheForTest();
    // 旧测试默认依赖判定配置可用：未显式设置时补默认（显式空/非法仍可测 Q9 分支）
    if (TC.stringConfigs['评分触发参数'] === undefined) TC.stringConfigs['评分触发参数'] = TEST_JUDGE_TOML;
}

function makeCtx(): any {
    return { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:10000', name: '测试员' } };
}

function setupImageTestConfig() {
    TC.optionConfigs['日志级别'] = '从不';
    // 防漂移：确保「识图」用例不会因为 option 变成「总是」而真去连 example.com（Node 无外网 → 30s 卡死）
    TC.optionConfigs['识别图片时将url转换为base64'] = '永不';
    delete TC.stringConfigs['后端配置'];
    resetConfigCache();
}

function restoreImageTestConfig() {
    delete TC.optionConfigs['日志级别'];
    delete TC.optionConfigs['识别图片时将url转换为base64'];
    delete TC.stringConfigs['后端配置'];
    resetConfigCache();
}

function bytesToBody(bytes: number[]): string {
    return bytes.map(b => String.fromCharCode(b)).join('');
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function imageResponse(bytes: number[], contentType = 'image/png') {
    return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
        text: async () => bytesToBody(bytes),
    };
}

function freshJudgeState(_now: number): any {
    return {
        pending: null,
        waitUntil: 0,
        timeline: [],
    };
}

function makeJudgeSession(sid: string): any {
    return {
        sessionId: sid,
        context: { timer: null, messages: [] },
        running: false,
        starting: false,
        chat: async () => 'fired',
    };
}

function makeTestObservation(id: string, text: string, scopeTags: string[], updatedAt: number, lastVerifiedAt?: number): any {
    return {
        id,
        bankId: 'user_c',
        text,
        scopeTags,
        evidence: [],
        proofCount: 1,
        createdAt: updatedAt,
        updatedAt,
        lastVerifiedAt: lastVerifiedAt ?? updatedAt,
        history: [],
    };
}

function makeTestMentalModel(id: string, question: string, answer: string, scopeTags: string[], updatedAt: number): any {
    return {
        id,
        bankId: 'user_c',
        question,
        answer,
        scopeTags,
        createdAt: updatedAt,
        updatedAt,
        version: 1,
        lastRefreshedAt: updatedAt,
        history: [],
        trigger: 'full',
    };
}

function makeLegacyBank(id: string, models: any[]): any {
    return {
        meta: {
            id,
            kind: 'user',
            agentName: '',
            sessionId: id,
            createdAt: 1000,
            updatedAt: 2000,
            settings: { disposition: { skepticism: 3, literalism: 3, empathy: 3 }, directives: [] },
        },
        units: [],
        entities: [],
        links: [],
        observations: [],
        mentalModels: models,
        documents: [],
        chunks: [],
    };
}

function makeMemoArgs(args: string[], kwargs: { name: string; value?: string; valueExists?: boolean }[] = []): any {
    return {
        args,
        kwargs: kwargs.map(k => ({ name: k.name, value: k.value ?? '', valueExists: k.valueExists ?? false, asBool: false })),
        getArgN: (n: number) => args[n - 1] ?? '',
        getRestArgsFrom: (n: number) => args.slice(n - 1).join(' '),
        getKwarg: (name: string) => (kwargs.find(k => k.name === name) as any) || null,
    };
}

function makeMemoScc(over: any = {}): any {
    const { ctx: overCtx, ...rest } = over;
    const sessionId = rest.session?.sessionId || 'QQ:10000';
    return {
        ctx: {
            endPoint: { userId: 'QQ:10000' },
            player: { userId: 'QQ:10000', name: '测试员' },
            isPrivate: true,
            privilegeLevel: 0,
            ...(overCtx || {}),
        },
        msg: {},
        epId: 'QQ:10000',
        uid: 'QQ:10000',
        gid: '',
        sid: sessionId,
        page: 1,
        ret: {},
        session: new Session(),
        ...rest,
    };
}

function makeMemoSession(sessionId: string): Session {
    const s = new Session();
    s.sessionId = sessionId;
    s.sessionType = sessionId.includes('-Group:') ? 'group' : 'user';
    s.agentName = '';
    s.memory.sessionId = sessionId;
    s.memory.agentName = s.agentName;
    return s;
}

async function runMemo(scc: any): Promise<string> {
    const origReply = (globalThis as any).seal.replyToSender;
    let replied = '';
    (globalThis as any).seal.replyToSender = (_ctx: any, _msg: any, text: string) => { replied = text; };
    try {
        await SubCmd.map['memory'].solve(scc);
    } finally {
        (globalThis as any).seal.replyToSender = origReply;
    }
    return replied;
}

function pinConn(provider: string, models: string[], baseUrl = 'https://x', apiKey = 'k'): any {
    return { provider, apiKey, baseUrl, ignore: false, models, request: {} };
}

function pinConnTyped(provider: string, models: string[], modelTypes: Record<string, string>, baseUrl = 'https://x', apiKey = 'k'): any {
    return { provider, apiKey, baseUrl, ignore: false, models, modelTypes, request: {} };
}

function seedPinnedConns(conns: any[], rules: any[] = []) {
    Model.reset();
    Model.bootstrap(conns, rules);
}

async function seedAutoConns(conns: any[], fetchFn: (ctx: any) => Promise<ModelListResult>, rules: any[] = []) {
    Model.reset();
    Model.bootstrap(conns, rules, { fetch: fetchFn as any });
    await Model.ensureLoaded();
}

function seedFromV5Config(cfg: any, fetchFn?: (ctx: any) => Promise<ModelListResult>) {
    resetModelConfigCacheForTest();
    TC.stringConfigs['模型配置'] = JSON.stringify(cfg);
    resetConfigCache();
    const runtime = (Config as any).model;
    if (fetchFn) setModelListDepsForTest({ fetch: fetchFn as any });
    return runtime;
}

function v5Conn(over: any = {}) {
    return {
        api: 'openai-completions',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'k',
        ...over,
    };
}

function v5Model(id: string, name?: string, kind?: string) {
    const m: any = { id, name: name ?? id };
    if (kind) m.kind = kind;
    return m;
}

function seedMediaModelAndStubFetch(opts: {
    kind: 'tti' | 'tts';
    modelName: string;
    /** 供应商（决定用哪套内置预设；tts 用 openai 才有 /audio/speech 结构）。默认：tti=custom，tts=openai */
    provider?: string;
    /** 响应体构造（默认给 base64 图片 / url 音频） */
    respond?: () => any;
    /** 人为延迟毫秒数（模拟慢生成） */
    delayMs?: number;
    /** 响应 content-type（binary 型预设靠它决定"按 JSON 取数"还是"当二进制"） */
    contentType?: string;
}): { restore: () => void; calls: () => number } {
    const origFetch = (globalThis as any).fetch;
    const origBackend = TC.stringConfigs['后端配置'];
    let calls = 0;
    const model = opts.modelName;
    const provider = opts.provider ?? (opts.kind === 'tti' ? 'custom' : 'openai');
    const types = opts.kind === 'tti' ? { [model]: 'gen' } : { [model]: 'tts' };
    // 这些用例验证的是「直连上游」的媒体链路；出厂默认 backends.media-fetch.url 非空，
    // 二进制取数会直接走 media-fetch 后端（生产 goja 行为），而这里的 mock fetch 没有模拟
    // 后端协议，故显式禁用中转。
    TC.stringConfigs['后端配置'] = JSON.stringify({
        version: 1,
        backends: { 'media-fetch': { url: '' } },
    });
    resetConfigCache();
    Model.bootstrap([
        {
            provider, apiKey: 'k', baseUrl: 'https://media.test/v1',
            ignore: false, request: {}, models: [model], modelTypes: types,
        },
    ], [], { fetch: async () => [] });

    const contentType = opts.contentType ?? 'application/json';
    (globalThis as any).fetch = async () => {
        calls++;
        if (opts.delayMs && opts.delayMs > 0) await new Promise(r => setTimeout(r, opts.delayMs));
        const body = opts.respond
            ? opts.respond()
            : (opts.kind === 'tti'
                ? { data: [{ b64_json: Buffer.from('ABCD').toString('base64') }] }
                : { data: { url: 'https://media.test/a.mp3' } });
        return {
            ok: true, status: 200,
            headers: { get: (k: string) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
            text: async () => JSON.stringify(body),
        };
    };

    return {
        restore: () => {
            (globalThis as any).fetch = origFetch;
            if (origBackend === undefined) delete TC.stringConfigs['后端配置'];
            else TC.stringConfigs['后端配置'] = origBackend;
            resetConfigCache();
        },
        calls: () => calls,
    };
}

function stubSealEndpoint(): () => void {
    const origGetEndPoints = (globalThis as any).seal.getEndPoints;
    const origCreateTempCtx = (globalThis as any).seal.createTempCtx;
    (globalThis as any).seal.getEndPoints = () => ([{ userId: 'QQ:10000', state: 1 }]);
    (globalThis as any).seal.createTempCtx = (ep: any, msg: any) => ({
        endPoint: { userId: ep.userId },
        player: { userId: msg.sender.userId, name: '' },
        group: msg.groupId ? { groupId: msg.groupId } : undefined,
        isPrivate: msg.messageType === 'private',
    });
    return () => {
        (globalThis as any).seal.getEndPoints = origGetEndPoints;
        (globalThis as any).seal.createTempCtx = origCreateTempCtx;
    };
}

function withRequestTimeout<T>(ms: number, fn: () => T): T {
    const orig = TC.intConfigs['请求超时时限'];
    TC.intConfigs['请求超时时限'] = ms;
    resetConfigCache();
    try {
        return fn();
    } finally {
        if (orig === undefined) delete TC.intConfigs['请求超时时限']; else TC.intConfigs['请求超时时限'] = orig;
        resetConfigCache();
    }
}

function makeMediaCtx(groupId: string): any {
    return { endPoint: { userId: 'QQ:10000' }, player: { userId: 'QQ:1' }, group: { groupId }, isPrivate: false };
}

async function runSubCmd(name: string, args: string[], sccOver: any = {}, kwargs: any[] = []): Promise<string> {
    const scc = makeMemoScc(sccOver);
    scc.cmdArgs = makeMemoArgs(args, kwargs);
    const origReply = (globalThis as any).seal.replyToSender;
    let replied = '';
    (globalThis as any).seal.replyToSender = (_c: any, _m: any, text: string) => { replied = text; };
    try {
        await SubCmd.map[name].solve(scc);
    } finally {
        (globalThis as any).seal.replyToSender = origReply;
    }
    return replied;
}

export {
    assert, fs, path, installTestHost,
    Config, MEMORY_PROMPT_TOKEN_BUDGET, resetJudgeConfigCacheForTest, resetTimerTomlConfigCacheForTest,
    buildContent, buildMultimodalContent, collectImageUrls, estimateTextTokens,
    estimateMessageTokens, foldContextMessages, handleMessages, pickTier,
    renderFoldBudget, textToMultimodalContent, windowCharsForTier, TokenCalibration,
    buildContentParts, normalizeMCPResult, IMAGE_PROMPT_TEMPLATE, markersSection,
    toolCallFormat, escapeToolResultBoundary, handleReply, stripInternalTags,
    stripRenderTags, stripUserTags, stripRawMarkers, createCtx,
    fetchData, backendAuthHeaders, backendAuthHint, backendStatusHint,
    buildEventDedupExtra, buildEventDedupKey, buildNativeNoticeText, buildNoticeText,
    buildRequestText, isDuplicateEvent, isNoticeInWhitelist, isOb11EventPayload,
    isSelfCoveredNoticeEvent, parseNoticeWhitelist, resetEventGuards, registerRawToolSet,
    registerImageTools, registerAllTools, getRegexConfig, ext,
    resolveSendMessage, resolveEndpointId, getSession, SessionService,
    registerSubCommands, registerAllCmds, setHost, SubCmd,
    defaultCmdPriv, M, U, registerCmdStatus,
    registerCmdModel, registerCmdOff, registerContextEditTools, registerCmdBalance,
    registerCmdMemory, resolveMmAddOptions, getPlatform, isGroupId,
    makeGroupId, makeUserId, normalizeGroupId, normalizeTargetId,
    normalizeUserId, platformOf, MemoryManager, parseOccurredAt,
    MemoryService, SECTION_RECALL_MAX_TOKENS, setMemoryEngineFactory, resetAuxBreaker,
    canReadByTags, applyDeltaOps, parseMarkdown, blockSnapshot,
    migrateBankV3, MemoryScheduler, resetMemorySchedulerForTest, getAuxLlm,
    setAuxLlm, KnowledgeBaseService, parseKnowledgeLibrary, SessionMemoryService,
    parseLooseJson, MemoryEngine, migrateLegacyMemory, resolveBankId,
    buildMemoryPrompt, DEFAULT_MEMORY_PROMPT_TOKENS, MAX_MENTAL_MODELS, MAX_OBSERVATIONS,
    mergeMentalModels, OBSERVATION_STALE_DAYS, selectInjectionCandidates, InMemoryMemoryStorage,
    SealMemoryStorage, getMemoryRevision, requestLimiter, ApiError,
    classifyApiError, computeArchiveTarget, isImageDownloadFailure, parseMaxContextTokens,
    describeBalanceError, fetchBalance, parseBalancePayload, resolveBalanceEndpoint,
    ARCHIVE_CHUNK_TOKENS, buildRoundSegments, Context, dropOldestRound,
    estimateContextMessagesTokens, getKeepStart, isRealUserMessage, splitMessagesByToken,
    truncateMiddle, evictExpiredShards, readShard, writeShardIfAbsent,
    registerCmdToken, QuotaManager, resetStoreCacheForTest, UsageManager,
    chartImageCQ, get_chart_url, resolveEffectiveMaxTokens, getProbedContextWindow,
    rememberProbedContextWindow, Agent, streamService, Model,
    Logger, setLoggerConfigProvider, fetchModelList, ModelListResult,
    resetModelConfigCacheForTest, setModelListDepsForTest, hasAuxLlm, hasConfigHook,
    registerConfigHook, runConfigHook, isIgnoredConfig, Session,
    activeTimeSegmentIndex, computeSessionState, HOT_HOLD_MS, SESSION_RUNTIME_KEYS,
    serializePendingQueue, serializeSession, shouldDeferCoalescedSave, JudgeManager,
    TimerInfo, TimerManager, Image, Tool,
    BUILTIN_CATEGORY_ORDER, CORE_TOOL_NAMES, DEFAULT_CATEGORY, EXTERNAL_CATEGORY,
    toolMap, setToolGroupState, registerTools, registerCmdTool,
    formatSkillSummaryBlock, getSkillSummariesBudgeted, registerSkills, SKILL_INJECT_MAX_CHARS,
    SKILL_INJECT_MAX_ITEMS, registerDispatchTools, executeTool, createStopEvent,
    fireStopEvent, resetStopEvent, StopError, withTimeout,
    revive, normalizeMsgId, transformMsgId, transformMsgIdBack,
    registerResolveSpecialId, resetResourceConfigCacheForTest, resetImageConfigCacheForTest, resetWebConfigCacheForTest,
    registerResourcePathTool, registerResourceTools, normalizeSpecialIdParams, validateSpecialIdParams,
    registerSpecialResource, resetPubRegistryForTest, upsertEntry, removeEntry,
    listEntries, listGroups, listBotEntries, resolveEntryByPrefix,
    resolveSessionAddress, purgeOffline, isQQLikePlatform, stripCQCode,
    allowSendNow, recordSend, resetSendHistoryForTest, getEntryById,
    renderPubSnapshot, registerCmdPub, registerPubRead, registerPubSend,
    setPubSessionLoaderForTest, matchesPlatform, formatMcpError, getConfiguredMCPServers,
    resetMCPCacheForTest, parseKbConfig, parseMcpConfig, parseRolesConfig,
    parseSkillsConfig, DEFAULT_KB_JSON, DEFAULT_MCP_JSON, DEFAULT_ROLES_JSON,
    DEFAULT_SKILLS_JSON, registerCmdMcp, registerCmdSkill, registerCmdKb,
    registerKnowledgeTools, knowledgeService, getSkillNames, getSkillViews,
    refreshSkills, DEFAULT_KB, PROVIDER_MAP, pickNextModel,
    adaptV5, parseBaseUrl, normalizePurposeList, parseV5Config,
    classifyModel, buildProviderBody, extractUsage, MEDIA_PRESETS,
    resolveMediaPreset, collectPlaceholders, buildMediaParamHint, composeMediaTemplate,
    joinMediaUrl, normalizeMediaParams, renderMediaBody, renderMediaText,
    resolveMediaUrl, templateParamKeys, useParamSummary, bodyDefaultsFor,
    defaultMediaParamsFor, promptExtraFor, requestOverridesFor, resetRuleRowsForTest,
    responseRuleFor, ruleBodyFor, ruleParamsFor, setRuleRows,
    extractMediaData, mediaErrorHint, numOrDefault, extractMediaError,
    getByPath, hexToBase64, normalizeMediaData, responseDataType,
    MediaTaskManager, sanitizeImageName, buildMediaSubmitReply, registerCmdMedia,
    buildQueueText, formatTaskLine, registerCmdTti, registerCmdTts,
    TC, TEST_JUDGE_TOML, resetConfigCache, makeCtx,
    setupImageTestConfig, restoreImageTestConfig, bytesToBody, PNG_MAGIC,
    imageResponse, freshJudgeState, makeJudgeSession, makeTestObservation,
    makeTestMentalModel, makeLegacyBank, makeMemoArgs, makeMemoScc,
    makeMemoSession, runMemo, pinConn, pinConnTyped,
    seedPinnedConns, seedAutoConns, seedFromV5Config, v5Conn,
    v5Model, seedMediaModelAndStubFetch, stubSealEndpoint, withRequestTimeout,
    makeMediaCtx, runSubCmd, getAuxLlmImpl,
};
