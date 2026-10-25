// `.ai ctx` 命令逻辑：解析、执行、用户可读短文本。
// 只依赖 ContextService/admin/运行时；权限与回复投递在 cmd 层。
import Config from "../config/config";

import { contextStats, hideEvents, HideTarget, purgeSession, repairHead } from "./admin";
import type { CompactionRuntime } from "./compact/runtime";
import type { ContextService } from "./service";
import { applyVisibility, buildRecordIndex } from "./view/records";

export type CtxAction = 'status' | 'archive' | 'hide' | 'purge' | 'set' | 'name' | 'repair' | 'help';

export interface ParsedCtxCommand {
    action: CtxAction;
    target?: HideTarget;
    confirmed?: boolean;
    budget?: number;
    clear?: boolean;
    nameArgs?: string[];
    helpTopic?: string;
    error?: string;
}

export interface CtxSessionLike {
    setting?: { overrides?: Record<string, unknown> };
    save?(): void;
    context: {
        autoNameMod: number;
        userInfoList: Array<{ id: string; name: string }>;
        setName(epId: string, gid: string, uid: string, mod: 'nickname' | 'card'): Promise<void>;
    };
}

const HIDE_TARGETS: readonly HideTarget[] = ['user', 'assistant', 'all'];
const HIDE_LABEL: Record<HideTarget, string> = { user: '用户消息', assistant: 'AI 回复与工具记录', all: '全部消息' };

const HELP = [
    '用法：.ai ctx [子命令]',
    '  （无参数）              查看上下文状态',
    '  archive                 整理更早内容（保留原文，可回查）',
    '  hide [user|assistant|all]  隐藏消息（原文保留，可审计）',
    '  purge --yes             清除本会话上下文（不可恢复，仅骰主）',
    '  set [budget=<tokens>|clr]  本会话上下文预算（仅邀请者）',
    '  name status|set nick|card|mod <0-2>  上下文名字（仅邀请者）',
    '  repair                  检查并修复上下文索引',
    '  help [子命令]           查看帮助',
].join('\n');

export function ctxHelpText(): string {
    return HELP;
}

const TOPIC_HELP: Record<string, string> = {
    status: '【.ai ctx status】查看当前上下文消息数、整理进度与最近一次整理结果。',
    archive: '【.ai ctx archive】立即整理更早内容；只生成摘要，不删除原文，不写长期记忆。',
    hide: '【.ai ctx hide [user|assistant|all]】隐藏消息：模型与检索不可见，原文保留供审计。',
    purge: '【.ai ctx purge --yes】物理清除本会话上下文，不可恢复；需要骰主并显式加 --yes。默认不影响长期记忆。',
    set: '【.ai ctx set [budget=<tokens>|clr]】本会话覆盖上下文预算；budget=0 表示跟随模型窗口，clr 恢复默认。',
    name: '【.ai ctx name status】查看名字；【.ai ctx name set nick|card】按昵称/群名片更新；【.ai ctx name mod 0|1|2】自动修改规则。',
    repair: '【.ai ctx repair】检查并修复上下文索引（异常时使用）。',
};

