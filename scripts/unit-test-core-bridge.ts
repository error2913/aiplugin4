// 核心桥 standalone 适配单测（S8 / REQ-D6-01、REQ-D7-01~D7-10）：
//
// 为什么单独一个 bundle：这些断言的对照面是「ws_client 的 hello 握手状态机 + 插件侧报文形状」，
// 与按域拆分的主入口无关；假 WebSocket 装在 globalThis 上，独立入口避免污染其它入口。
//
// 覆盖点（对应 01-执行方案.md §6.5 的 12 条）：
// 1. hello_result 早于 requestId 分支被识别（回归 REQ-D7-09 ①）
// 2. hello 超时 3s → 降级 mode:'relay'，后续调用照常（REQ-D7-01/10）
// 3. standalone 下 payload 含 source，字段为真实 ID（无平台前缀）（REQ-D7-02）
// 4. relay 下 payload 不含 source（老桥报文必须逐字不变）
// 5. actor.role 四档映射：100/70/60→owner、50→admin、40/0/-30→member（REQ-D7-03）
// 6. standalone 结果文案不出现 ambiguous/completedBy，relay 保留（REQ-D7-05）
// 7. standalone 条数读 deliveredCount，缺失时按 messages.length 兜底（REQ-D7-05）
// 8. 老桥（hello 无响应）仍用默认 ws://127.0.0.1:46880/plugin 且报文不含 source
// 9. types.ts 新字段可选 + 未知字段不炸 JSON 解析
// 10. closeCoreBridgeWS() 后 hello 缓存在下次连接重建
// 11. pong 与 hello_result 同时到达不串包
// 12. core_command_error 仍走 reject（未因新增分支被吞）
import assert from 'node:assert/strict';

import './test-host';

import Config from '../src/config/config';
import { PRIVILEGE_LEVEL_MAP } from '../src/config/static_config/permission';
import {
    __testHooks,
    callCoreBridgeCommand,
    closeCoreBridgeWS,
    ensureCoreBridgeHello,
    getCoreBridgeHello,
} from '../src/integration/core_bridge/ws_client';
import type { CoreBridgeResult, CoreBridgeWsCommand } from '../src/integration/core_bridge/types';
import { commandActorRole } from '../src/tool/command_target';
import { registerCoreCommandTool } from '../src/tool/tools/core/tool_core_command';

Config.registerConfig();

const TC = (globalThis as any).__TEST_CONFIG__;
const ORIGINAL_WS = (globalThis as any).WebSocket;
const DEFAULT_WS_URL = 'ws://127.0.0.1:46880/plugin';

// ---------------------------------------------------------------------------
// 假 WebSocket：只在 open 后由用例驱动收发，send 时把报文交给「假桥」处理器
// ---------------------------------------------------------------------------
type BridgeHandler = (packet: any, socket: FakeWebSocket) => void;

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static handler: BridgeHandler = () => undefined;

    url: string;
    readyState = 0;
    sent: any[] = [];
    onopen: ((ev?: any) => void) | null = null;
    onclose: ((ev?: any) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onmessage: ((ev?: any) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
        // 真实 WebSocket 的 open 永远是异步的：connect() 先挂 onopen 再等它
        setTimeout(() => this.open(), 0);
    }

    send(raw: any): void {
        const packet = JSON.parse(String(raw));
        this.sent.push(packet);
        FakeWebSocket.handler(packet, this);
    }

    close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.onclose) this.onclose({});
    }

    open(): void {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        if (this.onopen) this.onopen({});
    }

    receive(packet: any): void {
        if (this.onmessage) this.onmessage({ data: JSON.stringify(packet) });
    }
}

interface BridgeOptions {
    /** 桥在 hello 里自称的模式；null = 当作老桥（完全不应答 hello） */
    mode?: 'relay' | 'standalone' | null;
    /** core_command 的正常返回 */
    result?: any;
    /** core_command 的失败返回（走 core_command_error） */
    error?: string;
    /** hello 应答延迟（ms），用于验证 hello_result 真的走了 handleMessage 分支 */
    helloDelayMs?: number;
    /** hello 应答前先插一帧 pong（验证不串包） */
    pongFirst?: boolean;
}

