// 核心桥 WebSocket 客户端：aiplugin4 直接连接 ob11-core-bridge /plugin，
// 不再经过 MCP。每次调用时若连接未就绪都会尝试重连。
//
// 连上后先做一次 `hello` 握手判断桥的形态（REQ-D7-01）：
// - `mode === 'standalone'` → 桥是独立 OB11 协议端，真实 ID 必须走 `source` 投影；
// - `mode === 'relay'`（含老桥无应答） → 报文与 1.1.x 完全一致，仍用真实 `target`。
// hello 超时 3s 且**不进** pending（pending 是 core_command 的 10s 链路，REQ-D7-10），
// 失败只降级不抛错，绝不阻塞首次调用。
import Config from "../../config/config";
import Logger from "../../logger";

import { CoreBridgeHello, CoreBridgeResult, CoreBridgeWsCommand } from "./types";

const log = Logger.withTag('core_bridge');

interface PendingRequest {
    resolve: (result: CoreBridgeResult) => void;
    reject: (error: Error) => void;
    timer: any;
}

const WS_OPEN = 1;
/** hello 握手独立的超时（与 core_command 的 10s 解耦，REQ-D7-10） */
const HELLO_TIMEOUT_MS = 3000;
const DEGRADED_HELLO: CoreBridgeHello = { mode: 'relay' };


let ws: WebSocket | null = null;
let connected = false;

let connecting: Promise<void> | null = null;
let requestSeq = 0;
const pending = new Map<string, PendingRequest>();

// ---- hello 握手状态（每次连接一份，断线/主动关闭后作废） ----
let hello: CoreBridgeHello | null = null;
let helloPromise: Promise<CoreBridgeHello> | null = null;
let helloRequestId = '';
let helloSeq = 0;
let helloResolve: ((value: CoreBridgeHello) => void) | null = null;
let helloTimer: any = null;

/** WebSocket 构造器：Node/浏览器取全局，测试可注入假实现（不引入新的并发入口）。 */
function webSocketCtor(): any {
    return (globalThis as any).WebSocket;
}

function buildUrl(): string {
    const url = Config.backend.CORE_BRIDGE_WS_URL || 'ws://127.0.0.1:46880/plugin';
    const token = Config.backend.CORE_BRIDGE_TOKEN || '';
    if (!token) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}

function rejectAll(error: Error): void {
    for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
    }
    pending.clear();
}

/** 解析 hello_result.payload；未知/残缺字段一律按 relay 语义兜底，不抛错。 */
function parseHelloPayload(payload: any): CoreBridgeHello {
    const result: CoreBridgeHello = { mode: payload && payload.mode === 'standalone' ? 'standalone' : 'relay' };
    if (!payload || typeof payload !== 'object') return result;
    if (typeof payload.platform === 'string' && payload.platform) result.platform = payload.platform;
    if (typeof payload.corePort === 'number' && Number.isFinite(payload.corePort)) result.corePort = payload.corePort;
    if (payload.virtualSelfId !== undefined) {
        result.virtualSelfId = payload.virtualSelfId === null ? null : String(payload.virtualSelfId);
    }
    if (typeof payload.virtualNickname === 'string' && payload.virtualNickname) result.virtualNickname = payload.virtualNickname;
    if (typeof payload.protocolVersion === 'string' && payload.protocolVersion) result.protocolVersion = payload.protocolVersion;
    if (Array.isArray(payload.capabilities)) result.capabilities = payload.capabilities.map((item: any) => String(item));
    if (typeof payload.bridgeVersion === 'string' && payload.bridgeVersion) result.bridgeVersion = payload.bridgeVersion;
    return result;
}

function clearHelloTimer(): void {
    if (helloTimer === null) return;
    try {
        clearTimeout(helloTimer);
    } catch (_e) {
        // 忽略：清理失败不影响结果
    }
    helloTimer = null;
}

/** 结束本次握手：缓存结果并唤醒等待者（超时/失败也走这里，只降级不抛错）。 */
function settleHello(next: CoreBridgeHello): void {
    clearHelloTimer();
    hello = next;
    const resolve = helloResolve;
    helloResolve = null;
    if (resolve) resolve(next);
}

/** 连接断开：握手结果作废，下次连接重发 hello；等待者按 relay 语义放行，不阻塞。 */
function resetHello(): void {
    clearHelloTimer();
    hello = null;
    helloPromise = null;
    helloRequestId = '';
    const resolve = helloResolve;
    helloResolve = null;
    if (resolve) resolve(DEGRADED_HELLO);
}

/** 连接建立后立即发 hello；超时 3s 降级 relay，不进 pending Map（REQ-D7-10）。 */
function sendHello(socket: WebSocket): void {
    if (!socket) {
        settleHello(DEGRADED_HELLO);
        return;
    }
    const requestId = `hello_${Date.now()}_${++helloSeq}`;
    helloRequestId = requestId;
    helloPromise = new Promise<CoreBridgeHello>(resolve => {
        helloResolve = resolve;
        helloTimer = setTimeout(() => {
            helloTimer = null;
            if (hello) return;
            log.debug(`核心桥 hello 未在 ${HELLO_TIMEOUT_MS}ms 内应答，按 relay 语义继续（老桥向后兼容）`);
            settleHello(DEGRADED_HELLO);
        }, HELLO_TIMEOUT_MS);
        try {
            socket.send(JSON.stringify({ type: 'hello', requestId }));
        } catch (e) {
            log.debug(`核心桥 hello 发送失败，按 relay 语义继续：${e instanceof Error ? e.message : String(e)}`);
            settleHello(DEGRADED_HELLO);
        }
    });
}

