// .ai memo：个人/群聊/本体记忆、观察、心智模型管理。
import { resetContextBridgeCursor } from "../../agent/context_bridge";
import { MemoryScheduler } from "../../agent/memory_scheduler";
import Config from "../../config/config";
import { PRIVILEGE_LEVEL_MAP } from "../../config/static_config";
import { MemoryManager } from "../../memory/manager";
import { bumpMemoryRevision, bumpSummaryRevision } from "../../memory/revision";
import { MemoryService } from "../../memory/service";
import { parseIdOrIndex } from "../../memory/v2/access";
import { Session } from "../../session/session";
import { getSession } from "../../session/session_service";
import { aliasToCmd } from "../../utils/alias";
import { fmtDate } from "../../utils/string";
import { normalizeGroupId, normalizeUserId, platformOf } from "../../utils/target_id";
import { S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

interface MemoTarget {
    bankId: string;
    kind: 'user' | 'group' | 'global';
    label: string;
    explicit: boolean;
    session?: Session;
    agentName: string;
}

function resolveTarget(scc: SubCmdContext): { ok: true; target: MemoTarget } | { ok: false; reply: string } {
    const { ctx, cmdArgs, session } = scc;
    const isMaster = ctx.privilegeLevel >= PRIVILEGE_LEVEL_MAP.master;
    const u = cmdArgs.getKwarg('u');
    const g = cmdArgs.getKwarg('g');
    const self = cmdArgs.getKwarg('self');
    const count = [u, g, self].filter(Boolean).length;
    if (count > 1) return { ok: false, reply: '--u / --g / --self 只能用一个' };
    const agentName = session.agentName;
    if (self) {
        if (!isMaster) return { ok: false, reply: '权限不足：--self（本体记忆）仅骰主' };
        return { ok: true, target: { bankId: MemoryService.globalBankId(agentName), kind: 'global', label: '本体', explicit: true, agentName } };
    }
    if (u) {
        if (u.valueExists && !isMaster) return { ok: false, reply: '权限不足：仅骰主可操作他人个人记忆（--u=<ID>）' };
        const id = u.valueExists ? normalizeUserId(u.value, platformOf(ctx)) : (ctx.player?.userId || (ctx.isPrivate ? session.sessionId : ''));
        if (!id) return { ok: false, reply: '参数无效：--u=<用户ID>' };
        const target = getSession(id);
        return { ok: true, target: { bankId: MemoryService.bankIdForSessionId(id, agentName), kind: 'user', label: `个人:${id}`, explicit: true, session: target, agentName } };
    }
    if (g) {
        if (g.valueExists && !isMaster) return { ok: false, reply: '权限不足：仅骰主可操作其他群记忆（--g=<ID>）' };
        const id = g.valueExists ? normalizeGroupId(g.value, platformOf(ctx)) : (session.sessionType === 'group' ? session.sessionId : '');
        if (!id) return { ok: false, reply: '参数无效：--g=<群ID>' };
        const target = getSession(id);
        return { ok: true, target: { bankId: MemoryService.bankIdForSessionId(id, agentName), kind: 'group', label: `群聊:${id}`, explicit: true, session: target, agentName } };
    }
    const kind = session.sessionType === 'group' ? 'group' : 'user';
    return { ok: true, target: { bankId: MemoryService.bankIdForSessionId(session.sessionId, agentName), kind, label: kind === 'group' ? '群聊' : '个人', explicit: false, session, agentName } };
}

function prefix(target: MemoTarget): string {
    return target.explicit ? `【${target.label}】` : `【${target.label}】`;
}

function idsOf(target: MemoTarget): string[] {
    return MemoryService.listFactIds(target.bankId);
}

function resolveIdOrIndex(target: MemoTarget, raw: string): string | null {
    return parseIdOrIndex(raw, idsOf(target));
}

function isMaster(scc: SubCmdContext): boolean {
    return scc.ctx.privilegeLevel >= PRIVILEGE_LEVEL_MAP.master;
}

const SCOPE_NOTE = '范围: 默认当前会话；--u 本人 / --g 当前群 / --self 本体（仅骰主）；--u=<ID>/--g=<ID> 仅骰主';

const MEMO_HELP = `帮助:
  【.ai memo status】记忆状态（含 backlog/队列/下次刷新）
  【.ai memo add <内容>】添加事实（--shared 跨群；--private 仅本人）
  【.ai memo list [页码]】事实列表（#序号可代替 ID）
  【.ai memo update <ID|#N> <新内容>】更新
  【.ai memo delete <ID|#N> ... [--关键词] [--hard]】默认软失效
  【.ai memo clear --yes】清除（不可恢复）
  【.ai memo obs list|view <ID>|clr --yes|on|off|refresh】观察记忆
  【.ai memo consolidate】巩固
  【.ai memo reflect <问题>】基于记忆推理
  【.ai memo mm list|view|add|refresh|clear|del】心智模型
  ${SCOPE_NOTE}`;

function registerPriv(cmd: SubCmd): void {
    cmd.priv = {
        priv: U, args: {
            status: { priv: U }, add: { priv: U }, list: { priv: U }, update: { priv: U },
            delete: { priv: U }, clear: { priv: U }, consolidate: { priv: U }, reflect: { priv: U },
            obs: { priv: U, args: { list: { priv: U }, view: { priv: U }, clear: { priv: U }, clr: { priv: U }, on: { priv: S }, off: { priv: S }, refresh: { priv: U } } },
            mm: { priv: U, args: { list: { priv: U }, view: { priv: U }, add: { priv: U }, refresh: { priv: U }, clear: { priv: U }, del: { priv: U }, delete: { priv: U }, "*": { priv: U } } },
            "*": { priv: U },
        },
    };
}

export function registerCmdMemory(): void {
    const cmd = new SubCmd('memory');
    cmd.desc = '记忆相关操作';
    cmd.help = MEMO_HELP;
    registerPriv(cmd);
    cmd.solve = async (scc: SubCmdContext) => {
        const { cmdArgs, ctx, msg, ret } = scc;
        const sub = aliasToCmd(cmdArgs.getArgN(2)) || 'status';
        const t = resolveTarget(scc);
        if (t.ok === false) { seal.replyToSender(ctx, msg, t.reply); return ret; }
        const target = t.target;
        const reply = (text: string) => seal.replyToSender(ctx, msg, `${prefix(target)}${text}`);
        const rev = () => { bumpMemoryRevision(); };

        switch (sub) {
            case 'status': {
                const status = MemoryService.status(target.bankId);
                const sched = MemoryScheduler.status();
                const models = MemoryService.listMentalModels(target.bankId);
                reply([
                    `长期事实 ${status.facts} 条（失效 ${status.invalidated}）`,
                    `观察 ${status.observations} 条（过期 ${status.expiredObservations}）`,
                    `心智模型 ${status.mentalModels} 条（pending ${status.pendingMentalModels} / failed ${status.failedMentalModels}）`,
                    `巩固积压：${status.backlog}（pending ${status.pendingFacts} 条）`,
                    `后台队列 ${sched.jobs}，本小时 LLM ${sched.hourlyCalls}${sched.pausedUntil > Date.now() / 1000 ? '（熔断中）' : ''}`,
                    `MM 自动刷新：${(Config.memory as any).MM_REFRESH_AFTER_CONSOLIDATION ? '开' : '关'}；模型：${models.slice(0, 5).map(m => `${m.sourceQuery.slice(0, 12)}${m.status === 'ready' ? '' : `(${m.status})`}`).join('；') || '（空）'}`,
                ].join('\n'));
                return ret;
            }
            case 'add': {
                const content = String(cmdArgs.getRestArgsFrom(3) || '').trim();
                if (!content) { reply('用法：.ai memo add <内容>'); return ret; }
                const shared = !!cmdArgs.getKwarg('shared');
                const isPrivate = !!cmdArgs.getKwarg('private');
                const result = await MemoryService.retainToBank(target.bankId, {
                    content,
                    visibility: isPrivate ? 'owner' : shared ? 'public' : (target.kind === 'user' ? 'owner' : 'public'),
                    relatedUserIds: target.kind === 'user' ? [target.bankId.replace(/^user_/, '')] : [],
                    relatedGroupIds: target.kind === 'group' ? [target.bankId.replace(/^group_/, '')] : [],
                    metadata: { type: 'text' },
                });
                rev();
                reply(result.action === 'duplicate' ? `已存在同文记忆 <${result.unitIds[0]}>` : `已添加 <${result.unitIds[0]}>`);
                return ret;
            }
            case 'list': {
                const all = MemoryService.listFacts(target.bankId);
                const pageSize = 20;
                const page = Math.max(1, scc.page || Number(cmdArgs.getArgN(3)) || 1);
                const start = (page - 1) * pageSize;
                const slice = all.slice(start, start + pageSize);
                if (!slice.length) { reply('暂无长期记忆'); return ret; }
                reply(slice.map((m, i) => `${start + i + 1}. [${m.id}] ${m.text.slice(0, 80)} · ${fmtDate(m.createdAt)}${m.state === 'invalidated' ? '（失效）' : ''}`).join('\n'));
                return ret;
            }
            case 'update': {
                const raw = String(cmdArgs.getArgN(3) || '');
                const id = resolveIdOrIndex(target, raw);
                const content = String(cmdArgs.getRestArgsFrom(4) || '').trim();
                if (!id || !content) { reply('用法：.ai memo update <ID|#N> <新内容>'); return ret; }
                const unit = MemoryService.getFact(target.bankId, id);
                if (!unit) { reply(`记忆不存在<${id}>`); return ret; }
                const old = unit.text;
                unit.text = content;
                unit.updatedAt = Math.floor(Date.now() / 1000);
                MemoryService.saveFact(target.bankId, unit);
                rev();
                reply(`已更新<${id}>`);
                void old;
                return ret;
            }
            case 'delete': {
                const rawIds = [cmdArgs.getArgN(3), cmdArgs.getArgN(4), cmdArgs.getArgN(5)].filter(Boolean).map(String);
                const keywords = cmdArgs.kwargs.map(k => k.name).filter(n => !['u', 'g', 'self', 'hard', 'page'].includes(n));
                const hard = !!cmdArgs.getKwarg('hard');
                let ids = rawIds.map(r => resolveIdOrIndex(target, r)).filter((x): x is string => !!x);
                if (keywords.length) {
                    const all = MemoryService.listFacts(target.bankId);
                    const matched = all.filter(m => keywords.some(k => m.text.includes(k) || m.tags.some(t => t.includes(k))));
                    ids = Array.from(new Set([...ids, ...matched.map(m => m.id)]));
                }
                if (!ids.length) { reply('未找到可删除记忆（支持 #N / ID / --关键词）'); return ret; }
                if (hard && !isMaster(scc)) { reply('--hard 仅骰主可用'); return ret; }
                const n = hard ? await MemoryService.deleteFacts(target.bankId, ids) : await MemoryService.invalidateFacts(target.bankId, ids);
                rev();
                reply(`已${hard ? '物理删除' : '失效'} ${n} 条`);
                return ret;
            }
            case 'clear': {
                if (!cmdArgs.getKwarg('yes')) { reply('清除不可恢复；确认请使用 .ai memo clear --yes'); return ret; }
                const n = await MemoryService.clearBank(target.bankId, true);
                MemoryScheduler.dropBank(target.bankId);
                if (target.kind !== 'global') {
                    const sid = target.session?.sessionId || target.bankId.replace(/^(user|group)_/, '');
                    try { resetContextBridgeCursor(getSession(sid)); } catch { /* ignore */ }
                }
                rev();
                reply(`已清除 ${n} 条事实/观察/模型`);
                return ret;
            }
            case 'obs': return solveObs(scc, target, reply);
            case 'consolidate': {
                const result = await MemoryService.consolidateBank(target.bankId);
                bumpSummaryRevision();
                const mm = (Config.memory as any).MM_REFRESH_AFTER_CONSOLIDATION
                    ? await MemoryService.refreshMentalModels(target.bankId, { touchedTags: result.touchedTags, reason: 'consolidate' })
                    : null;
                reply(`巩固完成：新建 ${result.created.length}，更新 ${result.updated.length}，合并 ${result.merged.length}，剩余 pending ${result.pendingRemaining}${mm ? `；模型更新 ${mm.updated}` : ''}`);
                return ret;
            }
            case 'reflect': {
                const question = String(cmdArgs.getRestArgsFrom(3) || '').trim();
                if (!question) { reply('用法：.ai memo reflect <问题>'); return ret; }
                const result = await MemoryService.reflect(target.bankId, question, { fastPath: !cmdArgs.getKwarg('deep'), strict: false });
                reply(`${result.text || '暂无足够记忆进行推理'}\n来源：模型 ${result.basedOn.mentalModels.length} / 观察 ${result.basedOn.observations.length} / 事实 ${result.basedOn.memories.length}${result.answeredBy === 'model' ? '（心智模型直答）' : ''}`);
                return ret;
            }
            case 'mm': return solveMM(scc, target, reply);
            default:
                if (sub === 'private' || sub === 'group' || sub === 'set') reply('旧语法已废弃：请使用 --u / --g / --self 范围参数');
                else reply(MEMO_HELP);
                return ret;
        }
    };
}

async function solveObs(scc: SubCmdContext, target: MemoTarget, reply: (t: string) => void) {
    const { cmdArgs, session, ret } = scc;
    const action = aliasToCmd(cmdArgs.getArgN(3)) || 'refresh';
    if (action === 'on' || action === 'off') {
        session.memory.observationEnabled = action === 'on';
        session.save();
        reply(`观察记忆已${action === 'on' ? '开启' : '关闭'}（会话级）`);
        return ret;
    }
    if (action === 'list') {
        const obs = MemoryService.listObservations(target.bankId);
        reply(obs.length ? obs.slice(0, 20).map((o, i) => `${i + 1}. [${o.id}] ${o.text.slice(0, 80)} · 证据${o.proofCount}`).join('\n') : '暂无观察记忆');
        return ret;
    }
    if (action === 'view') {
        const id = resolveIdOrIndex(target, String(cmdArgs.getArgN(4) || ''));
        const o = id ? MemoryService.getObservation(target.bankId, id) : null;
        if (!o) { reply('用法：.ai memo obs view <ID>'); return ret; }
        reply(`【观察】${o.text}\nID: ${o.id} · 证据${o.proofCount} 条 · 状态${o.status}\n范围: ${o.tags.filter(t => /^(user|group|global):/.test(t)).join(', ') || '（全局）'}\n创建: ${fmtDate(o.createdAt)} · 最近支持: ${fmtDate(o.lastSupportedAt)}\n证据:\n${o.evidence.map(e => `- [${e.memoryId}] ${e.quote}`).join('\n') || '（无）'}`);
        return ret;
    }
    if (action === 'clr' || action === 'clear') {
        if (!cmdArgs.getKwarg('yes')) { reply('清除观察不可恢复；确认请使用 .ai memo obs clr --yes'); return ret; }
        const n = await MemoryService.clearObservations(target.bankId);
        bumpSummaryRevision();
        reply(`已清除 ${n} 条观察（源事实已重置待巩固）`);
        return ret;
    }
    // refresh / bare obs：同步抽取当前上下文并巩固
    await MemoryManager.summarizeChunk(session, session.context.messages);
    const result = await MemoryService.consolidateBank(target.bankId);
    bumpSummaryRevision();
    reply(`已刷新：新建观察 ${result.created.length}，更新 ${result.updated.length}`);
    return ret;
}

async function solveMM(scc: SubCmdContext, target: MemoTarget, reply: (t: string) => void) {
    const { cmdArgs, ret } = scc;
    const action = aliasToCmd(cmdArgs.getArgN(3)) || 'list';
    const models = MemoryService.listMentalModels(target.bankId);
    if (action === 'list') {
        reply(models.length ? models.slice(0, 20).map((m, i) => `${i + 1}. [${m.id}] ${m.sourceQuery} · ${m.status}${m.lastRefreshedAt ? ` · 刷新${fmtDate(m.lastRefreshedAt)}` : ''}`).join('\n') : '暂无心智模型');
        return ret;
    }
    if (action === 'view') {
        const id = resolveIdOrIndex(target, String(cmdArgs.getArgN(4) || ''));
        const m = id ? models.find(x => x.id === id) : null;
        if (!m) { reply('用法：.ai memo mm view <ID>'); return ret; }
        reply(`【心智模型】${m.sourceQuery}\nID: ${m.id} · ${m.status} · 模式 ${m.trigger.mode} · 自动刷新 ${m.trigger.refreshAfterConsolidation ? '开' : '关'}\n${m.content || '（待生成）'}`);
        return ret;
    }
    if (action === 'add') {
        const question = String(cmdArgs.getArgN(4) || '').trim();
        const answer = String(cmdArgs.getRestArgsFrom(5) || '').trim();
        const tag = cmdArgs.getKwarg('tag');
        if (!question) { reply('用法：.ai memo mm add <问题> [答案] [--tag=xx] [--mode=full|delta] [--auto|--no-auto]'); return ret; }
        const modeKw = cmdArgs.getKwarg('mode');
        const auto = !!cmdArgs.getKwarg('auto');
        const noAuto = !!cmdArgs.getKwarg('no-auto');
        const model = await MemoryService.createMentalModel(target.bankId, question, answer, tag?.value ? [tag.value] : [], {
            mode: modeKw?.value === 'delta' ? 'delta' : modeKw?.value === 'full' ? 'full' : undefined,
            autoRefresh: noAuto ? false : auto ? true : undefined,
        });
        MemoryScheduler.enqueueMentalModelRefresh(target.bankId, model.id, 'manual');
        reply(`已${answer ? '' : '创建待生成'}心智模型 <${model.id}>`);
        return ret;
    }
    if (action === 'refresh') {
        const raw = String(cmdArgs.getArgN(4) || '');
        const id = raw ? resolveIdOrIndex(target, raw) : undefined;
        const summary = await MemoryService.refreshMentalModels(target.bankId, { id, force: true, reason: 'manual' });
        reply(`刷新完成：更新 ${summary.updated}，跳过 ${summary.skipped}，失败 ${summary.failed}（${Object.keys(summary.skippedReasons || {}).map(k => `${k}:${summary.skippedReasons[k]}`).join(' ') || '—'}）`);
        return ret;
    }
    if (action === 'clear') {
        const id = resolveIdOrIndex(target, String(cmdArgs.getArgN(4) || ''));
        const m = id ? models.find(x => x.id === id) : null;
        if (!m) { reply('用法：.ai memo mm clear <ID>'); return ret; }
        m.content = '';
        m.structuredContent = { version: 1, sections: [] };
        m.status = 'pending';
        MemoryService.saveMentalModel(target.bankId, m);
        MemoryScheduler.enqueueMentalModelRefresh(target.bankId, m.id, 'manual');
        reply(`已清空 <${m.id}> 内容，正在重建`);
        return ret;
    }
    if (action === 'del' || action === 'delete') {
        const raw = String(cmdArgs.getArgN(4) || '');
        let id = resolveIdOrIndex(target, raw);
        if (!id && raw) {
            const matched = models.filter(m => m.sourceQuery.includes(raw));
            if (matched.length === 1) id = matched[0].id;
        }
        if (!id) { reply('用法：.ai memo mm del <ID|问题关键词>'); return ret; }
        await MemoryService.deleteMentalModel(target.bankId, id);
        reply(`已删除心智模型 <${id}>`);
        return ret;
    }
    reply(MEMO_HELP);
    return ret;
}

export function resolveMmAddOptions(modeValue?: string | null, auto = false, noAuto = false): { mode?: 'full' | 'delta'; autoRefresh?: boolean } {
    const opts: { mode?: 'full' | 'delta'; autoRefresh?: boolean } = {};
    if (modeValue) opts.mode = modeValue === 'delta' ? 'delta' : 'full';
    if (noAuto) opts.autoRefresh = false;
    else if (auto) opts.autoRefresh = true;
    return opts;
}
