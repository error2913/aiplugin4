// 提示词段注册表 / 组装器单测：排序、遮蔽、空段、异常隔离、上限、缓存、清洗、通道、hook、digest。
import assert from "node:assert/strict";

import "./test-host";

import Config from "../src/config/config";
import { assemblePrompt, onPromptAssemble, renderSectionTable, resetPromptHooks } from "../src/prompt/assemble";
import { buildPromptParts } from "../src/prompt/builder";
import { listPromptSections, registerExtensionSection, registerPromptSection, registerPromptSections, resetPromptSections } from "../src/prompt/registry";
import { registerBuiltinSections } from "../src/prompt/sections";
import { buildCapabilitiesSection } from "../src/prompt/sections/capabilities";
import type { PromptContext, PromptSection } from "../src/prompt/types";
import { registerAllTools } from "../src/tool/bootstrap";
import { toolMap } from "../src/tool/registry";

/** Config.registerConfig 只能调用一次（重复定义宿主属性会抛错），多个用例共用一次注册 */
let configRegistered = false;
function ensureConfigRegistered(): void {
    if (configRegistered) return;
    Config.registerConfig();
    configRegistered = true;
}

function makeContext(patch: Partial<PromptContext> = {}): PromptContext {
    const ctx = {
        isPrivate: true,
        player: { name: 'tester', userId: 'QQ:1' },
        group: undefined,
        endPoint: { userId: 'QQ:10000' },
    } as any;
    const session = {
        sessionId: 'QQ:1',
        sessionType: 'user',
        toolState: {},
        skillState: {},
        kbState: {},
        memory: { persona: '' },
        context: { messages: [] },
        setting: null,
    } as any;
    return {
        ctx,
        session,
        roleSetting: '',
        roleIndex: 0,
        platform: 'QQ',
        isPrivate: true,
        sessionName: 'tester',
        sessionId: 'QQ:1',
        botId: 'QQ:10000',
        flags: {
            status: false,
            promptEngineering: false,
            directionPrompt: false,
            receiveImage: false,
            imageLibrary: false,
            memory: false,
            knowledge: false,
        },
        tool: () => false,
        memoryQuery: '',
        memoryUsers: [],
        memoryGroup: null,
        ...patch,
    };
}

function restoreBuiltinSections(): void {
    resetPromptSections();
    registerBuiltinSections();
}

function runWithSections(sections: PromptSection[], fn: () => Promise<void>): Promise<void> {
    resetPromptSections();
    registerPromptSections(sections);
    return fn().finally(() => restoreBuiltinSections());
}