/** 装假桥，返回收集到的待发报文（含 hello 请求，便于断言） */
function installBridge(options: BridgeOptions = {}): any[] {
    const sent: any[] = [];
    FakeWebSocket.instances = [];
    FakeWebSocket.handler = (packet, socket) => {
        sent.push(packet);
        if (packet.type === 'hello') {
            if (!options.mode) return;
            const reply = () => socket.receive({
                type: 'hello_result',
                requestId: packet.requestId,
                payload: {
                    mode: options.mode,
                    platform: 'QQ',
                    corePort: 46880,
                    virtualSelfId: options.mode === 'standalone' ? '10001' : null,
                    virtualNickname: 'AI骰娘',
                    protocolVersion: 'v11',
                    capabilities: options.mode === 'standalone'
                        ? ['virtual-world', 'stable-ids', 'lane-capture', 'local-actions']
                        : ['relay', 'lane-capture'],
                    bridgeVersion: '2.0.0',
                },
            });
            if (options.pongFirst) socket.receive({ type: 'pong' });
            if (options.helloDelayMs) setTimeout(reply, options.helloDelayMs);
            else reply();
            return;
        }
        if (packet.type === 'core_command') {
            if (options.error) socket.receive({ type: 'core_command_error', requestId: packet.requestId, error: options.error });
            else socket.receive({
                type: 'core_command_result',
                requestId: packet.requestId,
                result: options.result ?? { ok: true, messages: [{ text: '假桥结果' }] },
            });
        }
    };
    (globalThis as any).WebSocket = FakeWebSocket;
    return sent;
}

/** 装计数用 OB11 网络桩（relay 路径的昵称查询会走它） */
function installNet(handler: (call: { endpointId: string; action: string; params: any }) => any): any[] {
    const calls: any[] = [];
    (globalThis as any).net = {
        callApi: async (endpointId: string, action: string, params: any) => {
            const call = { endpointId, action, params };
            calls.push(call);
            return handler(call);
        },
    };
    return calls;
}

function resetConfigCache(): void {
    (Config as any).cache = {};
}

/** 每个用例前的基线：清空 ws_client 模块级状态 + 恢复全局 + 可用白名单 */
function resetAll(): void {
    __testHooks.reset();
    delete (globalThis as any).net;
    if (ORIGINAL_WS === undefined) delete (globalThis as any).WebSocket;
    else (globalThis as any).WebSocket = ORIGINAL_WS;
    TC.templateConfigs['可调用指令白名单'] = ['core|roll/r', 'core|ext'];
    TC.stringConfigs['指令前缀'] = '.';
    resetConfigCache();
}

function makeCtx(over: any = {}): seal.MsgContext {
    return {
        endPoint: { userId: 'QQ:10000', platform: 'QQ' },
        group: { groupId: 'QQ-Group:123456', groupName: '测试群' },
        player: { userId: 'QQ:10001', name: '小明' },
        isPrivate: false,
        privilegeLevel: PRIVILEGE_LEVEL_MAP.owner,
        ...over,
    } as unknown as seal.MsgContext;
}

const coreCommandTool = registerCoreCommandTool();

async function runCoreCommand(ctx: seal.MsgContext, args: any): Promise<string> {
    return String(await coreCommandTool.solve(ctx, {} as any, {} as any, args));
}

function coreCommandPackets(sent: any[]): any[] {
    return sent.filter(packet => packet.type === 'core_command');
}