export function parseCtxCommand(args: readonly string[]): ParsedCtxCommand {
    const argv = (args || []).map(a => String(a || '').trim()).filter(Boolean);
    if (argv.length === 0) return { action: 'status' };
    const head = argv[0].toLowerCase();
    const rest = argv.slice(1);
    if (head === 'help' || head === '-h' || head === '--help') return { action: 'help', helpTopic: rest[0]?.toLowerCase() };
    if (rest[0]?.toLowerCase() === 'help' || rest.includes('--help') || rest.includes('-h')) return { action: 'help', helpTopic: head };
    if (head === 'status') return { action: 'status' };
    if (head === 'archive' || head === 'settle') return { action: 'archive' };
    if (head === 'repair') return { action: 'repair' };
    if (head === 'hide') {
        const raw = (rest[0] || 'all').toLowerCase();
        const target = (HIDE_TARGETS as readonly string[]).includes(raw) ? raw as HideTarget : null;
        if (!target) return { action: 'help', error: `hide 只能选择 ${HIDE_TARGETS.join('/')}` };
        return { action: 'hide', target };
    }
    if (head === 'purge') return { action: 'purge', confirmed: rest.includes('--yes') || rest.includes('-y') };
    if (head === 'set') {
        if (rest.some(item => ['clr', 'clear', 'reset'].includes(item.toLowerCase()))) return { action: 'set', clear: true };
        let budget: number | undefined;
        for (const item of rest) {
            const m = /^budget=(-?\d+)$/i.exec(item);
            if (m) budget = Number(m[1]);
        }
        if (budget === undefined) return { action: 'help', error: 'set 需要 budget=<tokens> 或 clr' };
        return { action: 'set', budget };
    }
    if (head === 'name') return { action: 'name', nameArgs: rest };
    return { action: 'help', error: `未知子命令：${head}` };
}

export interface CtxCommandInput {
    sessionId: string;
    service: ContextService;
    args: readonly string[];
    session?: CtxSessionLike;
    epId?: string;
    gid?: string;
    runtime?: CompactionRuntime | null;
    now?: () => number;
}

export interface CtxCommandResult {
    text: string;
    changed?: boolean;
    needsConfirm?: boolean;
    /** purge 后调用方需要重建 ContextService（旧存储已置空，内存中的事件/head 不能继续用） */
    purged?: boolean;
}

function helpText(topic?: string, error?: string): string {
    const body = topic && TOPIC_HELP[topic] ? TOPIC_HELP[topic] : HELP;
    return error ? `${error}\n\n${body}` : body;
}

/** 状态：只给用户需要的信息，不暴露 seq/epoch/页数等内部结构 */
export function formatCtxStatus(input: CtxCommandInput): string {
    const stats = contextStats(input.service.getStore());
    const snapshot = input.service.snapshot();
    const visible = applyVisibility(snapshot.events, buildRecordIndex(snapshot.records)).length;
    const lines = [`上下文：共 ${visible} 条消息`];
    const override = input.session?.setting?.overrides?.ctxBudgetTokens;
    const budget = typeof override === 'number' && override > 0 ? override : Config.context.BUDGET_TOKENS;
    lines.push(budget > 0 ? `预算：约 ${budget} token` : '预算：跟随模型窗口');
    lines.push(stats.summarizedThrough > 0 ? '更早内容：已整理为摘要（原文仍可回查）' : '更早内容：暂未整理');
    if (stats.unsummarizedTokens > 0) lines.push(`待整理：约 ${stats.unsummarizedTokens} token`);
    const last = input.runtime?.getLastResult();
    if (last) {
        lines.push(`最近整理：${last.advanced ? '成功' : '未完成'}`);
    }
    lines.push('提示：.ai ctx help 查看全部用法');
    return lines.join('\n');
}

async function setNameForAll(input: CtxCommandInput, mode: 'nickname' | 'card'): Promise<CtxCommandResult> {
    const session = input.session;
    if (!session) return { text: '当前会话不支持名字设置' };
    const names = session.context.userInfoList;
    await Promise.all(names.map(ui => session.context.setName(input.epId ?? '', input.gid ?? '', ui.id, mode)));
    const after = session.context.userInfoList.map(ui => `${ui.name}(${ui.id})`).join('\n');
    return { text: `已按${mode === 'nickname' ? '昵称' : '群名片'}更新上下文名字：\n${after}`, changed: true };
}

