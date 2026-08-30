// .ai memo：个人/群聊/观察记忆与心智模型管理（范围参数 --u/--g）
import Config from "../../config/config";
import { PRIVILEGE_LEVEL_MAP } from "../../config/static_config";
import { MemoryManager } from "../../memory/manager";
import { bumpMemoryRevision } from "../../memory/revision";
import { resolveBankId } from "../../memory/v2/bank_resolver";
import { getMemoryEngine, OBSERVATION_STALE_DAYS } from "../../memory/v2/index";
import { Session } from "../../session/session";
import { getSession } from "../../session/session_service";
import { fmtDate, stripInternalTags } from "../../utils/string";
import { normalizeGroupId, normalizeUserId, platformOf } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 受保护记忆：其他会话创建的私有记忆仅创建会话可删（与工具层 del_memory / clear_memory 一致） */
function protectedMemoryIds(target: Session, callerSessionId: string): Set<string> {
    const ids = new Set<string>();
    if (target.sessionId !== callerSessionId) {
        for (const m of target.memory.memories) {
            const privateTags = m.tags.filter(t => t.startsWith('vis:private:'));
            if (privateTags.length > 0 && !privateTags.some(t => t === `vis:private:${callerSessionId}`)) ids.add(m.id);
        }
    }
    return ids;
}

/** 记忆范围解析结果 */
interface MemoTarget {
    session: Session;   // 目标会话
    kind: 'user' | 'group';
    scopeLabel: string; // 个人/群聊
    explicit: boolean;  // 是否显式指定了 --u/--g（用于限制裸 obs 生成）
}

/**
 * 解析 --u/--g 范围参数（应用到 memo 所有子命令）：
 *  - 默认当前会话（私聊=个人，群聊=当前群）
 *  - --u 无值 = 调用者本人个人记忆；--u=<ID> 仅骰主
 *  - --g 无值 = 当前群；--g=<ID> 仅骰主
 */
function resolveMemoTarget(scc: SubCmdContext): { ok: true; target: MemoTarget } | { ok: false; reply: string } {
    const { ctx, cmdArgs, session } = scc;
    const uKw = cmdArgs.getKwarg('u');
    const gKw = cmdArgs.getKwarg('g');
    const isMaster = ctx.privilegeLevel >= PRIVILEGE_LEVEL_MAP.master;

    if (uKw && gKw) {
        return { ok: false, reply: '不能同时使用 --u 和 --g' };
    }

    const defaultKind: 'user' | 'group' = session.sessionType === 'group' ? 'group' : 'user';
    let targetSession = session;
    let kind = defaultKind;
    let explicit = false;

    if (uKw) {
        explicit = true;
        if (uKw.valueExists) {
            // --u=<ID>：仅骰主可查看他人个人记忆
            if (!isMaster) {
                return { ok: false, reply: '权限不足：仅骰主可查看他人个人记忆（--u=<用户ID>）' };
            }
            const uid = normalizeUserId(uKw.value, platformOf(ctx));
            if (!uid) {
                return { ok: false, reply: '参数无效：--u=<用户ID>，支持裸数字（如 --u=1234）或带前缀（如 --u=QQ:1234）' };
            }
            targetSession = getSession(uid);
            kind = 'user';
        } else {
            // --u 无值 = 调用者本人
            const rawPlayerId = ctx.player?.userId || '';
            const uid = normalizeUserId(rawPlayerId, platformOf(ctx))
                || (ctx.isPrivate && session.sessionId ? session.sessionId : null);
            if (!uid) {
                return { ok: false, reply: `当前消息缺少有效用户ID（player=${rawPlayerId || '空'}, session=${session.sessionId || '空'}）` };
            }
            targetSession = getSession(uid);
            kind = 'user';
        }
    } else if (gKw) {
        explicit = true;
        if (gKw.valueExists) {
            // --g=<ID>：仅骰主可查看其他群记忆
            if (!isMaster) {
                return { ok: false, reply: '权限不足：仅骰主可查看其他群记忆（--g=<群ID>）' };
            }
            const gid = normalizeGroupId(gKw.value, platformOf(ctx));
            if (!gid) {
                return { ok: false, reply: '参数无效：--g=<群ID>，支持裸数字（如 --g=1234）或带前缀（如 --g=QQ-Group:1234）' };
            }
            targetSession = getSession(gid);
            kind = 'group';
        } else {
            // --g 无值 = 当前群（仅群聊可用）
            if (session.sessionType !== 'group') {
                return { ok: false, reply: '当前为私聊会话，--g 需指定群ID（仅骰主：--g=<群ID>）' };
            }
            targetSession = session;
            kind = 'group';
        }
    }

    return { ok: true, target: { session: targetSession, kind, scopeLabel: kind === 'user' ? '个人' : '群聊', explicit } };
}

