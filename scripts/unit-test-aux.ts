// 辅助智能体能力层单测（M1-C；由 Lead 统一注册到 scripts/test-unit.cjs，本文件不自行注册）：
// - L0 注册表 viewFor(consumer/toolset/needsContext)/hasSnippet/revision/handler
// - 适配器：builtin / resource / image-host / generic-mcp 的元数据、命名空间、风险映射、执行路由
// - image-host 注册条件（后端图床 or capability:'image-host' MCP）
// - prompt flags 派生（imageUsage / imageHost / resourceLibrary；不再直接 import ImageHost）
// - MCP server capability 解析（合法/非法值 WARN 忽略）
// - 配置键：摘要工具集白名单（未知值忽略）、模板默认非空
// @ts-nocheck
import assert from "node:assert/strict";

import "./test-host";

import Config from "../src/config/config";
import { parseMcpConfig } from "../src/config/domain/parse";
import { auxRegistry, AuxToolRegistryImpl, resetAuxRegistryForTest } from "../src/core/ports/aux_tools";
import type { AuxCapabilityAdapter } from "../src/core/ports/aux_tools";
import { getAuxAgent, setAuxAgent } from "../src/core/ports/aux_agent";
import { createBuiltinAdapter } from "../src/agent/adapters/builtin";
import { createGenericMcpAdapter } from "../src/agent/adapters/generic_mcp";
import { shouldRegisterImageHost, createImageHostAdapter, findImageHostMcpServer } from "../src/agent/adapters/image_host";
import { createResourceAdapter } from "../src/agent/adapters/resource";
import { installAuxTools, resetAuxToolsForTest } from "../src/agent/aux_tools_impl";
import { deriveImagePromptFlags } from "../src/prompt/builder";
import { registerAllTools } from "../src/tool/bootstrap";
import { resetMCPCacheForTest } from "../src/tool/mcp/config";
import { toolMap } from "../src/tool/registry";

const TC = (globalThis as any).__TEST_CONFIG__;

/** Config.registerConfig 只能调用一次（重复定义宿主属性会抛错），本入口内共用一次注册 */
let configRegistered = false;
function ensureConfigRegistered(): void {
    if (configRegistered) return;
    Config.registerConfig();
    configRegistered = true;
}

function resetConfigCache(): void {
    (Config as any).cache = {};
}

function setBool(key: string, value: boolean): void {
    TC.boolConfigs[key] = value;
    resetConfigCache();
}

function setInt(key: string, value: number): void {
    TC.intConfigs[key] = value;
    resetConfigCache();
}

function setString(key: string, value: string): void {
    TC.stringConfigs[key] = value;
    resetConfigCache();
}

/** 构造一个最小适配器替身（注册表用例专用） */
function fakeAdapter(patch: Partial<AuxCapabilityAdapter> = {}): AuxCapabilityAdapter {
    return {
        id: "fake",
        kind: "builtin",
        displayName: "Fake",
        tools: () => [],
        handler: () => null,
        revision: () => 0,
        ...patch,
    };
}