export const tests: Record<string, () => void | Promise<void>> = {
    /** 内置段注册齐全且命名符合 core:/tool: 约定 */
    testBuiltinSectionsRegistered(): void {
        restoreBuiltinSections();
        const names = listPromptSections().map(section => section.name);
        for (const expected of ['core:identity', 'core:role', 'core:language', 'core:session', 'core:markers', 'core:reply', 'core:skills', 'core:knowledge', 'core:delegation', 'core:time', 'core:memory']) {
            assert.ok(names.includes(expected), `缺少内置段 ${expected}`);
        }
        assert.ok(names.every(name => name.startsWith('core:') || name.startsWith('tool:')), '内置段应使用 core:/tool: 命名空间');
    },

    /** 按 order 升序、同 order 按 name 排序，空段丢弃 */
    async testOrderAndEmptyDrop(): Promise<void> {
        const sections: PromptSection[] = [
            { name: 'core:b', order: 10, channel: 'system', build: () => 'B' },
            { name: 'core:a', order: 10, channel: 'system', build: () => 'A' },
            { name: 'core:hidden', order: 5, channel: 'system', build: () => '   ' },
            { name: 'core:first', order: -10, channel: 'system', build: () => 'FIRST' },
        ];
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            assert.equal(parts.system, 'FIRST\n\nA\n\nB');
            assert.equal(parts.stats.length, 3, '空段不应进入统计');
        });
    },

    /** 内置段重名直接抛错 */
    testDuplicateCoreSectionThrows(): void {
        resetPromptSections();
        try {
            registerPromptSection({ name: 'core:dup', order: 1, channel: 'system', build: () => 'x' });
            assert.throws(() => registerPromptSection({ name: 'core:dup', order: 2, channel: 'system', build: () => 'y' }));
        } finally {
            restoreBuiltinSections();
        }
    },

    /** 单段异常被隔离，其余段仍输出 */
    async testBuildErrorIsolated(): Promise<void> {
        const sections: PromptSection[] = [
            { name: 'core:ok', order: 1, channel: 'system', build: () => 'OK' },
            {
                name: 'core:boom',
                order: 2,
                channel: 'system',
                build: () => {
                    throw new Error('boom');
                },
            },
        ];
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            assert.equal(parts.system, 'OK');
        });
    },

    /** maxChars 截断 */
    async testMaxCharsTruncation(): Promise<void> {
        const sections: PromptSection[] = [
            { name: 'core:long', order: 1, channel: 'system', maxChars: 10, build: () => 'abcdefghijklmnopqrstuvwxyz' },
        ];
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            assert.ok(parts.system.length <= 10, `应截断到 10 字符以内，实际 ${parts.system.length}`);
            assert.ok(parts.system.endsWith('…'));
        });
    },

    /** 段级缓存：同 deps 命中，deps 变化重建 */
    async testSectionCacheHitAndInvalidate(): Promise<void> {
        let builds = 0;
        let dep = 'v1';
        const sections: PromptSection[] = [
            {
                name: 'core:cached',
                order: 1,
                channel: 'system',
                cache: { deps: () => [dep] },
                build: () => {
                    builds++;
                    return `build-${builds}`;
                },
            },
        ];
        await runWithSections(sections, async () => {
            const first = await assemblePrompt(makeContext());
            const second = await assemblePrompt(makeContext());
            assert.equal(first.stats[0].cache, 'miss');
            assert.equal(second.stats[0].cache, 'hit');
            assert.equal(first.system, second.system, '同 deps 应命中缓存');
            assert.equal(builds, 1);

            dep = 'v2';
            const third = await assemblePrompt(makeContext());
            assert.equal(third.stats[0].cache, 'miss');
            assert.equal(builds, 2);
        });
    },

    /** sanitize：trusted 保留内部标签示例，external 剥离 */
    async testSanitizePolicy(): Promise<void> {
        const sections: PromptSection[] = [
            { name: 'core:trusted', order: 1, channel: 'system', build: () => 'Example [from:name(ID)] and [system:event]x[/system]' },
            { name: 'core:external', order: 2, channel: 'system', sanitize: 'external', build: () => 'External [from:name(ID)] and [system:event]x[/system]' },
        ];
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            assert.ok(parts.system.includes('Example [from:name(ID)]'), 'trusted 段应保留内部标签示例');
            assert.ok(parts.system.includes('[system:event]x[/system]'), 'trusted 段应保留 system 标签示例');
            assert.ok(!parts.system.includes('External [from:'), 'external 段应剥离内部标签');
        });
    },

    /** system / runtime 分道与 digest 稳定性 */
    async testChannelsAndDigest(): Promise<void> {
        const sections: PromptSection[] = [
            { name: 'core:sys', order: 1, channel: 'system', build: () => 'SYS' },
            { name: 'core:rt', order: 2, channel: 'runtime', build: () => 'RT' },
        ];
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            assert.equal(parts.system, 'SYS');
            assert.equal(parts.runtime, 'RT');
            const again = await assemblePrompt(makeContext());
            assert.equal(parts.digest, again.digest, '相同内容 digest 应稳定');
            assert.match(parts.digest, /^[0-9a-f]{8}$/);
        });
    },

    /** 组装 hook 可整体改写，且失败被忽略 */
    async testAssembleHook(): Promise<void> {
        const sections: PromptSection[] = [{ name: 'core:sys', order: 1, channel: 'system', build: () => 'SYS' }];
        resetPromptHooks();
        onPromptAssemble(parts => ({ system: `${parts.system} + HOOK` }));
        onPromptAssemble(() => {
            throw new Error('hook boom');
        });
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            assert.equal(parts.system, 'SYS + HOOK');
        });
        resetPromptHooks();
    },

    /** 外部插件段：order 抬到 10000+、单段上限、不能覆盖 core 命名 */
    async testExtensionRegistrationRules(): Promise<void> {
        resetPromptSections();
        try {
            assert.equal(registerExtensionSection({ name: 'ext:demo:low', order: 1, channel: 'system', maxChars: 99999, build: () => 'X' }), true);
            const ext = listPromptSections().find(section => section.name === 'ext:demo:low');
            assert.ok(ext, '外部段应注册成功');
            assert.ok(ext!.order >= 10000, '外部段 order 应抬到 10000+');
            assert.equal(ext!.maxChars, 2000, '外部段 maxChars 应被限制在 2000');
            assert.equal(ext!.sanitize, 'external', '外部段默认 external 清洗');

            assert.equal(registerExtensionSection({ name: 'core:evil', order: 1, channel: 'system', build: () => 'X' }), false, '外部段不允许 core: 命名');
            assert.equal(registerExtensionSection({ name: 'not-a-good-name', order: 1, channel: 'system', build: () => 'X' }), false, '非法段名应拒绝');
        } finally {
            restoreBuiltinSections();
        }
    },

    /** 能力地图：按会话已开启工具生成英文域清单；STATUS 关闭或无可用工具时不出现 */
    async testCapabilityMapSection(): Promise<void> {
        ensureConfigRegistered();
        restoreBuiltinSections();
        if (Object.keys(toolMap).length === 0) registerAllTools();

        const toolState: Record<string, boolean> = {};
        for (const name of Object.keys(toolMap)) toolState[name] = true;
        const ctx = {
            isPrivate: false,
            player: { name: 'tester', userId: 'QQ:1' },
            group: { groupId: 'QQ-Group:1', groupName: 'TestGroup' },
            endPoint: { userId: 'QQ:10000' },
        } as any;
        const session = {
            sessionId: 'QQ-Group:1',
            sessionType: 'group',
            toolState,
            skillState: {},
            kbState: {},
            memory: { persona: '' },
            context: { messages: [] },
            setting: null,
        } as any;

        const parts = await buildPromptParts(ctx, session);
        assert.ok(parts.system.includes('## Capabilities'), '应包含能力地图段');
        assert.ok(parts.system.includes('- Memory —'), '应列出 Memory 能力域');
        assert.ok(parts.system.includes('memory_add'), '应给出代表工具名');
        assert.ok(parts.system.includes('before replying that you cannot do it'), '应包含“先查工具再拒绝”的规则');
        assert.ok(!/[\u4e00-\u9fff]/.test(parts.system), '能力地图应为英文');

        const noTools = await buildPromptParts(ctx, { ...session, toolState: {} });
        assert.ok(!noTools.system.includes('## Capabilities'), '无已开启工具时不应出现能力地图');

        const hidden = buildCapabilitiesSection({
            ...makeContext(),
            flags: { ...makeContext().flags, status: false },
        });
        assert.equal(hidden, '', 'STATUS 关闭时能力地图应为空');
    },

    /** 段统计表包含段名与通道 */
    async testRenderSectionTable(): Promise<void> {
        const sections: PromptSection[] = [
            { name: 'core:sys', order: 1, channel: 'system', build: () => 'SYS' },
            { name: 'core:rt', order: 2, channel: 'runtime', build: () => 'RT' },
        ];
        await runWithSections(sections, async () => {
            const parts = await assemblePrompt(makeContext());
            const table = renderSectionTable(parts);
            assert.ok(table.includes('core:sys') && table.includes('core:rt'));
            assert.ok(table.includes('runtime'));
            assert.ok(table.includes(parts.digest));
        });
    },

    /** 内置段整体组装：英文、含预期标题、runtime 段走 runtime 通道、无中文 */
    async testBuiltinPromptAssemblyIsEnglish(): Promise<void> {
        ensureConfigRegistered();
        restoreBuiltinSections();
        const ctx = {
            isPrivate: false,
            player: { name: 'tester', userId: 'QQ:1' },
            group: { groupId: 'QQ-Group:1', groupName: 'TestGroup' },
            endPoint: { userId: 'QQ:10000' },
        } as any;
        const session = {
            sessionId: 'QQ-Group:1',
            sessionType: 'group',
            toolState: {},
            skillState: {},
            kbState: {},
            memory: { persona: '' },
            context: { messages: [] },
            setting: null,
        } as any;

        const parts = await buildPromptParts(ctx, session);
        assert.ok(parts.system.includes('You are an AI dice bot running on SealDice.'), '应包含英文身份段');
        assert.ok(parts.system.includes('## Role'), '应包含英文角色段');
        assert.ok(parts.system.includes('## Response language'), '应包含回复语言约定');
        assert.ok(parts.system.includes('## Session'), '应包含英文会话段');
        assert.ok(parts.system.includes('## Message markers'), '应包含英文消息标记段');
        assert.ok(parts.system.includes('[from:name(ID)]'), '标记示例不应被剥掉（sanitize 只作用于外部段）');
        assert.ok(parts.system.includes('[content-compressed]'), '应说明新的英文标记');
        assert.ok(parts.runtime.includes('## Current time'), '时间应走 runtime 通道');
        assert.ok(!/[\u4e00-\u9fff]/.test(parts.system), 'system 提示词不应包含中文');
        assert.ok(!/[\u4e00-\u9fff]/.test(parts.runtime), 'runtime 文本不应包含中文');
        assert.ok(parts.stats.length >= 8, '内置段应有足够多的段被组装');
        assert.match(parts.digest, /^[0-9a-f]{8}$/);
    },
};
