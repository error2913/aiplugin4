// .ai memo：个人/群聊/观察记忆与设定管理
import Config from "../../config/config";
import { MemoryManager } from "../../memory/manager";
import { bumpMemoryRevision } from "../../memory/revision";
import { resolveBankId } from "../../memory/v2/bank_resolver";
import { getMemoryEngine, MENTAL_MODEL_PERSONA_QUESTION } from "../../memory/v2/index";
import { Session } from "../../session/session";
import { getSession } from "../../session/session_service";
import { fmtDate, stripInternalTags } from "../../utils/string";
import { normalizeUserId, platformOf } from "../../utils/target_id";
import { aliasToCmd } from "../../utils/utils";
import { I, S, U } from "../privilege";
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

export function registerCmdMemory() {
    const cmd = new SubCmd('memory');
    cmd.desc = '记忆相关操作';
    cmd.help = `帮助:
       【.ai memo status [用户ID]】查看记忆状态，传用户ID时查看对应个人记忆
       【.ai memo p|g add <内容>】添加个人/群聊记忆
       【.ai memo p|g list [页码]】展示个人/群聊记忆
       【.ai memo p|g update <ID> <新内容>】更新个人/群聊记忆
       【.ai memo p|g delete <ID1> <ID2> --关键词1 --关键词2】删除个人/群聊记忆
       【.ai memo p|g clear】清除个人/群聊记忆
       【.ai memo p|g st <内容>】设置个人/群聊设定（写入心智模型）
       【.ai memo p|g st clr】清除个人/群聊设定（删除心智模型）
       【.ai memo obs [on/off]】开启/关闭观察记忆
       【.ai memo obs list】展示观察记忆
       【.ai memo obs】立即生成一次观察记忆
       【.ai memo obs clr】清除观察记忆
       【.ai memo consolidate】立即巩固一次记忆（合并重复观察、清理过期记忆）
       【.ai memo reflect <问题>】基于记忆进行推理
       【.ai memo mm list [页码]】查看心智模型列表
       【.ai memo mm view <ID>】查看心智模型详情
       【.ai memo mm add <问题> [答案]】添加心智模型（不填答案时自动推理）
       【.ai memo mm refresh [ID]】刷新心智模型（基于当前记忆重新推理）
       【.ai memo mm del <ID>】删除心智模型`;
    cmd.priv = {
        priv: U, args: {
            status: { priv: U },
            private: {
                priv: U, args: {
                    set: {
                        priv: U, args: {
                            clear: { priv: U },
                            "*": { priv: U }
                        }
                    },
                    delete: { priv: U },
                    add: { priv: U },
                    update: { priv: U },
                    list: { priv: U },
                    clear: { priv: U }
                }
            },
            group: {
                priv: I, args: {
                    set: {
                        priv: U, args: {
                            clear: { priv: U },
                            "*": { priv: U }
                        }
                    },
                    delete: { priv: U },
                    add: { priv: U },
                    update: { priv: U },
                    list: { priv: U },
                    clear: { priv: U }
                }
            },
            obs: {
                priv: U, args: {
                    list: { priv: U },
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
            }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, page, ret  } = scc;

        const rawPlayerId = ctx.player?.userId || '';
        const currentUserId = normalizeUserId(rawPlayerId, platformOf(ctx))
            || (ctx.isPrivate && session.sessionId ? session.sessionId : null);
        if (!currentUserId) {
            seal.replyToSender(ctx, msg, `当前消息缺少有效用户ID（player=${rawPlayerId || '空'}, session=${session.sessionId || '空'}）`);
            return ret;
        }
        const sessionCtx = ctx;
        const targetSession = getSession(currentUserId);
        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'status': {
                let statusSession = session;
                const targetUserId = cmdArgs.getArgN(3);
                if (targetUserId) {
                    const normalizedUserId = normalizeUserId(targetUserId, platformOf(ctx));
                    if (!normalizedUserId) {
                        seal.replyToSender(ctx, msg, '参数无效，【.ai memo status [用户ID]】');
                        return ret;
                    }
                    statusSession = getSession(normalizedUserId);
                }
                const { MEMORY: isMemory, SUMMARY: isSummary } = Config.memory;
                const summaryEffective = statusSession.memory.summaryOverride === false ? false : statusSession.memory.summaryOverride === true ? true : isSummary;
                const summarySuffix = statusSession.memory.summaryOverride === undefined ? '' : '（会话级）';
                const statusBank = resolveBankId(statusSession.sessionId, statusSession.sessionType === 'group' ? 'group' : 'user', statusSession.agentName);
                const statusModels = getMemoryEngine().listMentalModels(statusBank.bankId);
                const modelOverview = statusModels.length === 0 ? '（空）' : statusModels.map(m => `${m.question}${m.version > 1 ? `(v${m.version})` : ''}`).join('；');
                seal.replyToSender(ctx, msg, `${statusSession.id}
     长期记忆开启状态: ${isMemory ? '是' : '否'}
     长期记忆条数: ${statusSession.memory.memoryIds.length}
     观察记忆开启状态: ${summaryEffective ? '是' : '否'}${summarySuffix}
     观察记忆条数: ${getMemoryEngine().repository.listObservations(statusBank.bankId).length}
     心智模型条数: ${statusModels.length}
     心智模型概览: ${modelOverview}`);
                return ret;
            }
            case 'private': {
                const val3 = cmdArgs.getArgN(3);
                switch (aliasToCmd(val3)) {
                    case 'set': {
                        const s = cmdArgs.getRestArgsFrom(4);
                        switch (aliasToCmd(s)) {
                            case '': {
                                seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p st <内容>】设置个人设定，【.ai memo p st clr】清除个人设定');
                                return ret;
                            }
                            case 'clear': {
                                const bank = resolveBankId(targetSession.sessionId, 'user', targetSession.agentName);
                                const mm = getMemoryEngine().listMentalModels(bank.bankId).find(m => m.question === MENTAL_MODEL_PERSONA_QUESTION);
                                if (mm) getMemoryEngine().deleteMentalModel(bank.bankId, mm.id);
                                targetSession.memory.persona = '无';
                                bumpMemoryRevision();
                                seal.replyToSender(ctx, msg, '设定已清除（心智模型已删除）');
                                targetSession.save();
                                return ret;
                            }
                            default: {
                                if (s.length > 500) {
                                    seal.replyToSender(ctx, msg, '设定过长，请控制在500字以内');
                                    return ret;
                                }
                                const bank = resolveBankId(targetSession.sessionId, 'user', targetSession.agentName);
                                getMemoryEngine().ensureBank(bank.bankId, bank.kind, bank.agentName);
                                await getMemoryEngine().createMentalModel(bank.bankId, MENTAL_MODEL_PERSONA_QUESTION, stripInternalTags(s), [`user:${targetSession.sessionId}`]);
                                targetSession.memory.persona = '无';
                                bumpMemoryRevision();
                                seal.replyToSender(ctx, msg, '设定已修改（已写入心智模型）');
                                targetSession.save();
                                return ret;
                            }
                        }
                    }
                    case 'add': {
                        const content = cmdArgs.getRestArgsFrom(4);
                        if (!content) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p add <内容>】添加个人记忆');
                            return ret;
                        }
                        const result = await targetSession.memory.retainMemory(null, targetSession, [], [], [], [], stripInternalTags(content), 'public', undefined, 0.5);
                        targetSession.save();
                        seal.replyToSender(ctx, msg, result.unitIds[0] ? `个人记忆已添加<${result.unitIds[0]}>` : '个人记忆已添加');
                        return ret;
                    }
                    case 'update': {
                        const id = cmdArgs.getArgN(4);
                        const content = cmdArgs.getRestArgsFrom(5);
                        if (!id || !content) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p update <ID> <新内容>】更新个人记忆');
                            return ret;
                        }
                        const bankId = resolveBankId(targetSession.sessionId, 'user', targetSession.agentName).bankId;
                        const unit = getMemoryEngine().repository.getUnit(bankId, id);
                        if (!unit) {
                            seal.replyToSender(ctx, msg, `未找到记忆<${id}>`);
                            return ret;
                        }
                        unit.text = stripInternalTags(content);
                        unit.updatedAt = Math.floor(Date.now() / 1000);
                        getMemoryEngine().repository.updateUnit(bankId, unit);
                        bumpMemoryRevision();
                        targetSession.save();
                        seal.replyToSender(ctx, msg, `记忆已更新<${unit.id}>`);
                        return ret;
                    }
                    case 'delete': {
                        const idList = cmdArgs.args.slice(3);
                        const kw = cmdArgs.kwargs.map(item => item.name);
                        if (idList.length === 0 && kw.length === 0) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo p del <ID1> <ID2> --关键词1 --关键词2】删除个人记忆');
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
                        seal.replyToSender(ctx, msg, targetSession.memory.getLatestMemoryListText({
                            isPrivate: true,
                            id: sessionCtx.player!.userId,
                            name: sessionCtx.player!.name
                        }, page) || '记忆已全部清除');
                        targetSession.save();
                        return ret;
                    }
                    case 'list': {
                        seal.replyToSender(ctx, msg, targetSession.memory.getLatestMemoryListText({
                            isPrivate: true,
                            id: sessionCtx.player!.userId,
                            name: sessionCtx.player!.name
                        }, page) || '无记忆');
                        return ret;
                    }
                    case 'clear': {
                        // 与工具层一致：保留其他会话创建的私有记忆
                        const protectedIds = protectedMemoryIds(targetSession, session.sessionId);
                        if (protectedIds.size > 0) {
                            const deleteIds = targetSession.memory.memoryIds.filter(id => !protectedIds.has(id));
                            if (deleteIds.length === 0) {
                                seal.replyToSender(ctx, msg, '无可清除的记忆（存在其他会话创建的私有记忆）');
                                return ret;
                            }
                            targetSession.memory.deleteMemory(deleteIds);
                            seal.replyToSender(ctx, msg, `个人记忆已清除（保留 ${protectedIds.size} 条其他会话的私有记忆）`);
                            targetSession.save();
                            return ret;
                        }
                        targetSession.memory.clearMemory();
                        seal.replyToSender(ctx, msg, '个人记忆已清除');
                        targetSession.save();
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, `参数缺失:
     【.ai memo p st <内容>】设置个人设定
     【.ai memo p st clr】清除个人设定
     【.ai memo p del <ID1> <ID2> --关键词1 --关键词2】删除个人记忆
     【.ai memo p list】展示个人记忆
     【.ai memo p clr】清除个人记忆`);
                        return ret;
                    }
                }
            }
            case 'group': {
                if (ctx.isPrivate) {
                    seal.replyToSender(ctx, msg, '群聊记忆仅在群聊可用');
                    return ret;
                }

                const val3 = cmdArgs.getArgN(3);
                switch (aliasToCmd(val3)) {
                    case 'set': {
                        const s = cmdArgs.getRestArgsFrom(4);
                        switch (aliasToCmd(s)) {
                            case '': {
                                seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g st <内容>】设置群聊设定，【.ai memo g st clr】清除群聊设定');
                                return ret;
                            }
                            case 'clear': {
                                const bank = resolveBankId(session.sessionId, 'group', session.agentName);
                                const mm = getMemoryEngine().listMentalModels(bank.bankId).find(m => m.question === MENTAL_MODEL_PERSONA_QUESTION);
                                if (mm) getMemoryEngine().deleteMentalModel(bank.bankId, mm.id);
                                session.memory.persona = '无';
                                bumpMemoryRevision();
                                seal.replyToSender(ctx, msg, '设定已清除（心智模型已删除）');
                                session.save();
                                return ret;
                            }
                            default: {
                                if (s.length > 500) {
                                    seal.replyToSender(ctx, msg, '设定过长，请控制在500字以内');
                                    return ret;
                                }
                                const bank = resolveBankId(session.sessionId, 'group', session.agentName);
                                getMemoryEngine().ensureBank(bank.bankId, bank.kind, bank.agentName);
                                await getMemoryEngine().createMentalModel(bank.bankId, MENTAL_MODEL_PERSONA_QUESTION, stripInternalTags(s), [`group:${session.sessionId}`]);
                                session.memory.persona = '无';
                                bumpMemoryRevision();
                                seal.replyToSender(ctx, msg, '设定已修改（已写入心智模型）');
                                session.save();
                                return ret;
                            }
                        }
                    }
                    case 'add': {
                        const content = cmdArgs.getRestArgsFrom(4);
                        if (!content) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g add <内容>】添加群聊记忆');
                            return ret;
                        }
                        const result = await session.memory.retainMemory(null, session, [], [], [], [], stripInternalTags(content), 'public', undefined, 0.5);
                        session.save();
                        seal.replyToSender(ctx, msg, result.unitIds[0] ? `群聊记忆已添加<${result.unitIds[0]}>` : '群聊记忆已添加');
                        return ret;
                    }
                    case 'update': {
                        const id = cmdArgs.getArgN(4);
                        const content = cmdArgs.getRestArgsFrom(5);
                        if (!id || !content) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g update <ID> <新内容>】更新群聊记忆');
                            return ret;
                        }
                        const bankId = resolveBankId(session.sessionId, 'group', session.agentName).bankId;
                        const unit = getMemoryEngine().repository.getUnit(bankId, id);
                        if (!unit) {
                            seal.replyToSender(ctx, msg, `未找到记忆<${id}>`);
                            return ret;
                        }
                        unit.text = stripInternalTags(content);
                        unit.updatedAt = Math.floor(Date.now() / 1000);
                        getMemoryEngine().repository.updateUnit(bankId, unit);
                        bumpMemoryRevision();
                        session.save();
                        seal.replyToSender(ctx, msg, `记忆已更新<${unit.id}>`);
                        return ret;
                    }
                    case 'delete': {
                        const idList = cmdArgs.args.slice(3);
                        const kw = cmdArgs.kwargs.map(item => item.name);
                        if (idList.length === 0 && kw.length === 0) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo g del <ID1> <ID2>】删除群聊记忆');
                            return ret;
                        }
                        // 与工具层一致：其他会话创建的私有记忆不可删除（群聊指令目标即当前会话，通常无受保护条目）
                        const protectedIds = protectedMemoryIds(session, session.sessionId);
                        const deleteIds = new Set<string>();
                        for (const id of idList) {
                            if (!protectedIds.has(id)) deleteIds.add(id);
                        }
                        if (kw.length > 0) {
                            for (const m of session.memory.memories) {
                                if (!protectedIds.has(m.id) && kw.some(k => m.tags.includes(k))) deleteIds.add(m.id);
                            }
                        }
                        if (deleteIds.size === 0) {
                            seal.replyToSender(ctx, msg, '没有可删除的记忆（其他会话创建的私有记忆仅创建会话可删除）');
                            return ret;
                        }
                        session.memory.deleteMemory(Array.from(deleteIds));
                        seal.replyToSender(ctx, msg, session.memory.getLatestMemoryListText({
                            isPrivate: false,
                            id: ctx.group!.groupId,
                            name: ctx.group!.groupName
                        }, page) || '记忆已全部清除');
                        session.save();
                        return ret;
                    }
                    case 'list': {
                        seal.replyToSender(ctx, msg, session.memory.getLatestMemoryListText({
                            isPrivate: false,
                            id: ctx.group!.groupId,
                            name: ctx.group!.groupName
                        }, page) || '无记忆');
                        return ret;
                    }
                    case 'clear': {
                        const protectedIds = protectedMemoryIds(session, session.sessionId);
                        if (protectedIds.size > 0) {
                            const deleteIds = session.memory.memoryIds.filter(id => !protectedIds.has(id));
                            if (deleteIds.length === 0) {
                                seal.replyToSender(ctx, msg, '无可清除的记忆（存在其他会话创建的私有记忆）');
                                return ret;
                            }
                            session.memory.deleteMemory(deleteIds);
                            seal.replyToSender(ctx, msg, `群聊记忆已清除（保留 ${protectedIds.size} 条其他会话的私有记忆）`);
                            session.save();
                            return ret;
                        }
                        session.memory.clearMemory();
                        seal.replyToSender(ctx, msg, '群聊记忆已清除');
                        session.save();
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, `参数缺失:
     【.ai memo g st <内容>】设置群聊设定
     【.ai memo g st clr】清除群聊设定
     【.ai memo g del <ID1> <ID2> --关键词1 --关键词2】删除群聊记忆
     【.ai memo g list】展示群聊记忆
     【.ai memo g clr】清除群聊记忆`);
                        return ret;
                    }
                }
            }
            case 'obs': {
                const val3 = aliasToCmd(cmdArgs.getArgN(3));
                switch (val3) {
                    case 'on': {
                        session.memory.summaryOverride = true;
                        session.memory.summaryStatus = true;
                        seal.replyToSender(ctx, msg, '观察记忆已开启');
                        session.save();
                        return ret;
                    }
                    case 'off': {
                        session.memory.summaryOverride = false;
                        session.memory.summaryStatus = false;
                        seal.replyToSender(ctx, msg, '观察记忆已关闭');
                        session.save();
                        return ret;
                    }
                    case 'list': {
                        const summaryPrompt = MemoryManager.buildObservationPrompt(session);
                        if (!summaryPrompt) {
                            seal.replyToSender(ctx, msg, '观察记忆为空');
                            return ret;
                        }
                        seal.replyToSender(ctx, msg, summaryPrompt);
                        return ret;
                    }
                    case 'clear': {
                        const bank = resolveBankId(session.sessionId, session.sessionType === 'group' ? 'group' : 'user', session.agentName);
                        const repo = getMemoryEngine().repository;
                        const bankData = repo.getBank(bank.bankId);
                        if (bankData) {
                            bankData.observations = [];
                            bankData.units = bankData.units.filter(u => u.factType !== 'observation');
                            repo.save(bank.bankId);
                        }
                        session.save();
                        seal.replyToSender(ctx, msg, '观察记忆已清除');
                        return ret;
                    }
                    default: {
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
                await MemoryManager.consolidateMemory(session);
                const bank = resolveBankId(session.sessionId, session.sessionType === 'group' ? 'group' : 'user', session.agentName);
                const obsCount = getMemoryEngine().repository.listObservations(bank.bankId).length;
                seal.replyToSender(ctx, msg, `记忆巩固完成：观察记忆 ${obsCount} 条，长期记忆 ${session.memory.memoryIds.length} 条`);
                return ret;
            }

            case 'reflect': {
                const question = cmdArgs.getRestArgsFrom(3);
                if (!question) {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai memo reflect <问题>】基于记忆推理');
                    return ret;
                }
                const bank = resolveBankId(session.sessionId, session.sessionType === 'group' ? 'group' : 'user', session.agentName);
                const result = await getMemoryEngine().reflect(bank.bankId, question);
                seal.replyToSender(ctx, msg, result.text);
                return ret;
            }

            case 'mm': {
                const mmBank = resolveBankId(session.sessionId, session.sessionType === 'group' ? 'group' : 'user', session.agentName);
                const mmEngine = getMemoryEngine();
                const mmVal3 = aliasToCmd(cmdArgs.getArgN(3));
                switch (mmVal3) {
                    case 'list': {
                        const models = mmEngine.listMentalModels(mmBank.bankId);
                        if (models.length === 0) {
                            seal.replyToSender(ctx, msg, '心智模型为空，【.ai memo mm add <问题> [答案]】添加');
                            return ret;
                        }
                        const perPage = 5;
                        const totalPages = Math.max(1, Math.ceil(models.length / perPage));
                        const pageArg = parseInt(cmdArgs.getArgN(4) || '', 10);
                        const pageNum = pageArg > 0 ? pageArg : page;
                        const cur = Math.min(Math.max(pageNum, 1), totalPages);
                        const items = models.slice((cur - 1) * perPage, cur * perPage);
                        const lines = items.map(m => `${m.id} ${m.question} (v${m.version} · 更新于${fmtDate(m.updatedAt)})`);
                        seal.replyToSender(ctx, msg, `心智模型 ${models.length} 条\n${lines.join('\n')}\n当前页码: ${cur}/${totalPages}`);
                        return ret;
                    }
                    case 'view': {
                        const id = cmdArgs.getArgN(4);
                        if (!id) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo mm view <ID>】查看心智模型详情');
                            return ret;
                        }
                        const m = mmEngine.listMentalModels(mmBank.bankId).find(x => x.id === id);
                        if (!m) {
                            seal.replyToSender(ctx, msg, `未找到心智模型<${id}>`);
                            return ret;
                        }
                        const answer = m.answer.length > 600 ? m.answer.slice(0, 600) + '…' : m.answer;
                        seal.replyToSender(ctx, msg, `【心智模型】${m.question}\n${answer}\nID: ${m.id} · v${m.version}\n范围: ${m.scopeTags.join(', ') || '（全局）'}\n创建: ${fmtDate(m.createdAt)}\n更新: ${fmtDate(m.updatedAt)}`);
                        return ret;
                    }
                    case 'add': {
                        const question = cmdArgs.getArgN(4);
                        if (!question) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo mm add <问题> [答案]】添加心智模型');
                            return ret;
                        }
                        const answer = cmdArgs.getRestArgsFrom(5);
                        const tagKw = cmdArgs.getKwarg('tag');
                        const scopeTags = tagKw && tagKw.value ? [tagKw.value] : [session.sessionType === 'group' ? `group:${session.sessionId}` : `user:${session.sessionId}`];
                        if (!answer) {
                            const result = await mmEngine.reflect(mmBank.bankId, question);
                            const m = await mmEngine.createMentalModel(mmBank.bankId, question, result.text, scopeTags);
                            bumpMemoryRevision();
                            session.save();
                            seal.replyToSender(ctx, msg, `心智模型已添加<${m.id}>\n问题: ${question}\n答案: ${result.text}`);
                            return ret;
                        }
                        const m = await mmEngine.createMentalModel(mmBank.bankId, question, stripInternalTags(answer), scopeTags);
                        bumpMemoryRevision();
                        session.save();
                        seal.replyToSender(ctx, msg, `心智模型已添加<${m.id}>`);
                        return ret;
                    }
                    case 'refresh': {
                        const id = cmdArgs.getArgN(4);
                        if (id) {
                            const exists = mmEngine.listMentalModels(mmBank.bankId).some(x => x.id === id);
                            if (!exists) {
                                seal.replyToSender(ctx, msg, `未找到心智模型<${id}>`);
                                return ret;
                            }
                        }
                        const total = id ? 1 : mmEngine.listMentalModels(mmBank.bankId).length;
                        const updated = await mmEngine.refreshMentalModels(mmBank.bankId, id || undefined);
                        if (updated > 0) bumpMemoryRevision();
                        session.save();
                        seal.replyToSender(ctx, msg, `已刷新 ${updated} 条，跳过 ${total - updated} 条`);
                        return ret;
                    }
                    case 'del': {
                        const id = cmdArgs.getArgN(4);
                        if (!id) {
                            seal.replyToSender(ctx, msg, '参数缺失，【.ai memo mm del <ID>】删除心智模型');
                            return ret;
                        }
                        const ok = mmEngine.deleteMentalModel(mmBank.bankId, id);
                        if (!ok) {
                            seal.replyToSender(ctx, msg, `未找到心智模型<${id}>`);
                            return ret;
                        }
                        bumpMemoryRevision();
                        session.save();
                        seal.replyToSender(ctx, msg, `心智模型已删除<${id}>`);
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, `参数缺失:
     【.ai memo mm list [页码]】查看心智模型列表
     【.ai memo mm view <ID>】查看心智模型详情
     【.ai memo mm add <问题> [答案]】添加心智模型（不填答案时自动推理）
     【.ai memo mm refresh [ID]】刷新心智模型
     【.ai memo mm del <ID>】删除心智模型`);
                        return ret;
                    }
                }
            }

            default: {
                seal.replyToSender(ctx, msg, `帮助:
       【.ai memo status [用户ID]】查看记忆状态，传用户ID时查看对应个人记忆
       【.ai memo p|g add <内容>】添加个人/群聊记忆
       【.ai memo p|g list [页码]】展示个人/群聊记忆
       【.ai memo p|g update <ID> <新内容>】更新个人/群聊记忆
       【.ai memo p|g delete <ID1> <ID2> --关键词1 --关键词2】删除个人/群聊记忆
       【.ai memo p|g clear】清除个人/群聊记忆
       【.ai memo p|g st <内容>】设置个人/群聊设定（写入心智模型）
       【.ai memo p|g st clr】清除个人/群聊设定（删除心智模型）
       【.ai memo obs [on/off]】开启/关闭观察记忆
       【.ai memo obs list】展示观察记忆
       【.ai memo obs】立即生成一次观察记忆
       【.ai memo obs clr】清除观察记忆
       【.ai memo consolidate】立即巩固一次记忆（合并重复观察、清理过期记忆）
       【.ai memo reflect <问题>】基于记忆进行推理
       【.ai memo mm list [页码]】查看心智模型列表
       【.ai memo mm view <ID>】查看心智模型详情
       【.ai memo mm add <问题> [答案]】添加心智模型（不填答案时自动推理）
       【.ai memo mm refresh [ID]】刷新心智模型（基于当前记忆重新推理）
       【.ai memo mm del <ID>】删除心智模型`);
                return ret;
            }
        }
    }
}







