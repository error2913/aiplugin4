// MCP 工具适配器：把 AI 侧参数/返回映射为远端 MCP 工具调用，保留网页截图、Markdown/HTML 渲染、核心桥指令等既有行为
import Config from "../../config/config";
import { CoreBridgeResult } from "../../integration/core_bridge/types";
import Logger from "../../logger";
import Image from "../../resource/image";
import { Session } from "../../session/session";
import { parseSpecialTokens } from "../../utils/string";
import { generateId } from "../../utils/utils";
import { isAllowedCore, splitEntry, whitelistEntries } from "../command_catalog";
import { resolveCommandTarget } from "../command_target";

import { MCPCallResult } from "./types";

export interface MCPAdapterContext {
    ctx: seal.MsgContext;
    msg: seal.Message;
    session: Session;
    args: { [key: string]: any };
    server: { name: string; url: string; token: string; headers: Record<string, string> };
    toolName: string;
    callRemote: (toolName: string, args: any) => Promise<MCPCallResult>;
}

type MCPAdapter = (input: MCPAdapterContext) => Promise<string>;

/** 提取 MCP 结果中的文本内容（兼容 text 块、structuredContent） */
export function mcpText(result: MCPCallResult | null | undefined): string {
    if (!result) return '';
    const texts = Array.isArray(result.content)
        ? result.content.map(block => (block && typeof block.text === 'string' ? block.text : '')).filter(Boolean)
        : [];
    if (texts.length > 0) return texts.join('\n');
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
        try {
            return JSON.stringify(result.structuredContent);
        } catch (_e) {
            return String(result.structuredContent);
        }
    }
    return '';
}

function normalizeBase64(text: string): string {
    const value = String(text || '').trim();
    if (/^data:[^,]+;base64,/i.test(value)) return value.slice(value.indexOf(',') + 1);
    return value;
}

