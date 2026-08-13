// .ai memo：个人/群聊/短期记忆与设定管理
import Config from "../../config/config";
import { Session } from "../../session/session";
import { getSession } from "../../session/session_service";
import { stripInternalTags } from "../../utils/string";
import { aliasToCmd } from "../../utils/utils";
import { I, S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 受保护记忆：其他会话创建的私有记忆仅创建会话可删（与工具层 del_memory / clear_memory 一致） */
function protectedMemoryIds(target: Session, callerSessionId: string): Set<string> {
    const ids = new Set<string>();
    if (target.sessionId !== callerSessionId) {
        for (const m of target.memory.memories) {
            if (m.visibility === 'private' && m.sessionId !== callerSessionId) ids.add(m.id);
        }
    }
    return ids;
}

export function registerCmdMemory() {
    const cmd = new SubCmd('memory');
    cmd.desc = '记忆相关操作';
    cmd.help = `帮助:
     【.ai memo status (@xxx)】查看记忆状态，@为查看个人记忆状态
     【.ai memo [p/g] st <内容>】设置个人/群聊设定
     【.ai memo [p/g] st clr】清除个人/群聊设定
     【.ai memo [p/g] del <ID1> <ID2> --关键词1 --关键词2】删除个人/群聊记忆
     【.ai memo [p/g/short] list】展示个人/群聊/短期记忆
     【.ai memo [p/g/short] clr】清除个人/群聊/短期记忆
     【.ai memo short [on/off]】开启/关闭短期记忆
     【.ai memo sum】立即总结一次短期记忆
     【.ai memo sum clr】清除总结记忆`;
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
                    list: { priv: U },
                    clear: { priv: U }
                }
            },
            short: {
                priv: S, args: {
                    list: { priv: U },
                    clear: { priv: U },
                    on: { priv: U },
                    off: { priv: U }
                }
            },
            sum: { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, epId, session, page, ret  } = scc;

        const sessionCtx = seal.getCtxProxyFirst(ctx, cmdArgs);
        const targetUserId = sessionCtx.player!.userId;

        const targetSession = getSession(targetUserId);
        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'status': {
                let statusSession = session;
                if (cmdArgs.at.length > 0 && (cmdArgs.at.length !== 1 || cmdArgs.at[0].userId !== epId)) {
                    statusSession = targetSession;
                }
                const { MEMORY: isMemory, SUMMARY: isShortMemory } = Config.memory;
                seal.replyToSender(ctx, msg, `${statusSession.id}
     长期记忆开启状态: ${isMemory ? '是' : '否'}
     长期记忆条数: ${statusSession.memory.memoryIds.length}
     关键词库: ${statusSession.memory.keywords.join('、') || '无'}
     短期记忆开启状态: ${(isShortMemory && statusSession.memory.useShortMemory) ? '是' : '否'}
     短期记忆条数: ${statusSession.memory.shortMemoryList.length}`);
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
                                targetSession.memory.persona = '无';
                                seal.replyToSender(ctx, msg, '设定已清除');
                                targetSession.save();
                                return ret;
                            }
                            default: {
                                if (s.length > 20) {
                                    seal.replyToSender(ctx, msg, '设定过长，请控制在20字以内');
                                    return ret;
                                }
                                targetSession.memory.persona = stripInternalTags(s);
                                seal.replyToSender(ctx, msg, '设定已修改');
                                targetSession.save();
                                return ret;
                            }
                        }
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
                                session.memory.persona = '无';
                                seal.replyToSender(ctx, msg, '设定已清除');
                                session.save();
                                return ret;
                            }
                            default: {
                                if (s.length > 30) {
                                    seal.replyToSender(ctx, msg, '设定过长，请控制在30字以内');
                                    return ret;
                                }
                                session.memory.persona = stripInternalTags(s);
                                seal.replyToSender(ctx, msg, '设定已修改');
                                session.save();
                                return ret;
                            }
                        }
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
            case 'short': {
                const val3 = cmdArgs.getArgN(3);
                switch (aliasToCmd(val3)) {
                    case 'on': {
                        session.memory.useShortMemory = true;
                        seal.replyToSender(ctx, msg, '短期记忆已开启');
                        session.save();
                        return ret;
                    }
                    case 'off': {
                        session.memory.useShortMemory = false;
                        seal.replyToSender(ctx, msg, '短期记忆已关闭');
                        session.save();
                        return ret;
                    }
                    case 'list': {
                        if (session.memory.shortMemoryList.length === 0) {
                            seal.replyToSender(ctx, msg, '短期记忆为空');
                            return ret;
                        }
                        seal.replyToSender(ctx, msg, session.memory.shortMemoryList
                            .map((item, index) => `${index + 1}. ${item}`)
                            .slice((page - 1) * 10, page * 10)
                            .join('\n') + `\n当前页码: ${page}/${Math.ceil(session.memory.shortMemoryList.length / 10)}`);
                        return ret;
                    }
                    case 'clear': {
                        session.memory.clearShortMemory();
                        seal.replyToSender(ctx, msg, '短期记忆已清除');
                        session.save();
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, `参数缺失
     【.ai memo short list】展示短期记忆
     【.ai memo short clr】清除短期记忆
     【.ai memo short [on/off]】开启/关闭短期记忆`);
                        return ret;
                    }
                }
            }
            case 'sum': {
                const val3 = cmdArgs.getArgN(3);
                if (aliasToCmd(val3) === 'clear') {
                    session.memory.clearSummaries();
                    session.save();
                    seal.replyToSender(ctx, msg, '总结记忆已清除');
                    return ret;
                }
                session.context.summaryCounter = 0;
                await session.memory.updateShortMemory(ctx, msg, session)
                seal.replyToSender(ctx, msg, session.memory.shortMemoryList
                    .map((item, index) => `${index + 1}. ${item}`)
                    .slice((page - 1) * 10, page * 10)
                    .join('\n') + `\n当前页码: ${page}/${Math.ceil(session.memory.shortMemoryList.length / 10)}`);
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
     【.ai memo status (@xxx)】查看记忆状态，@为查看个人记忆状态
     【.ai memo [p/g] st <内容>】设置个人/群聊设定
     【.ai memo [p/g] st clr】清除个人/群聊设定
     【.ai memo [p/g] del <ID1> <ID2> --关键词1 --关键词2】删除个人/群聊记忆
     【.ai memo [p/g/short] list】展示个人/群聊/短期记忆
     【.ai memo [p/g/short] clr】清除个人/群聊/短期记忆
     【.ai memo short [on/off]】开启/关闭短期记忆
     【.ai memo sum】立即总结一次短期记忆
     【.ai memo sum clr】清除总结记忆`);
                return ret;
            }
        }
    }
}