export const tests: Record<string, () => void | Promise<void>> = {
    /** viewFor：按 consumer / toolset 过滤；提示词片段只给主对话 */
    testRegistryViewForFilters(): void {
        const registry = new AuxToolRegistryImpl();
        registry.register(fakeAdapter({
            id: "a",
            tools: () => [
                {
                    name: "memory_recall",
                    description: "m",
                    parameters: { type: "object", properties: {}, required: [] },
                    risk: "read",
                    consumers: ["summarizer"],
                    toolsets: ["summary-memory-read"],
                    needsContext: true,
                },
                {
                    name: "image_view",
                    description: "i",
                    parameters: { type: "object", properties: {}, required: [] },
                    risk: "read",
                    consumers: ["summarizer"],
                    toolsets: ["summary-image"],
                    needsContext: false,
                },
                {
                    name: "main_only",
                    description: "m2",
                    parameters: { type: "object", properties: {}, required: [] },
                    risk: "read",
                    consumers: ["main"],
                    toolsets: [],
                    needsContext: false,
                },
            ],
            snippet: () => ({ kind: "resource", data: { builtinImageCount: 1 } }),
        }));

        assert.deepEqual(registry.viewFor("summarizer", "summary-image").tools.map(t => t.name), ["image_view"]);
        assert.deepEqual(registry.viewFor("summarizer", "summary-memory-read").tools.map(t => t.name), ["memory_recall"]);
        assert.equal(registry.viewFor("summarizer").tools.length, 2, "不带 toolset 时应返回该消费方全部工具");
        assert.deepEqual(registry.viewFor("main").tools.map(t => t.name), ["main_only"]);
        assert.equal(registry.viewFor("main").snippets.length, 1);
        assert.equal(registry.viewFor("summarizer").snippets.length, 0, "摘要不注入提示词片段");
        assert.ok(registry.hasSnippet("resource"));
        assert.ok(!registry.hasSnippet("image-host"));
    },

    /** viewFor：needsContext 元数据保留（由 invoker 按有无 context 决定是否隐藏），适配器抛错被隔离 */
    testRegistryNeedsContextAndFailureIsolation(): void {
        const registry = new AuxToolRegistryImpl();
        registry.register(fakeAdapter({
            id: "ctx",
            tools: () => [{
                name: "memory_recall",
                description: "m",
                parameters: { type: "object", properties: {}, required: [] },
                risk: "read",
                consumers: ["summarizer"],
                toolsets: ["summary-memory-read"],
                needsContext: true,
            }],
        }));
        registry.register(fakeAdapter({
            id: "boom",
            tools: () => { throw new Error("boom"); },
            snippet: () => { throw new Error("boom"); },
        }));
        const view = registry.viewFor("summarizer", "summary-memory-read");
        assert.equal(view.tools.length, 1);
        assert.equal(view.tools[0].needsContext, true);
        assert.equal(view.snippets.length, 0);
    },

    /** 注册表：handler 路由、revision 稳定、重复注册抛错、unregister/clear */
    testRegistryLifecycle(): void {
        const registry = new AuxToolRegistryImpl();
        const adapter = fakeAdapter({
            id: "a",
            tools: () => [{
                name: "t1",
                description: "t",
                parameters: { type: "object", properties: {}, required: [] },
                risk: "read",
                consumers: ["summarizer"],
                toolsets: ["summary-image"],
                needsContext: false,
            }],
            handler: (name: string) => (name === "t1" ? async () => "ok" : null),
            revision: () => 7,
        });
        registry.register(adapter);
        assert.throws(() => registry.register(adapter), /重复注册/);
        assert.ok(registry.handler("t1"));
        assert.equal(registry.handler("t2"), null);
        assert.equal(registry.revision(), registry.revision(), "同一数据 revision 必须稳定");
        registry.unregister("a");
        assert.equal(registry.handler("t1"), null);
        registry.register(adapter);
        registry.clear();
        assert.equal(registry.list().length, 0);
        assert.equal(registry.revision(), registry.revision());
    },

    /** 内置工具适配器：schema 取自工具注册表；memory_recall 需 ctx 且属 summary-memory-read */
    async testBuiltinAdapter(): Promise<void> {
        const solved: any[] = [];
        const fakeTools: Record<string, any> = {
            memory_recall: {
                toolInfo: {
                    function: {
                        name: "memory_recall",
                        description: "recall",
                        parameters: { type: "object", properties: { query: { type: "string" } }, required: [] },
                    },
                },
                solve: async (_ctx: any, _msg: any, session: any, args: any) => {
                    solved.push({ session, args });
                    return "hit-1";
                },
            },
            image_view: {
                toolInfo: {
                    function: {
                        name: "image_view",
                        description: "view",
                        parameters: { type: "object", properties: { id: { type: "string" } }, required: [] },
                    },
                },
                solve: async () => "viewed",
            },
        };
        const adapter = createBuiltinAdapter({ getTool: (name: string) => fakeTools[name] });
        const descs = adapter.tools();
        const recall = descs.find(item => item.name === "memory_recall");
        assert.ok(recall);
        assert.equal(recall.risk, "read");
        assert.deepEqual(recall.consumers, ["summarizer"]);
        assert.deepEqual(recall.toolsets, ["summary-memory-read"]);
        assert.equal(recall.needsContext, true);
        assert.equal(recall.parameters.properties.query.type, "string", "schema 应取已注册工具定义");
        const view = descs.find(item => item.name === "image_view");
        assert.equal(view.needsContext, false);
        assert.deepEqual(view.toolsets, ["summary-image"]);

        const handler = adapter.handler("memory_recall");
        assert.ok(handler);
        // 无真实 session：不伪造，返回不可用提示
        assert.match(await handler({}, {}), /needs a real session/);
        assert.equal(solved.length, 0);
        // 有 session：走 Tool.solve（现有工具实现）
        assert.equal(await handler({ query: "x" }, { session: { sessionId: "s1" } }), "hit-1");
        assert.equal(solved[0].session.sessionId, "s1");
        // 未注册的工具（fake 里没有 list_resources）既不出现在 tools()，也不给执行句柄
        assert.ok(!descs.some(item => item.name === "list_resources"));
        assert.equal(adapter.handler("list_resources"), null);
    },

    /** 资源适配器：只读索引/存档标签 + 本地资源清单；无内容返回 null 片段 */
    testResourceAdapter(): void {
        const adapter = createResourceAdapter({
            listIndex: () => [
                { id: "img-old", entry: { u: 1 } },
                { id: "img-new", entry: { u: 5 } },
                { id: "img-other", entry: { u: 3 } },
            ],
            readLabel: (id: string) => (id === "img-new" ? "a cat\n[img:x]" : ""),
            listLocalResources: () => ["resource:cat", "resource:song"],
        });
        const snippet = adapter.snippet();
        assert.equal(snippet.kind, "resource");
        assert.equal(snippet.data.builtinImageCount, 3);
        assert.deepEqual(snippet.data.recentImages, ["img-new (a cat)", "img-other", "img-old"]);
        assert.deepEqual(snippet.data.localResources, ["resource:cat", "resource:song"]);
        assert.equal(adapter.tools().length, 0);
        assert.equal(adapter.handler("x"), null);
        assert.equal(adapter.revision(), 5, "revision = 索引条目数 + 本地资源名数");
        const empty = createResourceAdapter({ listIndex: () => [], listLocalResources: () => [] });
        assert.equal(empty.snippet(), null);
    },

    /** image-host 注册条件：后端图床或 imageRefs/capability 的 MCP；纯函数不联网 */
    testImageHostRegistrationCondition(): void {
        assert.equal(shouldRegisterImageHost({ backendEnabled: () => false, listMcpServers: () => [] }), false);
        assert.equal(shouldRegisterImageHost({ backendEnabled: () => true, listMcpServers: () => [] }), true);
        const capable = { name: "img-host", capability: "image-host" } as any;
        const legacy = { name: "old-host", imageRefs: true } as any;
        const plain = { name: "plain" } as any;
        assert.equal(findImageHostMcpServer([capable])!.name, "img-host");
        assert.equal(findImageHostMcpServer([legacy])!.name, "old-host");
        assert.equal(findImageHostMcpServer([plain]), null);
        assert.equal(shouldRegisterImageHost({ backendEnabled: () => false, listMcpServers: () => [capable] }), true);
        assert.equal(shouldRegisterImageHost({ backendEnabled: () => false, listMcpServers: () => [plain] }), false);
    },

    /** 图床适配器：工具名带服务器命名空间、风险 read/write、summary-image、handler 调 MCP */
    async testImageHostAdapter(): Promise<void> {
        ensureConfigRegistered();
        const server = { name: "img-host", capability: "image-host", imageRefs: true } as any;
        const tools = [
            { name: "image_search", description: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
            { name: "image_keep", description: "keep", inputSchema: { type: "object", properties: {} } },
            { name: "image_tag", description: "tag", inputSchema: { type: "object", properties: {} } },
        ];
        const calls: any[] = [];
        const adapter = createImageHostAdapter({
            backendEnabled: () => false,
            listMcpServers: () => [server],
            listServerTools: () => tools as any,
            callMcp: async (s: string, t: string, a: any, k: string) => {
                calls.push([s, t, a, k]);
                return "gallery text";
            },
            listIndex: () => [
                { id: "a", entry: { u: 2, h: "sha1" } },
                { id: "b", entry: { u: 1 } },
            ],
        });
        const descs = adapter.tools();
        assert.deepEqual(descs.map(item => item.name).sort(), ["img-host__image_keep", "img-host__image_search", "img-host__image_tag"]);
        const search = descs.find(item => item.name === "img-host__image_search");
        assert.equal(search.risk, "read");
        assert.deepEqual(search.toolsets, ["summary-image"]);
        assert.equal(search.needsContext, true);
        assert.equal(descs.find(item => item.name === "img-host__image_keep").risk, "write");
        const snippet = adapter.snippet();
        assert.equal(snippet.kind, "image-host");
        assert.equal(snippet.data.server, "img-host");
        assert.equal(snippet.data.galleryImageCount, 1);
        assert.deepEqual(snippet.data.recentHostedImages, ["hsha1"]);
        const handler = adapter.handler("img-host__image_search");
        assert.ok(handler);
        assert.equal(await handler({ q: "cat" }, { context: { sessionId: "s1", isPrivate: false } }), "gallery text");
        assert.deepEqual(calls[0], ["img-host", "image_search", { q: "cat" }, "s1"]);
        assert.equal(adapter.handler("other__image_search"), null);
        assert.equal(adapter.revision(), 4, "revision = 工具数 + 已入库图片数");
    },

    /** 通用 MCP 适配器：风险按 annotations 映射、默认不进 toolset、命名空间 + 执行路由 */
    async testGenericMcpAdapter(): Promise<void> {
        const tools = [
            { name: "read_thing", description: "r", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
            { name: "destroy_thing", description: "d", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
            { name: "plain_thing", description: "p", inputSchema: {} },
        ];
        const calls: any[] = [];
        const adapter = createGenericMcpAdapter({
            servers: ["srv-a"],
            listMcpServers: () => [{ name: "srv-a" } as any],
            listServerTools: () => tools as any,
            callMcp: async (s: string, t: string, a: any) => {
                calls.push([s, t]);
                return "mcp text";
            },
        });
        const descs = adapter.tools();
        assert.deepEqual(descs.map(item => item.name).sort(), ["srv-a__destroy_thing", "srv-a__plain_thing", "srv-a__read_thing"]);
        assert.equal(descs.find(item => item.name === "srv-a__read_thing").risk, "read");
        assert.equal(descs.find(item => item.name === "srv-a__destroy_thing").risk, "dangerous");
        assert.equal(descs.find(item => item.name === "srv-a__plain_thing").risk, "read", "缺注解默认 read");
        assert.ok(descs.every(item => item.toolsets.length === 0), "通用 MCP 默认不进任何 toolset");
        assert.ok(descs.every(item => item.needsContext === false), "通用 MCP 直接调用、不需要 ctx");
        const handler = adapter.handler("srv-a__plain_thing");
        assert.ok(handler);
        assert.equal(await handler({}, {}), "mcp text");
        assert.deepEqual(calls[0], ["srv-a", "plain_thing"]);
        // 未勾选服务器：不暴露任何工具
        const none = createGenericMcpAdapter({ servers: [], listMcpServers: () => [{ name: "srv-a" } as any], listServerTools: () => tools as any });
        assert.equal(none.tools().length, 0);
    },

    /**
     * flags 派生（#163 D1-07 后）：三段只由**配置开关**决定，不再看 aux 注册表片段。
     * 旧 imageLibrary 兼容字段 = imageHost。
     */
    testPromptFlagDerivation(): void {
        const base = {
            receiveImage: false,
            imageHostPrompt: false,
            resourcePrompt: false,
        };
        // 全关：三段都空
        assert.deepEqual(
            deriveImagePromptFlags(base),
            { imageUsage: false, imageHost: false, resourceLibrary: false, imageLibrary: false },
        );
        // 只开接收图片：也显示通用图片用法（有意修正 #2）
        assert.equal(deriveImagePromptFlags({ ...base, receiveImage: true }).imageUsage, true);
        // 图床开关开：图床段开，通用段跟着开（**不再要求** aux 片段存在）
        const host = deriveImagePromptFlags({ ...base, imageHostPrompt: true });
        assert.equal(host.imageHost, true);
        assert.equal(host.imageUsage, true);
        assert.equal(host.imageLibrary, true);
        // 资源段：只看开关
        assert.equal(deriveImagePromptFlags({ ...base, resourcePrompt: true }).resourceLibrary, true);
        assert.equal(deriveImagePromptFlags({ ...base, resourcePrompt: true }).imageUsage, true);
        assert.equal(deriveImagePromptFlags({ ...base, resourcePrompt: false }).resourceLibrary, false);
        // 关键断言（R1）：派生结果与「图床/MCP 是否连接」无关 —— 入参里已没有 aux 片段字段
        assert.deepEqual(
            Object.keys(deriveImagePromptFlags(base)).sort(),
            ['imageHost', 'imageLibrary', 'imageUsage', 'resourceLibrary'],
        );
        assert.equal(
            'hasImageHostSnippet' in base || 'hasResourceSnippet' in base,
            false,
            '入参不得再含 aux 片段字段（否则 system 会随连断漂移）',
        );
    },

    /** 装配：默认（图床未配置/资源段关）只注册 builtin + generic；开启后端图床后出现 image-host 片段 */
    testInstallAuxToolsDefaultsAndImageHost(): void {
        ensureConfigRegistered();
        // 与生产装配顺序一致：先注册工具，再安装 aux 适配器（builtin 适配器只暴露已注册工具）
        if (Object.keys(toolMap).length === 0) registerAllTools();
        // 本用例会临时改写这些全局配置：结束后**必须**还原，否则默认桩里「是否启用MCP」被留成 false，
        // 后续 .ai mcp 用例读到的服务器列表为空（表现为"当前平台没有可用的 MCP 服务器"）。
        const savedBool = {
            '资源清单注入': TC.boolConfigs['资源清单注入'],
            '是否启用MCP': TC.boolConfigs['是否启用MCP'],
        };
        const savedBackend = TC.stringConfigs['后端配置'];
        try {
            setBool("资源清单注入", false);
            setBool("是否启用MCP", false);
            setString("后端配置", "");
            resetAuxToolsForTest();
            installAuxTools();
            assert.ok(auxRegistry.list().some(adapter => adapter.id === "builtin"));
            assert.ok(auxRegistry.list().some(adapter => adapter.id === "mcp-generic"));
            assert.ok(!auxRegistry.hasSnippet("image-host"), "未配置后端图床/MCP 时不应有图床段");
            assert.ok(!auxRegistry.hasSnippet("resource"), "资源段默认关");
            assert.ok(auxRegistry.viewFor("summarizer", "summary-image").tools.some(tool => tool.name === "image_view"));

            // 配置后端图床：图床适配器注册 → hasSnippet('image-host') 为 true（等价旧 ImageHost.enabled）
            setString("后端配置", JSON.stringify({ version: 1, backends: { "image-host": { url: "http://127.0.0.1:46680", token: "tok" } } }));
            resetAuxToolsForTest();
            installAuxTools();
            assert.ok(auxRegistry.hasSnippet("image-host"));
            assert.equal(auxRegistry.snippet("image-host").data.backend, true);
            // 幂等：重复 install 不重复注册（非 force）
            installAuxTools();
            assert.equal(auxRegistry.list().filter(adapter => adapter.id === "image-host").length, 1);
        } finally {
            resetAuxToolsForTest();
            for (const [k, v] of Object.entries(savedBool)) {
                if (v === undefined) delete TC.boolConfigs[k]; else TC.boolConfigs[k] = v;
            }
            if (savedBackend === undefined) delete TC.stringConfigs['后端配置']; else TC.stringConfigs['后端配置'] = savedBackend;
            // MCP 配置是模块级缓存：还原配置后必须失效，否则缓存里仍是"未启用"
            resetMCPCacheForTest();
            resetConfigCache();
        }
    },

    /** 配置：摘要工具集模板默认非空 + 未知值被忽略（WARN 由配置层打印） */
    testToolsetConfig(): void {
        ensureConfigRegistered();
        const defaults = TC.factoryTemplateConfigs["摘要智能体工具集"];
        assert.ok(Array.isArray(defaults) && defaults.length > 0, "模板默认不能为空数组（AGENT.md 规则 9）");
        assert.deepEqual(defaults, ["summary-image", "summary-memory-read"]);
        TC.templateConfigs["摘要智能体工具集"] = ["summary-image", "bogus", ""];
        resetConfigCache();
        assert.deepEqual(Config.tool.SUMMARY_AGENT_TOOLSETS, ["summary-image"], "未知值应被忽略");
        delete TC.templateConfigs["摘要智能体工具集"];
        resetConfigCache();
        assert.deepEqual(Config.tool.SUMMARY_AGENT_TOOLSETS, ["summary-image", "summary-memory-read"]);
        assert.equal(Config.tool.SUMMARY_AGENT_TOOLS, true, "stub 默认 true（生产默认 false 由 register 注册）");
        assert.equal(Config.tool.SUMMARY_MAX_ROUNDS, 0, "stub 未设 int 时返回 0（生产注册默认 3）");
    },

    /** MCP capability 解析：image-host 合法、其它值 WARN 忽略 */
    testMcpCapabilityParse(): void {
        const ok = parseMcpConfig(JSON.stringify({ mcpServers: { "img-host": { url: "http://x", capability: "image-host" } } }));
        assert.ok(ok.config);
        assert.equal(ok.config.servers[0].capability, "image-host");
        const bad = parseMcpConfig(JSON.stringify({ mcpServers: { "img-host": { url: "http://x", capability: "gallery" } } }));
        assert.ok(bad.config);
        assert.equal(bad.config.servers[0].capability, undefined);
        assert.ok(bad.warnings.some(item => item.path.endsWith(".capability")), "非法 capability 应进 warnings");
    },

    /** AuxAgent 端口：未注册抛明确错误；注册后可取回 */
    testAuxAgentPort(): void {
        setAuxAgent(null);
        assert.throws(() => getAuxAgent(), /AuxAgent 未初始化/);
        const fake = { runWithTools: async () => "ok" };
        setAuxAgent(fake);
        assert.equal(getAuxAgent(), fake);
        setAuxAgent(null);
    },
};
