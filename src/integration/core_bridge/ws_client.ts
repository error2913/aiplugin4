// 核心桥 WebSocket 客户端：aiplugin4 直接连接 ob11-core-bridge /plugin，
// 不再经过 MCP。每次调用时若连接未就绪都会尝试重连。
import Config from "../../config/config";
import Logger from "../../logger";

import { CoreBridgeResult, CoreBridgeWsCommand } from "./types";

const log = Logger.withTag('core_bridge');

interface PendingRequest {
    resolve: (result: CoreBridgeResult) => void;
    reject: (error: Error) => void;
    timer: any;
}

const WS_OPEN = 1;


let ws: WebSocket | null = null;
let connecting: Promise<void> | null = null;
let requestSeq = 0;
const pending = new Map<string, PendingRequest>();

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

function handleMessage(data: unknown): void {
    let packet: any;
    try {
        packet = JSON.parse(String(data));
    } catch (_e) {
        return;
    }
    if (!packet || typeof packet !== 'object') return;
    if (packet.type === 'pong') return;

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
        if (ws === socket) ws = null;
        const error = new Error('核心桥 WebSocket 连接已断开');
        rejectAll(error);
    };
    socket.onerror = () => {
        // close 事件统一处理失败与清理
    };
}

function connect(): Promise<void> {
    if (ws && ws.readyState === WS_OPEN) return Promise.resolve();
    if (connecting) return connecting;
    if (typeof WebSocket === 'undefined') {
        return Promise.reject(new Error('当前环境不支持 WebSocket'));
    }

    connecting = new Promise<void>((resolve, reject) => {
        let socket: WebSocket;
        try {
            socket = new WebSocket(buildUrl());
        } catch (e) {
            connecting = null;
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }

        socket.onopen = () => {
            ws = socket;
            attachHandlers(socket);
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

/** 调用核心桥执行命令；连接未建立时自动重连。 */
export async function callCoreBridgeCommand(
    payload: CoreBridgeWsCommand,
    timeoutMs = 10000
): Promise<CoreBridgeResult> {
    await connect();
    if (!ws || ws.readyState !== WS_OPEN) {
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

/** 主动断开（热重载/停用时调用），下次调用会自动重连。 */
export function closeCoreBridgeWS(): void {
    if (ws) {
        const socket = ws;
        ws = null;
        try {
            socket.close();
        } catch (_e) {
            // ignore
        }
    }
    rejectAll(new Error('核心桥 WebSocket 已主动关闭'));
    log.debug('核心桥 WebSocket 已主动关闭');
}