/** 输出前缀：范围标识，跨范围时带上目标ID */
function scopePrefix(target: MemoTarget): string {
    return target.explicit ? `【${target.scopeLabel}:${target.session.sessionId}】` : `【${target.scopeLabel}】`;
}

const MEMO_HELP = `帮助:
  【.ai memo status [--u|--g[=ID]]】查看记忆状态
  【.ai memo add <内容> [--u|--g[=ID]]】添加长期记忆
  【.ai memo list [页码] [--u|--g[=ID]]】展示长期记忆
  【.ai memo update <ID> <新内容> [--u|--g[=ID]]】更新长期记忆
  【.ai memo delete <ID1> <ID2> --关键词 [--u|--g[=ID]]】删除长期记忆
  【.ai memo clear [--u|--g[=ID]]】清除长期记忆
  【.ai memo obs [on/off|list|view <ID>|clr] [--u|--g[=ID]]】观察记忆
  【.ai memo consolidate [--u|--g[=ID]]】巩固记忆
  【.ai memo reflect <问题> [--u|--g[=ID]]】基于记忆推理
  【.ai memo mm list|view|add|refresh|del [--u|--g[=ID]]】心智模型
  【.ai memo <子命令> help】查看子命令详细帮助
  范围说明: 默认当前会话；--u 查看本人个人记忆，--g 查看当前群；--u=<ID>/--g=<ID> 仅骰主可用`;

const MEMO_STATUS_HELP = `【.ai memo status [--u|--g[=ID]]】查看记忆状态
  范围: 默认当前会话；--u 本人个人记忆；--g 当前群；--u=<ID>/--g=<ID> 仅骰主`;

const MEMO_MEMORY_HELP = `长期记忆操作:
  【.ai memo add <内容> [--u|--g[=ID]]】添加
  【.ai memo list [页码] [--u|--g[=ID]]】展示（页码也可用 --page=N）
  【.ai memo update <ID> <新内容> [--u|--g[=ID]]】更新
  【.ai memo delete <ID1> <ID2> --关键词 [--u|--g[=ID]]】删除（支持关键词过滤）
  【.ai memo clear [--u|--g[=ID]]】清除
  范围: 默认当前会话；--u 本人；--g 当前群；--u=<ID>/--g=<ID> 仅骰主`;

const MEMO_OBS_HELP = `观察记忆操作:
  【.ai memo obs on/off [--u|--g[=ID]]】开启/关闭（会话级设置）
  【.ai memo obs list [--u|--g[=ID]]】展示
  【.ai memo obs view <ID> [--u|--g[=ID]]】详情
  【.ai memo obs clr [--u|--g[=ID]]】清除
  【.ai memo obs】立即生成一次观察（仅当前会话，不带 --u/--g）`;

const MEMO_CONSOLIDATE_HELP = `【.ai memo consolidate [--u|--g[=ID]]】立即巩固一次记忆（合并重复观察、清理过期记忆）`;

