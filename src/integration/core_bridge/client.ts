import Config from "../../config/config";
import { callServerTool, getMCPServerByName } from "../../tool/mcp";
import { CoreBridgeInvocation, CoreBridgeResult } from "./types";

const BRIDGE_SERVER = 'ob11-core-bridge';
let sequence = 0;

function nextId(): string {
    sequence = (sequence + 1) % 100000;
    return `invoke_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

function decodeResult(text: string): CoreBridgeResult {
    try {
        const result = JSON.parse(text);
        if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result as CoreBridgeResult;
    } catch (_) {
        // MCP 服务端应返回 JSON 文本；保留原文，便于定位不兼容的中间件。
    }
    throw new Error(`核心指令中转返回了无效结果：${text.slice(0, 500)}`);
}

export class CoreBridgeClient {
    static reset(): void {
        // MCP 会话由通用 MCP 客户端统一管理；配置热加载时会按服务器配置自动重建会话。
    }

    static async invoke(request: CoreBridgeInvocation, toolName = 'run_ext_command'): Promise<CoreBridgeResult> {
        const server = getMCPServerByName(BRIDGE_SERVER);
        if (!server) throw new Error(`未配置 MCP 服务器 ${BRIDGE_SERVER}；请在「工具 → MCP服务器配置」中添加 ${BRIDGE_SERVER}`);
        const result = await callServerTool(server, toolName, { ...request, id: nextId() });
        return decodeResult(result);
    }

    static async call(
        ctx: seal.MsgContext,
        command: string,
        args: string[],
        capture?: CoreBridgeInvocation['capture'],
        timeoutMs?: number,
        toolName = 'run_ext_command'
    ): Promise<CoreBridgeResult> {
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
        }, toolName);
    }
}

export function formatCoreBridgeResult(result: CoreBridgeResult): string {
    if (!result.ok) return `中转执行失败：${result.error || '未知错误'}`;
    const texts = (result.messages || []).map(item => item.text || '').filter(Boolean);
    const body = texts.length ? texts.join('\n') : '核心未返回文本消息';
    const flags = [result.ambiguous ? '消息关联存在歧义' : '', result.completedBy ? `结束方式:${result.completedBy}` : ''].filter(Boolean);
    return `${body}${flags.length ? `\n（${flags.join('，')}）` : ''}`;
}