async function runName(input: CtxCommandInput, args: string[]): Promise<CtxCommandResult> {
    const session = input.session;
    if (!session) return { text: '当前会话不支持名字设置' };
    const sub = (args[0] ?? 'status').toLowerCase();
    if (sub === 'status') {
        const names = session.context.userInfoList.map(ui => `${ui.name}(${ui.id})`).join('\n') || '（暂无）';
        const mode = session.context.autoNameMod === 0 ? '不自动修改' : (session.context.autoNameMod === 1 ? '自动改为昵称' : '自动改为群名片');
        return { text: `上下文名字：\n${names}\n自动修改：${mode}` };
    }
    if (sub === 'set') {
        const mode = (args[1] ?? '').toLowerCase();
        if (mode !== 'nick' && mode !== 'nickname' && mode !== 'card') return { text: helpText('name') };
        try {
            return await setNameForAll(input, mode === 'card' ? 'card' : 'nickname');
        } catch {
            return { text: '更新上下文名字失败，请查看日志' };
        }
    }
    if (sub === 'mod') {
        const mod = Number(args[1]);
        if (![0, 1, 2].includes(mod)) return { text: helpText('name') };
        session.context.autoNameMod = mod;
        session.save?.();
        return { text: `已设置：${mod === 0 ? '不自动修改' : mod === 1 ? '自动改为昵称' : '自动改为群名片'}`, changed: true };
    }
    return { text: helpText('name') };
}

function runSet(input: CtxCommandInput, parsed: ParsedCtxCommand): CtxCommandResult {
    const session = input.session;
    if (!session) return { text: '当前会话不支持设置' };
    if (!session.setting) session.setting = {};
    if (!session.setting.overrides) session.setting.overrides = {};
    if (parsed.clear) {
        delete session.setting.overrides.ctxBudgetTokens;
        session.save?.();
        return { text: '已恢复本会话默认上下文设置', changed: true };
    }
    if (parsed.budget !== undefined) {
        if (parsed.budget < 0) return { text: 'budget 必须是非负整数（0=跟随模型窗口）' };
        if (parsed.budget === 0) delete session.setting.overrides.ctxBudgetTokens;
        else session.setting.overrides.ctxBudgetTokens = parsed.budget;
    }
    session.save?.();
    return { text: '已更新本会话上下文设置', changed: true };
}

export async function runCtxCommand(input: CtxCommandInput): Promise<CtxCommandResult> {
    const parsed = parseCtxCommand(input.args);
    switch (parsed.action) {
        case 'status':
            return { text: formatCtxStatus(input) };
        case 'help':
            return { text: helpText(parsed.helpTopic, parsed.error) };
        case 'archive': {
            if (!input.runtime) return { text: '暂时无法整理：摘要服务不可用' };
            const result = await input.runtime.archiveNow();
            return result.advanced
                ? { text: '已整理更早内容；原文仍然保留，可随时回查', changed: true }
                : { text: '本次没有需要整理的内容' };
        }
        case 'hide': {
            const target = parsed.target ?? 'all';
            hideEvents(input.service.getStore(), target, input.now ? input.now() : undefined);
            const flushed = await input.service.flush();
            return {
                text: flushed.ok ? `${HIDE_LABEL[target]}已隐藏（原文保留，供审计）` : '已记录隐藏，但保存失败，请稍后重试',
                changed: true,
            };
        }
        case 'purge': {
            if (!parsed.confirmed) {
                return { text: '将清除本会话全部上下文，且不可恢复（不影响长期记忆）。\n确认请发送：.ai ctx purge --yes', needsConfirm: true };
            }
            purgeSession(input.sessionId, input.service.head());
            return { text: '已清除本会话上下文；长期记忆不受影响', changed: true, purged: true };
        }
        case 'repair': {
            const head = repairHead(input.sessionId);
            return { text: head ? '上下文索引正常（已检查并修复）' : '上下文索引不存在或无法修复', changed: !!head };
        }
        case 'set':
            return runSet(input, parsed);
        case 'name':
            return runName(input, parsed.nameArgs ?? []);
        default:
            return { text: HELP };
    }
}