const MEMO_REFLECT_HELP = `【.ai memo reflect <问题> [--u|--g[=ID]]】基于记忆进行推理`;

const MEMO_MM_HELP = `心智模型操作:
  【.ai memo mm list [页码] [--u|--g[=ID]]】查看心智模型列表
  【.ai memo mm view <ID> [--u|--g[=ID]]】查看心智模型详情
  【.ai memo mm add <问题> [答案] [--u|--g[=ID]]】添加心智模型（不填答案时自动推理；--tag=xx 自定义范围标签）
  【.ai memo mm refresh [ID] [--u|--g[=ID]]】刷新心智模型（基于当前记忆重新推理）
  【.ai memo mm del <ID> [--u|--g[=ID]]】删除心智模型`;
export function registerCmdMemory() {
    const cmd = new SubCmd('memory');
    cmd.desc = '记忆相关操作';
    cmd.help = MEMO_HELP;
    cmd.priv = {
        priv: U, args: {
            status: { priv: U },
            add: { priv: U },
            list: { priv: U },
            update: { priv: U },
            delete: { priv: U },
            clear: { priv: U },
            obs: {
                priv: U, args: {
                    list: { priv: U },
                    view: { priv: U },
                    clear: { priv: U },
                    on: { priv: S },
                    off: { priv: S }
                }
            },
            consolidate: { priv: U },
            reflect: { priv: U },
            mm: {
                priv: U, args: {
                    list: { priv: U },
                    view: { priv: U },
                    add: { priv: U },
                    refresh: { priv: U },
                    del: { priv: U },
                    "*": { priv: U }
                }
            },
            "*": { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, page, ret } = scc;

        const resolved = resolveMemoTarget(scc);
        if (resolved.ok === false) {
            seal.replyToSender(ctx, msg, resolved.reply);
            return ret;
        }
        const target = resolved.target;
        const targetSession = target.session;
        const bank = resolveBankId(targetSession.sessionId, target.kind, targetSession.agentName);
        const prefix = scopePrefix(target);
        const isHelp = (n: number) => aliasToCmd(cmdArgs.getArgN(n)) === 'help';

        switch (aliasToCmd(cmdArgs.getArgN(2))) {
            case 'status': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_STATUS_HELP);
                    return ret;
                }
                const { MEMORY: isMemory, SUMMARY: isSummary } = Config.memory;
                const summaryEffective = targetSession.memory.summaryOverride === false ? false : targetSession.memory.summaryOverride === true ? true : isSummary;
                const summarySuffix = targetSession.memory.summaryOverride === undefined ? '' : '（会话级）';
                const statusModels = getMemoryEngine().listMentalModels(bank.bankId);
                const modelOverview = statusModels.length === 0 ? '（空）' : statusModels.map(m => `${m.question}${m.version > 1 ? `(v${m.version})` : ''}`).join('；');
                seal.replyToSender(ctx, msg, `${target.explicit ? prefix : `${prefix} ${targetSession.id}`}
     长期记忆开启状态: ${isMemory ? '是' : '否'}
     长期记忆条数: ${targetSession.memory.memoryIds.length}
     观察记忆开启状态: ${summaryEffective ? '是' : '否'}${summarySuffix}
     观察记忆条数: ${getMemoryEngine().repository.listObservations(bank.bankId).length}
     心智模型条数: ${statusModels.length}
     心智模型概览: ${modelOverview}`);
                return ret;
            }

            case 'add': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_MEMORY_HELP);
                    return ret;
                }
                const content = cmdArgs.getRestArgsFrom(3);
                if (!content) {
                    seal.replyToSender(ctx, msg, `参数缺失，${MEMO_MEMORY_HELP}`);
                    return ret;
                }
                const result = await targetSession.memory.retainMemory(null, targetSession, [], [], [], [], stripInternalTags(content), 'public', undefined, 0.5);
                targetSession.save();
                seal.replyToSender(ctx, msg, result.unitIds[0] ? `${target.scopeLabel}记忆已添加<${result.unitIds[0]}>` : `${target.scopeLabel}记忆已添加`);
                return ret;
            }

            case 'list': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_MEMORY_HELP);
                    return ret;
                }
                const listText = targetSession.memory.getLatestMemoryListText({
                    isPrivate: target.kind === 'user',
                    id: target.kind === 'group' ? (ctx.group?.groupId || targetSession.sessionId) : targetSession.sessionId,
                    name: target.kind === 'group' ? (ctx.group?.groupName || targetSession.sessionId) : ''
                }, page);
                if (!listText) {
                    seal.replyToSender(ctx, msg, `${prefix}暂无${target.scopeLabel}记忆，【.ai memo add <内容>】添加`);
                    return ret;
                }
                seal.replyToSender(ctx, msg, `${prefix}${listText}`);
                return ret;
            }

            case 'update': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_MEMORY_HELP);
                    return ret;
                }
                const id = cmdArgs.getArgN(3);
                const content = cmdArgs.getRestArgsFrom(4);
                if (!id || !content) {
                    seal.replyToSender(ctx, msg, `参数缺失，【.ai memo update <ID> <新内容>】更新${target.scopeLabel}记忆`);
                    return ret;
                }
                const unit = getMemoryEngine().repository.getUnit(bank.bankId, id);
                if (!unit) {
                    seal.replyToSender(ctx, msg, `未找到记忆<${id}>`);
                    return ret;
                }
                unit.text = stripInternalTags(content);
                unit.updatedAt = Math.floor(Date.now() / 1000);
                getMemoryEngine().repository.updateUnit(bank.bankId, unit);
                bumpMemoryRevision();
                targetSession.save();
                seal.replyToSender(ctx, msg, `${target.scopeLabel}记忆已更新<${unit.id}>`);
                return ret;
            }

            case 'delete': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_MEMORY_HELP);
                    return ret;
                }
                const idList = cmdArgs.args.slice(2);
                const kw = cmdArgs.kwargs.map(item => item.name).filter(n => n !== 'u' && n !== 'g' && n !== 'page');
                if (idList.length === 0 && kw.length === 0) {
                    seal.replyToSender(ctx, msg, `参数缺失，【.ai memo delete <ID1> <ID2> --关键词】删除${target.scopeLabel}记忆`);
                    return ret;
                }
                // 与工具层一致：其他会话创建的私有记忆不可删除
                const protectedIds = protectedMemoryIds(targetSession, session.sessionId);
                const deleteIds = new Set<string>();
                for (const id of idList) {
                    if (!protectedIds.has(id)) deleteIds.add(id);
                }
                if (kw.length > 0) {
                    for (const m of targetSession.memory.memories) {
                        if (!protectedIds.has(m.id) && kw.some(k => m.tags.includes(k))) deleteIds.add(m.id);
                    }
                }
                if (deleteIds.size === 0) {
                    seal.replyToSender(ctx, msg, '没有可删除的记忆（其他会话创建的私有记忆仅创建会话可删除）');
                    return ret;
                }
                targetSession.memory.deleteMemory(Array.from(deleteIds));
                const listText = targetSession.memory.getLatestMemoryListText({
                    isPrivate: target.kind === 'user',
                    id: target.kind === 'group' ? (ctx.group?.groupId || targetSession.sessionId) : targetSession.sessionId,
                    name: target.kind === 'group' ? (ctx.group?.groupName || targetSession.sessionId) : ''
                }, page);
                seal.replyToSender(ctx, msg, listText ? `${prefix}${listText}` : `${prefix}${target.scopeLabel}记忆已全部清除`);
                targetSession.save();
                return ret;
            }

            case 'clear': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_MEMORY_HELP);
                    return ret;
                }
                // 与工具层一致：保留其他会话创建的私有记忆
                const protectedIds = protectedMemoryIds(targetSession, session.sessionId);
                if (protectedIds.size > 0) {
                    const deleteIds = targetSession.memory.memoryIds.filter(id => !protectedIds.has(id));
                    if (deleteIds.length === 0) {
                        seal.replyToSender(ctx, msg, '无可清除的记忆（存在其他会话创建的私有记忆）');
                        return ret;
                    }
                    targetSession.memory.deleteMemory(deleteIds);
                    seal.replyToSender(ctx, msg, `${target.scopeLabel}记忆已清除（保留 ${protectedIds.size} 条其他会话的私有记忆）`);
                    targetSession.save();
                    return ret;
                }
                targetSession.memory.clearMemory();
                seal.replyToSender(ctx, msg, `${target.scopeLabel}记忆已清除`);
                targetSession.save();
                return ret;
            }
            case 'obs': {
                const val3 = aliasToCmd(cmdArgs.getArgN(3));
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_OBS_HELP);
                    return ret;
                }
                switch (val3) {
                    case 'on': {
                        targetSession.memory.summaryOverride = true;
                        targetSession.memory.summaryStatus = true;
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `${prefix}观察记忆已开启`);
                        return ret;
                    }
                    case 'off': {
                        targetSession.memory.summaryOverride = false;
                        targetSession.memory.summaryStatus = false;
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `${prefix}观察记忆已关闭`);
                        return ret;
                    }
                    case 'list': {
                        const observations = getMemoryEngine().repository.listObservations(bank.bankId);
                        if (observations.length === 0) {
                            seal.replyToSender(ctx, msg, `${prefix}观察记忆为空`);
                            return ret;
                        }
                        const staleCutoff = Math.floor(Date.now() / 1000) - OBSERVATION_STALE_DAYS * 86400;
                        const lines = observations.map((o, i) => {
                            const stale = (o.lastVerifiedAt ?? o.updatedAt ?? 0) < staleCutoff;
                            return `${i + 1}. ${o.text}\n   证据${o.proofCount}条 · 更新${fmtDate(o.updatedAt)}${stale ? ' · [已过期]' : ''}`;
                        });
                        seal.replyToSender(ctx, msg, `${prefix}观察记忆 ${observations.length} 条\n${lines.join('\n')}`);
                        return ret;
                    }
                    case 'view': {
                        const id = cmdArgs.getArgN(4);
                        if (!id) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo obs view <ID>】查看观察记忆详情');
                            return ret;
                        }
                        const o = getMemoryEngine().repository.listObservations(bank.bankId).find(x => x.id === id);
                        if (!o) {
                            seal.replyToSender(ctx, msg, `未找到观察记忆<${id}>`);
                            return ret;
                        }
                        const staleCutoff = Math.floor(Date.now() / 1000) - OBSERVATION_STALE_DAYS * 86400;
                        const stale = (o.lastVerifiedAt ?? o.updatedAt ?? 0) < staleCutoff;
                        const evidence = o.evidence.map(e => `- ${e.quote}`).join('\n') || '（无）';
                        seal.replyToSender(ctx, msg, `【观察记忆】${o.text}${stale ? '\n[已过期]' : ''}\nID: ${o.id} · 证据${o.proofCount}条\n范围: ${o.scopeTags.join(', ') || '（全局）'}\n创建: ${fmtDate(o.createdAt)}\n更新: ${fmtDate(o.updatedAt)}${o.lastVerifiedAt ? `\n最近验证: ${fmtDate(o.lastVerifiedAt)}` : ''}\n证据:\n${evidence}`);
                        return ret;
                    }
                    case 'clear': {
                        const repo = getMemoryEngine().repository;
                        const bankData = repo.getBank(bank.bankId);
                        if (bankData) {
                            bankData.observations = [];
                            bankData.units = bankData.units.filter(u => u.factType !== 'observation');
                            repo.save(bank.bankId);
                        }
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `${prefix}观察记忆已清除`);
                        return ret;
                    }
                    default: {
                        if (cmdArgs.getArgN(3)) {
                            seal.replyToSender(ctx, msg, MEMO_OBS_HELP);
                            return ret;
                        }
                        if (target.explicit) {
                            seal.replyToSender(ctx, msg, '立即生成观察记忆仅支持当前会话（不要带 --u/--g）');
                            return ret;
                        }
                        session.context.summaryCounter = 0;
                        session.save();
                        MemoryManager.retainConversation(session)
                            .then(() => session.save())
                            .catch(() => undefined);
                        seal.replyToSender(ctx, msg, '正在生成观察记忆，请稍后用 .ai memo obs list 查看');
                        return ret;
                    }
                }
            }

            case 'consolidate': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_CONSOLIDATE_HELP);
                    return ret;
                }
                const result = await MemoryManager.consolidateMemory(targetSession);
                const obsCount = getMemoryEngine().repository.listObservations(bank.bankId).length;
                const mmCount = getMemoryEngine().listMentalModels(bank.bankId).length;
                seal.replyToSender(ctx, msg, `${prefix}记忆巩固完成：新建观察 ${result.created.length} 条，更新 ${result.updated.length} 条，合并 ${result.merged.length} 条\n当前：观察记忆 ${obsCount} 条，长期记忆 ${targetSession.memory.memoryIds.length} 条，心智模型 ${mmCount} 条`);
                return ret;
            }

            case 'reflect': {
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_REFLECT_HELP);
                    return ret;
                }
                const question = cmdArgs.getRestArgsFrom(3);
                if (!question) {
                    seal.replyToSender(ctx, msg, `参数缺失，${MEMO_REFLECT_HELP}`);
                    return ret;
                }
                const result = await getMemoryEngine().reflect(bank.bankId, question);
                seal.replyToSender(ctx, msg, `${prefix}${result.text}\n（来源：心智模型 ${result.basedOn.mentalModels.length} 条 · 观察 ${result.basedOn.observations.length} 条 · 事实 ${result.basedOn.memories.length} 条）`);
                return ret;
            }

            case 'mm': {
                const mmEngine = getMemoryEngine();
                const mmVal3 = aliasToCmd(cmdArgs.getArgN(3));
                if (isHelp(3)) {
                    seal.replyToSender(ctx, msg, MEMO_MM_HELP);
                    return ret;
                }
                switch (mmVal3) {
                    case 'list': {
                        const models = mmEngine.listMentalModels(bank.bankId);
                        if (models.length === 0) {
                            seal.replyToSender(ctx, msg, `${prefix}心智模型为空，【.ai memo mm add <问题> [答案]】添加${target.kind === 'group' ? '，或使用 --u 查看自己的心智模型' : ''}`);
                            return ret;
                        }
                        const perPage = 5;
                        const totalPages = Math.max(1, Math.ceil(models.length / perPage));
                        const pageArg = parseInt(cmdArgs.getArgN(4) || '', 10);
                        const pageNum = pageArg > 0 ? pageArg : page;
                        const cur = Math.min(Math.max(pageNum, 1), totalPages);
                        const items = models.slice((cur - 1) * perPage, cur * perPage);
                        const lines = items.map(m => `${m.id} ${m.question} (v${m.version} · 更新于${fmtDate(m.updatedAt)})`);
                        seal.replyToSender(ctx, msg, `${prefix}心智模型 ${models.length} 条\n${lines.join('\n')}\n当前页码: ${cur}/${totalPages}`);
                        return ret;
                    }
                    case 'view': {
                        const id = cmdArgs.getArgN(4);
                        if (!id) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo mm view <ID>】查看心智模型详情');
                            return ret;
                        }
                        const m = mmEngine.listMentalModels(bank.bankId).find(x => x.id === id);
                        if (!m) {
                            seal.replyToSender(ctx, msg, `未找到心智模型<${id}>`);
                            return ret;
                        }
                        const answer = m.answer.length > 600 ? m.answer.slice(0, 600) + '…' : m.answer;
                        const historyInfo = Array.isArray(m.history) && m.history.length > 0 ? `\n历史: ${m.history.length} 条（最近 ${fmtDate(m.history[m.history.length - 1].at)}）` : '';
                        const triggerText = m.trigger === 'delta' ? '增量' : '全量';
                        seal.replyToSender(ctx, msg, `【心智模型】${m.question}\n${answer}\nID: ${m.id} · v${m.version}\n范围: ${m.scopeTags.join(', ') || '（全局）'}\n创建: ${fmtDate(m.createdAt)}\n更新: ${fmtDate(m.updatedAt)}${m.lastRefreshedAt ? `\n最近推理: ${fmtDate(m.lastRefreshedAt)}（${triggerText}）` : ''}${historyInfo}`);
                        return ret;
                    }
                    case 'add': {
                        const question = cmdArgs.getArgN(4);
                        if (!question) {
                            seal.replyToSender(ctx, msg, `参数缺失，${MEMO_MM_HELP}`);
                            return ret;
                        }
                        const answer = cmdArgs.getRestArgsFrom(5);
                        const tagKw = cmdArgs.getKwarg('tag');
                        const scopeTags = tagKw && tagKw.value ? [tagKw.value] : [target.kind === 'group' ? `group:${targetSession.sessionId}` : `user:${targetSession.sessionId}`];
                        if (!answer) {
                            const result = await mmEngine.reflect(bank.bankId, question);
                            const m = await mmEngine.createMentalModel(bank.bankId, question, result.text, scopeTags);
                            bumpMemoryRevision();
                            targetSession.save();
                            seal.replyToSender(ctx, msg, `${prefix}心智模型已添加<${m.id}>\n问题: ${question}\n答案: ${result.text}`);
                            return ret;
                        }
                        const m = await mmEngine.createMentalModel(bank.bankId, question, stripInternalTags(answer), scopeTags);
                        bumpMemoryRevision();
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `${prefix}心智模型已添加<${m.id}>`);
                        return ret;
                    }
                    case 'refresh': {
                        const id = cmdArgs.getArgN(4);
                        if (id) {
                            const exists = mmEngine.listMentalModels(bank.bankId).some(x => x.id === id);
                            if (!exists) {
                                seal.replyToSender(ctx, msg, `未找到心智模型<${id}>`);
                                return ret;
                            }
                        }
                        const total = id ? 1 : mmEngine.listMentalModels(bank.bankId).length;
                        const updated = await mmEngine.refreshMentalModels(bank.bankId, id || undefined, { force: true });
                        if (updated > 0) bumpMemoryRevision();
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `${prefix}已刷新 ${updated} 条，跳过 ${total - updated} 条`);
                        return ret;
                    }
                    case 'del': {
                        const id = cmdArgs.getArgN(4);
                        if (!id) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo mm del <ID>】删除心智模型');
                            return ret;
                        }
                        const ok = mmEngine.deleteMentalModel(bank.bankId, id);
                        if (!ok) {
                            seal.replyToSender(ctx, msg, `未找到心智模型<${id}>`);
                            return ret;
                        }
                        bumpMemoryRevision();
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `${prefix}心智模型已删除<${id}>`);
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, MEMO_MM_HELP);
                        return ret;
                    }
                }
            }

            default: {
                const raw2 = cmdArgs.getArgN(2);
                const a2 = aliasToCmd(raw2);
                if (a2 === 'private' || a2 === 'group' || a2 === 'set') {
                    seal.replyToSender(ctx, msg, `旧语法已废弃：.ai memo ${raw2} 不再作为子命令，请改用范围参数 --u/--g，例如【.ai memo list --u】查看个人记忆、【.ai memo list --g】查看群聊记忆`);
                    return ret;
                }
                seal.replyToSender(ctx, msg, MEMO_HELP);
                return ret;
            }
        }
    }
}