function looksLikeBase64(text: string): boolean {
    const compact = normalizeBase64(text).replace(/\s+/g, '');
    return compact.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function inferFormat(mimeType?: string): string | undefined {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpeg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return undefined;
}

function saveMCPImage(image: { data: string; mimeType?: string }, prefix = 'mcp'): string {
    const img = new Image();
    img.imageId = `${prefix}_${generateId()}`;
    img.base64 = image.data;
    img.format = inferFormat(image.mimeType) || 'png';
    img.description = `MCP 图片[img:${img.imageId}]`;
    Image.save(img);
    return `成功，请使用[img:${img.imageId}]发送`;
}

/** 提取 MCP 结果中的图片数据；标准 image 块优先，兼容后端以 text 返回 base64 的旧格式 */
export function extractMCPImage(result: MCPCallResult | null | undefined, treatTextAsBase64 = false): { data: string; mimeType?: string } | null {
    const blocks = Array.isArray(result && result.content) ? result!.content! : [];
    for (const block of blocks) {
        if (block && block.type === 'image' && typeof block.data === 'string' && block.data) {
            return { data: normalizeBase64(block.data), mimeType: block.mimeType };
        }
    }
    if (treatTextAsBase64) {
        for (const block of blocks) {
            if (block && typeof block.text === 'string' && looksLikeBase64(block.text)) {
                return { data: normalizeBase64(block.text), mimeType: block.mimeType };
            }
        }
    }
    const structured = result && result.structuredContent;
    if (structured && typeof structured === 'object') {
        const base64 = (structured as any).base64 || (structured as any).data;
        if (typeof base64 === 'string' && looksLikeBase64(base64)) {
            return { data: normalizeBase64(base64), mimeType: (structured as any).mimeType || (structured as any).mime };
        }
    }
    return null;
}

async function defaultText(input: MCPAdapterContext): Promise<string> {
    const result = await input.callRemote(input.toolName, input.args || {});
    const image = extractMCPImage(result, false);
    if (image) return saveMCPImage(image);
    return mcpText(result);
}

async function defaultImage(input: MCPAdapterContext): Promise<string> {
    const result = await input.callRemote(input.toolName, input.args || {});
    const image = extractMCPImage(result, true);
    if (!image) throw new Error(`MCP 工具 ${input.toolName} 未返回图片数据`);
    return saveMCPImage(image);
}

async function transformContentToUrlText(ctx: seal.MsgContext, session: Session, content: string): Promise<{ text: string; images: Image[] }> {
    const segs = parseSpecialTokens(content);
    let text = '';
    const images: Image[] = [];
    for (const seg of segs) {
        switch (seg.type) {
            case 'text': {
                text += seg.content;
                break;
            }
            case 'at': {
                const name = seg.content;
                const ui = await session.context.findUser(ctx, name);
                if (ui !== null) {
                    text += ` @${ui.userName} `;
                } else {
                    Logger.warning(`无法找到用户：${name}`);
                    text += ` @${name} `;
                }
                break;
            }
            case 'img': {
                const id = seg.content;
                // 兼容 [img:imageId:描述]：整体找不到时取首个冒号前作为图片 id
                const image = await session.context.findImage(ctx, id) || (id.includes(':') ? await session.context.findImage(ctx, id.split(':')[0]) : null);
                if (image) {
                    if (image.type === 'local') throw new Error(`图片[img:${id}]为本地图片，暂不支持`);
                    images.push(image);
                    text += image.url;
                } else {
                    Logger.warning(`无法找到图片：${id}`);
                }
                break;
            }
            case 'avatar': {
                const name = seg.content;
                const ui = await session.context.findUser(ctx, name);
                if (ui !== null) {
                    const image = Image.getUserAvatar(ui.userId);
                    images.push(image);
                    text += image.url;
                } else {
                    Logger.warning(`无法找到用户：${name}`);
                }
                break;
            }
            case 'group_avatar': {
                const name = seg.content;
                const gi = await session.context.findGroup(ctx, name);
                if (gi) {
                    const image = Image.getGroupAvatar(gi.groupId);
                    images.push(image);
                    text += image.url;
                } else {
                    Logger.warning(`无法找到群聊：${name}`);
                }
                break;
            }
        }
    }
    return { text, images };
}

async function renderAdapter(input: MCPAdapterContext, kind: 'markdown' | 'html'): Promise<string> {
    const args = input.args || {};
    const source = kind === 'markdown' ? args.markdown : args.html;
    const theme = input.args && input.args.theme || 'light';
    if (!source || !String(source).trim()) return '内容不能为空';
    if (kind === 'markdown' && !['light', 'dark', 'gradient'].includes(theme)) return `无效的主题: ${theme}。支持: light, dark, gradient`;

    try {
        const { text, images } = await transformContentToUrlText(input.ctx, input.session, String(source));
        const hasImages = images.length > 0;
        const remoteArgs = { ...args, [kind]: text, hasImages };
        const result = await input.callRemote(input.toolName, remoteArgs);
        const image = extractMCPImage(result, true);
        if (!image) throw new Error('渲染结果为空');

        const img = new Image();
        img.imageId = `mcp_${kind}_${generateId()}`;
        img.base64 = image.data;
        img.format = inferFormat(image.mimeType) || 'png';
        img.description = kind === 'markdown'
            ? `Markdown 渲染图片[img:${img.imageId}]\n主题：${theme}`
            : `HTML 渲染图片[img:${img.imageId}]`;

        Image.save(img);
        return `成功，请使用[img:${img.imageId}]发送`;
    } catch (err) {
        Logger.error(`${kind === 'markdown' ? 'Markdown' : 'HTML'} 渲染失败: ${err instanceof Error ? err.message : String(err)}`);
        return `渲染图片失败: ${err instanceof Error ? err.message : String(err)}`;
    }
}

async function renderMarkdownAdapter(input: MCPAdapterContext): Promise<string> {
    return renderAdapter(input, 'markdown');
}

async function renderHtmlAdapter(input: MCPAdapterContext): Promise<string> {
    return renderAdapter(input, 'html');
}

function decodeCoreBridgeResult(text: string): CoreBridgeResult {
    try {
        const result = JSON.parse(text);
        if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result as CoreBridgeResult;
    } catch (_e) {
        // MCP 服务端应返回 JSON 文本；保留原文，便于定位不兼容的中间件。
    }
    throw new Error(`核心指令中转返回了无效结果：${text.slice(0, 500)}`);
}

function formatCoreBridgeResult(result: CoreBridgeResult): string {
    if (!result.ok) return `中转执行失败：${result.error || '未知错误'}`;
    const texts = (result.messages || []).map(item => item.text || '').filter(Boolean);
    const body = texts.length ? texts.join('\n') : '核心未返回文本消息';
    const flags = [result.ambiguous ? '消息关联存在歧义' : '', result.completedBy ? `结束方式:${result.completedBy}` : ''].filter(Boolean);
    return `${body}${flags.length ? `\n（${flags.join('，')}）` : ''}`;
}

function captureOptions(args: { [key: string]: any }, defaultMaxMessages: number, defaultSettleMs: number): {
    capture: { mode: 'reply_only' | 'lane'; forward: boolean; maxMessages: number; settleMs: number };
    timeoutMs?: number;
} {
    const forward = !(args && args.forward === false);
    const requestedMode = args && (args.captureMode === 'lane' || args.captureMode === 'reply_only') ? args.captureMode : undefined;
    const maxMessages = Number(args && args.maxMessages);
    const settleMs = Number(args && args.settleMs);
    const timeoutMs = Number(args && args.timeoutMs);
    return {
        capture: {
            mode: requestedMode || (forward ? 'lane' : 'reply_only'),
            forward,
            maxMessages: Number.isFinite(maxMessages) && maxMessages > 0 ? maxMessages : defaultMaxMessages,
            settleMs: Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : defaultSettleMs
        },
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined
    };
}

async function coreBridgeAdapter(input: MCPAdapterContext): Promise<string> {
    const { ctx, args = {} } = input;
    const action = String(args && args.action || '');
    if (action === 'list') {
        const list = whitelistEntries().map(item => splitEntry(item)).filter(item => item && item.extName === 'core').map(item => `core|${item!.cmd}`);
        return `可调用核心指令（共 ${list.length} 个）：\n${list.length ? list.join('\n') : '（除 .ext 外暂无白名单核心指令）'}\n核心扩展发现：使用 action=call、command=ext 查看全部扩展名称`;
    }
    if (action !== 'call') return 'action 仅支持 list 或 call';

    const rawMessage = typeof args.raw_message === 'string' ? args.raw_message : undefined;
    const hasRawMessage = rawMessage !== undefined;
    const hasStructuredArgs = args.command !== undefined || args.args !== undefined;
    if (hasRawMessage && hasStructuredArgs) return 'raw_message 不能与 command/args 同时使用';

    let command = String(args && args.command || '').trim();
    if (command.indexOf('core|') === 0) command = command.slice(5).trim();
    if (!hasRawMessage && !command) return '调用核心指令时 command 不能为空';

    let authorizedCommand = command;
    if (hasRawMessage) {
        const withoutPrefix = rawMessage!.trim().startsWith(Config.tool.COMMAND_PREFIX)
            ? rawMessage!.trim().slice(Config.tool.COMMAND_PREFIX.length).trim()
            : rawMessage!.trim();
        authorizedCommand = withoutPrefix.split(/\s+/, 1)[0].replace(/^core\|/, '').trim();
        if (!authorizedCommand) return '调用核心指令时 raw_message 不能为空';
    }
    if (!isAllowedCore(authorizedCommand)) return `核心指令 core|${authorizedCommand} 不在可调用指令白名单内，无法调用`;

    const cmdArgs = Array.isArray(args && args.args) ? args.args.map(String) : [];
    const commandTarget = resolveCommandTarget(ctx, args);
    if (commandTarget.atUserId && ctx.isPrivate) return '私聊消息不支持 atUserId';
    const options = captureOptions(args, 50, 500);
    if (authorizedCommand === 'ext' && !(args && args.captureMode)) options.capture.mode = 'lane';

    const target: {
        selfId: string;
        messageType: 'private' | 'group';
        userId: string;
        groupId?: string;
    } = {
        selfId: String(ctx.endPoint.userId || '').replace(/^.+:/, ''),
        messageType: ctx.isPrivate ? 'private' : 'group',
        userId: commandTarget.triggerUserId
    };
    if (!ctx.isPrivate) target.groupId = String(ctx.group && ctx.group.groupId || '').replace(/^.+:/, '');

    try {
        const remoteArgs: { [key: string]: any } = {
            action: 'call',
            target,
            actor: {
                userId: commandTarget.triggerUserId || target.selfId,
                nickname: String(ctx.player && ctx.player.name || 'AI'),
                role: 'member'
            },
            maxMessages: options.capture.maxMessages,
            settleMs: options.capture.settleMs,
            captureMode: options.capture.mode,
            forward: options.capture.forward,
            timeoutMs: options.timeoutMs,
            __commandPrefix: Config.tool.COMMAND_PREFIX,
            triggerUserId: commandTarget.triggerUserId,
            ...(commandTarget.atUserId ? { atUserId: commandTarget.atUserId } : {})
        };
        if (hasRawMessage) remoteArgs.raw_message = rawMessage;
        else {
            remoteArgs.command = command;
            remoteArgs.args = cmdArgs;
        }
        const result = await input.callRemote(input.toolName, remoteArgs);
        return `核心指令 core|${authorizedCommand} 返回：\n${formatCoreBridgeResult(decodeCoreBridgeResult(mcpText(result)))}`;
    } catch (e) {
        Logger.warning(`[run_core_command] 调用 core|${authorizedCommand} 失败:${e instanceof Error ? e.message : String(e)}`);
        return `核心指令 core|${authorizedCommand} 调用失败：${e instanceof Error ? e.message : String(e)}`;
    }
}

const ADAPTERS: { [name: string]: MCPAdapter } = {
    screenshot_url: defaultImage,
    render_markdown: renderMarkdownAdapter,
    render_html: renderHtmlAdapter,
    run_core_command: coreBridgeAdapter
};

/** 适配器只负责处理特殊输入/输出；工具定义始终来自 MCP tools/list。 */
export async function runMCPAdapter(name: string | undefined, input: MCPAdapterContext): Promise<string> {
    const adapter = (name && ADAPTERS[name]) || defaultText;
    return adapter(input);
}
