// `.ai ctx` 命令的纯逻辑层：解析参数、执行、返回短文本。
// 命令注册/权限/回复投递在 cmd 层；这里只依赖 ContextService / admin / runtime，便于单测。
import { contextStats, hideEvents, HideTarget, purgeSession, repairHead } from "./admin";
import type { CompactionRuntime } from "./compact/runtime";
import type { ContextService } from "./service";

export type CtxAction =
    | 'status'
    | 'archive'
    | 'hide'
    | 'purge'
    | 'set'
    | 'name'
    | 'repair'
    | 'help';

export interface ParsedCtxCommand {
    action: CtxAction;
    target?: HideTarget;
    confirmed?: boolean;
    budget?: number;
    retain?: number;
    nameArgs?: string[];
    error?: string;
}

const HIDE_TARGETS: readonly HideTarget[] = ['user', 'assistant', 'all'];

/** 解析 `.ai ctx ...` 的参数（不含 `ctx` 本身）；空=status */
export function parseCtxCommand(args: readonly string[]): ParsedCtxCommand {
    const argv = (args || []).map(a => String(a || '').trim()).filter(Boolean);
    if (argv.length === 0) return { action: 'status' };
    const head = argv[0].toLowerCase();
    const rest = argv.slice(1);
    if (head === 'status') return { action: 'status' };
    if (head === 'archive' || head === 'settle') return { action: 'archive' };
    if (head === 'repair') return { action: 'repair' };
    if (head === 'help' || head === '-h' || head === '--help') return { action: 'help' };
    if (head === 'hide') {
        const raw = (rest[0] || 'all').toLowerCase();
        const target = (HIDE_TARGETS as readonly string[]).includes(raw) ? raw as HideTarget : null;
        if (!target) return { action: 'help', error: `hide 目标只能是 ${HIDE_TARGETS.join('/')}` };
        return { action: 'hide', target };
    }
    if (head === 'purge') {
        const confirmed = rest.includes('--yes') || rest.includes('-y');
        return { action: 'purge', confirmed };
    }
    if (head === 'set') {
        let budget: number | undefined;
        let retain: number | undefined;
        for (const item of rest) {
            const m = /^(budget|retain)=(-?\d+)$/i.exec(item);
            if (!m) continue;
            const value = Number(m[2]);
            if (m[1].toLowerCase() === 'budget') budget = value;
            else retain = value;
        }
        if (budget === undefined && retain === undefined) {
            return { action: 'help', error: 'set 需要 budget=<token> 或 retain=<百分比>' };
        }
        return { action: 'set', budget, retain };
    }
    if (head === 'name') return { action: 'name', nameArgs: rest };
    return { action: 'help', error: `未知子命令: ${head}` };
}

export interface CtxCommandInput {
    sessionId: string;
    service: ContextService;
    args: readonly string[];
    runtime?: CompactionRuntime | null;
    now?: () => number;
}

export interface CtxCommandResult {
    text: string;
    changed?: boolean;
    needsConfirm?: boolean;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 状态短文本：不输出原文/列表 */
export function formatCtxStatus(input: CtxCommandInput): string {
    const stats = contextStats(input.service.getStore());
    const lines = [
        `上下文 v2：事件 ${stats.events}（seq ${stats.firstSeq}-${stats.lastSeq}，epoch ${stats.epoch}）`,
        `记录 ${stats.records} · 页 ${stats.pages}+${stats.recordPages} · 体积 ${formatBytes(stats.bytesTotal)}`,
        `已摘要至 seq ${stats.summarizedThrough} · 未摘要约 ${stats.unsummarizedTokens} token`,
    ];
    if (stats.legacy) lines.push('旧版分片：有（只读兼容）');
    const last = input.runtime?.getLastResult();
    if (last) {
        const when = last.ran ? (last.advanced ? '成功' : `跳过(${last.reason ?? '未知'})`) : `跳过(${last.reason ?? '未知'})`;
        lines.push(`最近整理：${when}`);
    }
    return lines.join('\n');
}

const HELP_TEXT = [
    '用法：.ai ctx [status|archive|hide|purge|set|name|repair]',
    '  status                    查看上下文体积/积压（短）',
    '  archive                   立即生成/刷新摘要（不删原文，不写记忆）',
    '  hide [user|assistant|all] 逻辑遗忘（原文保留，模型/召回不可见）',
    '  purge --yes               物理清除本会话上下文（不可恢复）',
    '  set budget=<tokens> retain=<百分比>  会话级覆盖（待接线）',
    '  name ...                  上下文名字规则（待接线）',
    '  repair                    检查并修复 head',
].join('\n');

/**
 * 执行 `.ai ctx`。权限（admin）由 cmd 层判断；purge 需要显式 --yes。
 */
export async function runCtxCommand(input: CtxCommandInput): Promise<CtxCommandResult> {
    const parsed = parseCtxCommand(input.args);
    switch (parsed.action) {
        case 'status':
            return { text: formatCtxStatus(input) };
        case 'help':
            return { text: parsed.error ? `${parsed.error}\n${HELP_TEXT}` : HELP_TEXT };
        case 'archive': {
            if (!input.runtime) return { text: '归档不可用：未配置摘要器/运行时' };
            const result = await input.runtime.archiveNow();
            if (!result.advanced) {
                return { text: `本次未生成摘要：${result.reason ?? '无新增内容'}` };
            }
            return {
                text: `已整理：摘要至 seq ${result.through ?? '?'}（原文保留，可用 read_raw 回查）`,
                changed: true,
            };
        }
        case 'hide': {
            hideEvents(input.service.getStore(), parsed.target ?? 'all', input.now ? input.now() : undefined);
            const flushed = await input.service.flush();
            return {
                text: flushed.ok
                    ? `已逻辑遗忘 ${parsed.target ?? 'all'}：模型与检索不可见，原文仍保留`
                    : `已记录遗忘，但落盘失败：${flushed.error ?? 'unknown'}`,
                changed: true,
            };
        }
        case 'purge': {
            if (!parsed.confirmed) {
                return {
                    text: `将物理清除本会话全部上下文（事件/记录/blob/旧分片，不可恢复；默认不动长期记忆）。\n确认请发送：.ai ctx purge --yes`,
                    needsConfirm: true,
                };
            }
            const head = input.service.head();
            const result = purgeSession(input.sessionId, head);
            return {
                text: `已清除：事件页 ${result.clearedEventPages}、记录页 ${result.clearedRecordPages}、blob ${result.clearedBlobs}、旧分片 ${result.clearedLegacyShards}；已切换到 epoch ${result.head.epoch}`,
                changed: true,
            };
        }
        case 'repair': {
            const head = repairHead(input.sessionId);
            return {
                text: head ? `head 已检查/修复：epoch ${head.epoch}，页 ${head.nextPageNo}，seq ${head.nextSeq}` : 'head 不存在或无法修复',
                changed: !!head,
            };
        }
        case 'set':
            return { text: '会话级覆盖（budget/retain）需等 P2 正式切换后接入；当前未改动。' };
        case 'name':
            return { text: '名字规则（name status/set/mod）需等 P2 正式切换后接入；当前未改动。' };
        default:
            return { text: HELP_TEXT };
    }
}