function handleMessage(data: unknown): void {
    let packet: any;
    try {
        packet = JSON.parse(String(data));
    } catch (_e) {
        return;
    }
    if (!packet || typeof packet !== 'object') return;
    if (packet.type === 'pong') return;
    // hello_result 必须在取 requestId 之前分支：它不进 pending Map，
    // 否则会被下面"取不到 pending 就 return"静默丢弃（REQ-D7-09 ①）。
    if (packet.type === 'hello_result') {
        const requestId = String(packet.requestId || '');
        // 迟到的 hello_result 也接收（超时已降级时按真实模式升级），但不能串到别的连接上。
        if (requestId && helloRequestId && requestId !== helloRequestId) return;
        const next = parseHelloPayload(packet.payload);
        log.debug(`核心桥 hello 握手完成：mode=${next.mode}`);
        settleHello(next);
        return;
    }

    const requestId = String(packet.requestId || '');
    const request = requestId ? pending.get(requestId) : undefined;
    if (!request) return;

    if (packet.type === 'core_command_result') {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.resolve(packet.result as CoreBridgeResult);
    } else if (packet.type === 'core_command_error') {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(new Error(String(packet.error || '核心桥执行失败')));
    }
}

function attachHandlers(socket: WebSocket): void {
    socket.onmessage = event => handleMessage((event as any).data);
    socket.onclose = () => {
        // 旧连接迟到的 close 不得清掉新连接的连接态/握手结果
        if (ws !== socket) return;
        ws = null;
        connected = false;
        resetHello();
        rejectAll(new Error('核心桥 WebSocket 连接已断开'));
    };
    socket.onerror = () => {
        // close 事件统一处理失败与清理
    };
}

function connect(): Promise<void> {
    if (ws && connected && ws.readyState === WS_OPEN) return Promise.resolve();
    if (connecting) return connecting;
    const Ctor = webSocketCtor();
    if (typeof Ctor !== 'function') {
        return Promise.reject(new Error('当前环境不支持 WebSocket'));
    }

    // 构造失败要在赋值 connecting 之前返回，否则 connecting 会被替换成已 reject 的 promise 并永久复用
    let socket: WebSocket;
    try {
        socket = new Ctor(buildUrl());
    } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }

    connecting = new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
            ws = socket;
            connected = true;
            attachHandlers(socket);
            sendHello(socket);
            connecting = null;
            resolve();
        };
        socket.onerror = () => {
            // 等待 close，避免重复 reject
        };
        socket.onclose = () => {
            if (connecting) {
                connecting = null;
                reject(new Error('核心桥 WebSocket 连接失败'));
            }
        };
    });

    return connecting;
}

/** 已缓存的握手结果；从未握手/已断线时为 null（调用方按 relay 语义兜底）。 */
export function getCoreBridgeHello(): CoreBridgeHello | null {
    return hello;
}

/**
 * 确保握手完成并返回桥的形态（REQ-D7-01）。
 *
 * 连接失败/桥不响应时**不抛错**，只返回 relay 兜底——真正的连接错误由
 * `callCoreBridgeCommand` 在后续发送时抛出，避免 hello 改变既有失败语义。
 */
export async function ensureCoreBridgeHello(): Promise<CoreBridgeHello> {
    try {
        await connect();
    } catch (e) {
        log.debug(`核心桥连接失败，按 relay 语义继续：${e instanceof Error ? e.message : String(e)}`);
        return hello || DEGRADED_HELLO;
    }
    if (hello) return hello;
    if (helloPromise) return helloPromise;
    return hello || DEGRADED_HELLO;
}

/** 调用核心桥执行命令；连接未建立时自动重连。 */
export async function callCoreBridgeCommand(
    payload: CoreBridgeWsCommand,
    timeoutMs = 10000
): Promise<CoreBridgeResult> {
    await connect();
    if (!ws || !connected || ws.readyState !== WS_OPEN) {
        throw new Error('核心桥 WebSocket 未连接');
    }

    const requestId = `core_${Date.now()}_${++requestSeq}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<CoreBridgeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`核心桥请求超时(${timeoutMs}ms)`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
            ws!.send(JSON.stringify({ type: 'core_command', requestId, payload }));
        } catch (e) {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

/** 单测钩子：清空全部模块级状态（连接/待处理请求/握手缓存），避免用例间互相污染。 */
export const __testHooks = {
    reset(): void {
        if (ws) {
            const socket = ws;
            ws = null;
            try {
                socket.close();
            } catch (_e) {
                // ignore
            }
        }
        connected = false;
        connecting = null;
        pending.clear();
        requestSeq = 0;
        helloSeq = 0;
        resetHello();
    },
};

/** 主动断开（热重载/停用时调用），下次调用会自动重连并重新握手。 */
export function closeCoreBridgeWS(): void {
    if (ws) {
        const socket = ws;
        ws = null;
        connected = false;
        try {
            socket.close();
        } catch (_e) {
            // ignore
        }
    }
    resetHello();
    rejectAll(new Error('核心桥 WebSocket 已主动关闭'));
    log.debug('核心桥 WebSocket 已主动关闭');
}