export const tests: Record<string, () => void | Promise<void>> = {
    /** ① hello_result 必须在取 requestId 之前被识别；延迟应答也在同一路径上 */
    async testCoreBridgeHelloResultBeforeRequestId() {
        resetAll();
        try {
            const sent = installBridge({ mode: 'standalone', helloDelayMs: 10 });
            const hello = await ensureCoreBridgeHello();
            assert.equal(hello.mode, 'standalone', 'hello_result 被 pending 分支吞掉会降级成 relay');
            assert.equal(getCoreBridgeHello()!.mode, 'standalone', '握手结果必须缓存');
            assert.equal(sent[0].type, 'hello', '连接后第一帧必须是 hello');
        } finally {
            resetAll();
        }
    },

    /** ② hello 无响应 3s → 降级 relay，且后续 core_command 照常（不抛错、不阻塞） */
    async testCoreBridgeHelloTimeoutDegradesToRelay() {
        resetAll();
        try {
            installBridge({ mode: null, result: { ok: true, messages: [{ text: '老桥结果' }] } });
            const started = Date.now();
            const hello = await ensureCoreBridgeHello();
            const elapsed = Date.now() - started;
            assert.equal(hello.mode, 'relay', '老桥不应答 hello 必须降级 relay');
            assert.ok(elapsed >= 2900, `hello 超时阈值应约为 3s（实际 ${elapsed}ms）`);
            assert.ok(elapsed < 6000, `hello 超时不应明显超过 3s（实际 ${elapsed}ms）`);
            // 降级后第二次调用直接读缓存，不再等 3s
            const again = await ensureCoreBridgeHello();
            assert.equal(again.mode, 'relay', '降级结果必须被缓存');
            const payload: CoreBridgeWsCommand = {
                target: { selfId: '10000', messageType: 'group', groupId: '123456', userId: '10001' },
                actor: { userId: '10001', nickname: '小明', role: 'member' },
                command: { raw: '.roll 1d100', name: 'roll', args: ['1d100'] },
            };
            const result = await callCoreBridgeCommand(payload, 10000);
            assert.equal(result.ok, true, '降级后 core_command 链路必须照常');
            assert.deepEqual(result.messages, [{ text: '老桥结果' }]);
        } finally {
            resetAll();
        }
    },

    /** ③ standalone：payload 增发 source，字段全为真实 ID（无平台前缀） */
    async testCoreBridgeStandaloneSendsSourceWithRealIds() {
        resetAll();
        try {
            const sent = installBridge({
                mode: 'standalone',
                result: { ok: true, mode: 'standalone', deliveredCount: 1, messages: [{ text: '掷骰结果' }] },
            });
            const out = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll', args: ['1d100'] });
            const packets = coreCommandPackets(sent);
            assert.equal(packets.length, 1, '一次调用只应发一帧 core_command');
            const payload = packets[0].payload;
            assert.ok(payload.source, 'standalone 必须增发 source');
            assert.deepEqual(payload.source, {
                endpointId: 'QQ:10000',
                messageType: 'group',
                userId: '10001',
                groupId: '123456',
                groupName: '测试群',
                userRole: 'owner',
            }, 'source 字段口径（真实 ID 直接给桥投影，不带平台前缀）');
            assert.ok(!String(payload.source.userId).includes(':'), 'source.userId 不得带平台前缀');
            assert.ok(!String(payload.source.groupId).includes(':'), 'source.groupId 不得带平台前缀');
            assert.equal(payload.target.messageType, 'group', 'target 保持不变（桥侧投影时覆写）');
            assert.match(out, /掷骰结果/, '结果文本应原样回给 AI');
        } finally {
            resetAll();
        }
    },

    /** ④ relay：payload 绝不含 source（报文必须与 1.1.x 逐字一致） */
    async testCoreBridgeRelaySendsNoSource() {
        resetAll();
        try {
            const sent = installBridge({ mode: 'relay', result: { ok: true, messages: [{ text: 'relay 结果' }] } });
            const calls = installNet(() => ({ card: '群名片-小明', nickname: '小明' }));
            const out = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll', args: ['1d100'] });
            const payload = coreCommandPackets(sent)[0].payload;
            assert.equal(Object.prototype.hasOwnProperty.call(payload, 'source'), false, 'relay 报文不得出现 source 字段');
            assert.equal(payload.target.userId, '10001', 'relay 仍用真实 target.userId');
            assert.equal(payload.target.groupId, '123456', 'relay 仍用真实 target.groupId');
            // relay 保留真实端点昵称查询（standalone 才短路）
            assert.equal(calls.length, 1, 'relay 应查一次真实端点拿昵称');
            assert.equal(calls[0].action, 'get_group_member_info');
            assert.equal(calls[0].params.group_id, '123456');
            assert.equal(calls[0].params.user_id, '10001');
            assert.equal(payload.actor.nickname, '群名片-小明', 'relay 昵称取群名片');
            assert.match(out, /relay 结果/);
        } finally {
            resetAll();
        }
    },

    /** ⑤ actor.role 四档：100/70/60→owner、50→admin、40/0/-30→member（PRIVILEGE_LEVEL_MAP.owner=群主 60） */
    testCoreBridgeActorRoleTiers() {
        assert.equal(PRIVILEGE_LEVEL_MAP.master, 100);
        assert.equal(PRIVILEGE_LEVEL_MAP.whitelist, 70);
        assert.equal(PRIVILEGE_LEVEL_MAP.owner, 60, 'owner 在海豹里是群主（60），不是骰主');
        assert.equal(PRIVILEGE_LEVEL_MAP.admin, 50);
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.master } as any), 'owner', '骰主 100 → owner');
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.whitelist } as any), 'owner', '白名单 70 → owner');
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.owner } as any), 'owner', '群主 60 → owner');
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.admin } as any), 'admin', '群管 50 → admin');
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.inviter } as any), 'member', '邀请者 40 → member');
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.user } as any), 'member', '普通 0 → member');
        assert.equal(commandActorRole({ privilegeLevel: PRIVILEGE_LEVEL_MAP.blacklist } as any), 'member', '黑名单 -30 → member');
        assert.equal(commandActorRole({} as any), 'member', '缺 privilegeLevel 不得抛错');
    },

    /** ⑥ standalone 不显示 ambiguous/completedBy；relay 必须保留（对比断言） */
    async testCoreBridgeStandaloneHidesAmbiguousAndCompletedBy() {
        resetAll();
        try {
            installBridge({
                mode: 'standalone',
                result: { ok: true, mode: 'standalone', deliveredCount: 1, ambiguous: true, completedBy: 'lane', messages: [{ text: '甲' }] },
            });
            const standaloneOut = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.ok(!standaloneOut.includes('消息关联存在歧义'), `standalone 不得出现歧义提示：${standaloneOut}`);
            assert.ok(!standaloneOut.includes('结束方式'), `standalone 不得出现 completedBy：${standaloneOut}`);
            assert.match(standaloneOut, /甲/, '正文必须保留');

            installBridge({
                mode: 'relay',
                result: { ok: true, mode: 'relay', ambiguous: true, completedBy: 'lane', messages: [{ text: '甲' }] },
            });
            const relayOut = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.match(relayOut, /消息关联存在歧义/, 'relay 旧文案必须逐字保留');
            assert.match(relayOut, /结束方式:lane/, 'relay 旧文案必须逐字保留');
        } finally {
            resetAll();
        }
    },

    /** ⑦ standalone 条数读 deliveredCount，缺失时按 messages.length 兜底 */
    async testCoreBridgeStandaloneUsesDeliveredCount() {
        resetAll();
        try {
            installBridge({
                mode: 'standalone',
                result: { ok: true, mode: 'standalone', deliveredCount: 3, messages: [{ text: '一' }] },
            });
            const counted = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.match(counted, /一/, '正文必须保留');
            assert.match(counted, /另有 2 条结果无文本/, `应按 deliveredCount(3) 与文本数(1) 的差额提示：${counted}`);

            installBridge({
                mode: 'standalone',
                result: { ok: true, mode: 'standalone', deliveredCount: 2, messages: [] },
            });
            const empty = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.match(empty, /核心返回了 2 条非文本消息/, `无文本时按 deliveredCount 报条数：${empty}`);

            installBridge({
                mode: 'standalone',
                result: { ok: true, mode: 'standalone', messages: [{ text: '一' }, { text: '二' }] },
            });
            const fallback = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.match(fallback, /一\n二/, '缺 deliveredCount 时按 messages.length 兜底，不额外提示');
            assert.ok(!fallback.includes('另有'), `兜底路径不应出现差额提示：${fallback}`);
        } finally {
            resetAll();
        }
    },

    /** ⑧ 老桥（hello 无响应）：默认 WS 地址不变，且报文退化为 relay 形状 */
    async testCoreBridgeOldBridgeKeepsDefaultWsUrl() {
        resetAll();
        try {
            assert.equal(Config.backend.CORE_BRIDGE_WS_URL, DEFAULT_WS_URL, '默认核心桥地址必须仍是 ws://127.0.0.1:46880/plugin');
            const sent = installBridge({ mode: null, result: { ok: true, messages: [{ text: '老桥结果' }] } });
            const out = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            const socket = FakeWebSocket.instances[0];
            assert.equal(socket.url, DEFAULT_WS_URL, '未配置时应连出厂默认地址');
            const payload = coreCommandPackets(sent)[0].payload;
            assert.equal(Object.prototype.hasOwnProperty.call(payload, 'source'), false, '老桥不得收到 source');
            assert.equal(payload.actor.role, 'owner', 'role 映射与模式无关，老桥同样受益');
            assert.match(out, /老桥结果/);
        } finally {
            resetAll();
        }
    },

    /** ⑨ 新增字段全部可选：额外字段不炸解析，缺省字段不误判（tsc 由编译覆盖） */
    async testCoreBridgeOptionalFieldsJsonSafe() {
        resetAll();
        try {
            // 编译期断言：新字段全可选（缺省合法）
            const legacyResult: CoreBridgeResult = { ok: true, messages: [{ text: 'a' }] };
            const legacyCommand: CoreBridgeWsCommand = {
                target: { selfId: '10000', messageType: 'group', groupId: '123456' },
                actor: { userId: '10001', nickname: '小明', role: 'member' },
            };
            assert.equal(legacyResult.mode, undefined);
            assert.equal(legacyCommand.source, undefined);

            installBridge({
                mode: 'standalone',
                result: {
                    ok: true,
                    mode: 'standalone',
                    deliveredCount: 2,
                    virtualTarget: { selfId: '10001', messageType: 'group', groupId: '20002' },
                    forwardedCount: 0,
                    interceptedCount: 0,
                    unknownFutureField: { nested: [1, 2, 3] },
                    messages: [{ text: '带全字段' }],
                },
            });
            const full = await callCoreBridgeCommand(legacyCommand, 10000);
            assert.equal(full.ok, true);
            assert.equal(full.deliveredCount, 2, 'deliveredCount 必须透传');
            assert.deepEqual(full.virtualTarget, { selfId: '10001', messageType: 'group', groupId: '20002' });
            assert.equal(full.mode, 'standalone');
            assert.deepEqual((full as any).unknownFutureField, { nested: [1, 2, 3] }, '未知字段原样透传，不影响解析');

            installBridge({ mode: 'relay', result: { ok: true } });
            const minimal = await callCoreBridgeCommand(legacyCommand, 10000);
            assert.equal(minimal.ok, true);
            assert.equal(minimal.mode, undefined, '老桥不返回 mode 时保持 undefined（按 relay 渲染）');
            assert.equal(minimal.deliveredCount, undefined);
            assert.equal(minimal.messages, undefined);
        } finally {
            resetAll();
        }
    },

    /** ⑩ closeCoreBridgeWS() 清缓存，下次连接重新握手（模式可以变化） */
    async testCoreBridgeHelloCacheRebuiltAfterClose() {
        resetAll();
        try {
            installBridge({ mode: 'standalone' });
            assert.equal((await ensureCoreBridgeHello()).mode, 'standalone');
            closeCoreBridgeWS();
            assert.equal(getCoreBridgeHello(), null, '主动关闭后 hello 缓存必须作废');
            // 桥换成了 relay（升级/降级场景）：重连必须重新握手，不能吃旧缓存
            FakeWebSocket.handler = (packet, socket) => {
                if (packet.type !== 'hello') return;
                socket.receive({ type: 'hello_result', requestId: packet.requestId, payload: { mode: 'relay' } });
            };
            assert.equal((await ensureCoreBridgeHello()).mode, 'relay', '重连后必须按新握手结果覆盖缓存');
            assert.equal(FakeWebSocket.instances.length, 2, '重连应新建一条连接');
        } finally {
            resetAll();
        }
    },

    /** ⑪ pong 与 hello_result 同时到达不串包：hello 走握手分支，core_command 结果仍按 requestId 命中 */
    async testCoreBridgePongAndHelloNoCrossTalk() {
        resetAll();
        try {
            const sent = installBridge({
                mode: 'standalone',
                pongFirst: true,
                result: { ok: true, mode: 'standalone', deliveredCount: 1, messages: [{ text: '不串包结果' }] },
            });
            const out = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.ok(getCoreBridgeHello(), 'pong 之后仍应完成握手');
            assert.equal(getCoreBridgeHello()!.mode, 'standalone', 'pong 不应把 hello_result 顶掉');
            const packets = coreCommandPackets(sent);
            assert.equal(packets.length, 1);
            assert.equal(typeof packets[0].requestId, 'string');
            assert.ok(packets[0].requestId.startsWith('core_'), 'core_command 的 requestId 前缀');
            assert.match(out, /不串包结果/, 'core_command 结果必须按自己的 requestId 命中');
        } finally {
            resetAll();
        }
    },

    /** ⑫ core_command_error 仍走 reject（未因 hello 分支被吞） */
    async testCoreBridgeCoreCommandErrorRejects() {
        resetAll();
        try {
            installBridge({ mode: 'standalone', error: 'bridge-boom-42' });
            await assert.rejects(
                () => callCoreBridgeCommand({
                    target: { selfId: '10000', messageType: 'group', groupId: '123456' },
                    actor: { userId: '10001', nickname: '小明', role: 'member' },
                }, 10000),
                /bridge-boom-42/,
                'core_command_error 必须 reject 出桥侧错误文案'
            );
            const out = await runCoreCommand(makeCtx(), { action: 'call', command: 'roll' });
            assert.match(out, /调用失败：bridge-boom-42/, `工具层应把桥侧错误转成失败文案：${out}`);
        } finally {
            resetAll();
        }
    },
};
