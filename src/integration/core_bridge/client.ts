import Config from "../../config/config";
import { CoreBridgeInvocation, CoreBridgeResult } from "./types";

const WS_OPEN = 1;
let sequence = 0;

function getWebSocket(): any {
    const ctor = (globalThis as any).WebSocket;
    if (typeof ctor !== 'function') throw new Error('当前海豹环境没有可用的 WebSocket；请安装支持 WebSocket 的 ob11 网络连接依赖');
    return ctor;
}

function nextId(): string {
    sequence = (sequence + 1) % 100000;
    return `invoke_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

export class CoreBridgeClient {
    private static ws: any = null;
    private static connecting: Promise<any> | null = null;
    private static pending: { [id: string]: { resolve: (result: CoreBridgeResult) => void, reject: (error: Error) => void, timer: any } } = {};

    static reset(): void {
        this.failPending(new Error('核心指令中转 WS 已重置'));
        if (this.ws && typeof this.ws.close === 'function') {
            try { this.ws.close(); } catch (_) { /* ignore */ }
        }
        this.ws = null;
        this.connecting = null;
    }

    private static failPending(error: Error): void {
        const pending = this.pending;
        this.pending = {};
        Object.keys(pending).forEach(id => {
            clearTimeout(pending[id].timer);
            pending[id].reject(error);
        });
    }

    private static async connect(): Promise<any> {
        const configuredUrl = Config.backend.CORE_BRIDGE_WS;
        if (!configuredUrl) throw new Error('未配置「后端 → 核心指令中转WS地址」');
        if (this.ws && this.ws.readyState === WS_OPEN) return this.ws;
        if (this.connecting) return this.connecting;
        const WebSocketCtor = getWebSocket();
        const configuredToken = Config.backend.CORE_BRIDGE_TOKEN;
        const url = configuredToken
            ? `${configuredUrl}${configuredUrl.indexOf('?') >= 0 ? '&' : '?'}access_token=${encodeURIComponent(configuredToken)}`
            : configuredUrl;
        this.connecting = new Promise((resolve, reject) => {
            let settled = false;
            const ws = new WebSocketCtor(url);
            const fail = (error: Error) => {
                if (!settled) { settled = true; reject(error); }
                this.failPending(error);
                if (this.ws === ws) this.ws = null;
            };
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    type: 'hello', protocol: 'aiplugin4-core-bridge', version: 1,
                    client: 'aiplugin4', token: Config.backend.CORE_BRIDGE_TOKEN
                }));
            };
            ws.onmessage = (event: any) => {
                let packet: any;
                try { packet = JSON.parse(String(event && event.data !== undefined ? event.data : event)); }
                catch (_) { return; }
                if (packet.type === 'hello.ok') {
                    settled = true; this.ws = ws; resolve(ws); return;
                }
                if (packet.type === 'command.result' && packet.id) {
                    const waiter = this.pending[String(packet.id)];
                    if (!waiter) return;
                    clearTimeout(waiter.timer); delete this.pending[String(packet.id)]; waiter.resolve(packet as CoreBridgeResult);
                }
            };
            ws.onerror = () => fail(new Error('核心指令中转 WS 连接失败'));
            ws.onclose = () => {
                const error = new Error('核心指令中转 WS 已断开');
                this.failPending(error);
                if (this.ws === ws) this.ws = null;
                if (!settled) fail(error);
            };
        }).then(value => { this.connecting = null; return value; }, error => { this.connecting = null; throw error; });
        return this.connecting;
    }

    static async invoke(request: CoreBridgeInvocation): Promise<CoreBridgeResult> {
        const ws = await this.connect();
        const id = nextId();
        const timeoutMs = Math.max(1000, Math.min(Number(request.timeoutMs || 10000), 120000));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this.pending[id]; reject(new Error(`核心指令等待超时（${timeoutMs}ms）`));
            }, timeoutMs + 1000);
            this.pending[id] = { resolve, reject, timer };
            try {
                ws.send(JSON.stringify({ type: 'command.invoke', id, ...request, timeoutMs }));
            } catch (e) {
                clearTimeout(timer); delete this.pending[id]; reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    static async call(ctx: seal.MsgContext, command: string, args: string[], capture?: CoreBridgeInvocation['capture'], timeoutMs?: number): Promise<CoreBridgeResult> {
        const prefix = Config.tool.COMMAND_PREFIX;
        const raw = `${prefix}${command}${args.length ? ` ${args.join(' ')}` : ''}`.trim();
        const target: CoreBridgeInvocation['target'] = {
            selfId: String(ctx.endPoint.userId || '').replace(/^.+:/, ''),
            messageType: ctx.isPrivate ? 'private' : 'group',
            userId: String(ctx.player && ctx.player.userId || '').replace(/^.+:/, '')
        };
        if (!ctx.isPrivate) target.groupId = String(ctx.group && ctx.group.groupId || '').replace(/^.+:/, '');
        return this.invoke({
            target,
            actor: {
                userId: target.userId || target.selfId,
                nickname: String(ctx.player && ctx.player.name || 'AI'),
                role: 'member'
            },
            command: { raw, name: command, args },
            capture,
            timeoutMs
        });
    }
}

export function formatCoreBridgeResult(result: CoreBridgeResult): string {
    if (!result.ok) return `中转执行失败：${result.error || '未知错误'}`;
    const texts = (result.messages || []).map(item => item.text || '').filter(Boolean);
    const body = texts.length ? texts.join('\n') : '核心未返回文本消息';
    const flags = [result.ambiguous ? '消息关联存在歧义' : '', result.completedBy ? `结束方式:${result.completedBy}` : ''].filter(Boolean);
    return `${body}${flags.length ? `\n（${flags.join('，')}）` : ''}`;
}
