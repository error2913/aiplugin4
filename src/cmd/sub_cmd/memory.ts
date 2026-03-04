import { AIManager } from "../../AI/AI";
import { ConfigManager } from "../../config/configManager";
import { aliasToCmd } from "../../utils/utils";
import { I, S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdMemory() {
    const cmd = new SubCmd('memory');
    cmd.desc = '记忆相关操作';
    cmd.help = '';
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
        const { ctx, msg, cmdArgs, epId, sid, ai, page, ret } = scc;

        const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
        const muid = mctx.player.userId;

        const ai2 = AIManager.getAI(muid);
        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'status': {
                let ai3 = ai;
                if (cmdArgs.at.length > 0 && (cmdArgs.at.length !== 1 || cmdArgs.at[0].userId !== epId)) {
                    ai3 = ai2;
                }
                const { isMemory, isShortMemory } = ConfigManager.memory;
                seal.replyToSender(ctx, msg, `${ai3.id}
     长期记忆开启状态: ${isMemory ? '是' : '否'}
     长期记忆条数: ${ai3.memory.memoryIds.length}
     关键词库: ${ai3.memory.keywords.join('、') || '无'}
     短期记忆开启状态: ${(isShortMemory && ai3.memory.useShortMemory) ? '是' : '否'}
     短期记忆条数: ${ai3.memory.shortMemoryList.length}`);
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
                                ai2.memory.persona = '无';
                                seal.replyToSender(ctx, msg, '设定已清除');
                                AIManager.saveAI(muid);
                                return ret;
                            }
                            default: {
                                if (s.length > 20) {
                                    seal.replyToSender(ctx, msg, '设定过长，请控制在20字以内');
                                    return ret;
                                }
                                ai2.memory.persona = s;
                                seal.replyToSender(ctx, msg, '设定已修改');
                                AIManager.saveAI(muid);
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
                        ai2.memory.deleteMemory(idList, kw);
                        seal.replyToSender(ctx, msg, ai2.memory.getLatestMemoryListText({
                            isPrivate: true,
                            id: mctx.player.userId,
                            name: mctx.player.name
                        }, page) || '记忆已全部清除');
                        AIManager.saveAI(muid);
                        return ret;
                    }
                    case 'list': {
                        seal.replyToSender(ctx, msg, ai2.memory.getLatestMemoryListText({
                            isPrivate: true,
                            id: mctx.player.userId,
                            name: mctx.player.name
                        }, page) || '无记忆');
                        return ret;
                    }
                    case 'clear': {
                        ai2.memory.clearMemory();
                        seal.replyToSender(ctx, msg, '个人记忆已清除');
                        AIManager.saveAI(muid);
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
                                ai.memory.persona = '无';
                                seal.replyToSender(ctx, msg, '设定已清除');
                                AIManager.saveAI(sid);
                                return ret;
                            }
                            default: {
                                if (s.length > 30) {
                                    seal.replyToSender(ctx, msg, '设定过长，请控制在30字以内');
                                    return ret;
                                }
                                ai.memory.persona = s;
                                seal.replyToSender(ctx, msg, '设定已修改');
                                AIManager.saveAI(sid);
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
                        ai.memory.deleteMemory(idList, kw);
                        seal.replyToSender(ctx, msg, ai.memory.getLatestMemoryListText({
                            isPrivate: false,
                            id: ctx.group.groupId,
                            name: ctx.group.groupName
                        }, page) || '记忆已全部清除');
                        AIManager.saveAI(sid);
                        return ret;
                    }
                    case 'list': {
                        seal.replyToSender(ctx, msg, ai.memory.getLatestMemoryListText({
                            isPrivate: false,
                            id: ctx.group.groupId,
                            name: ctx.group.groupName
                        }, page) || '无记忆');
                        return ret;
                    }
                    case 'clear': {
                        ai.memory.clearMemory();
                        seal.replyToSender(ctx, msg, '群聊记忆已清除');
                        AIManager.saveAI(sid);
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
                        ai.memory.useShortMemory = true;
                        seal.replyToSender(ctx, msg, '短期记忆已开启');
                        AIManager.saveAI(sid);
                        return ret;
                    }
                    case 'off': {
                        ai.memory.useShortMemory = false;
                        seal.replyToSender(ctx, msg, '短期记忆已关闭');
                        AIManager.saveAI(sid);
                        return ret;
                    }
                    case 'list': {
                        if (ai.memory.shortMemoryList.length === 0) {
                            seal.replyToSender(ctx, msg, '短期记忆为空');
                            return ret;
                        }
                        seal.replyToSender(ctx, msg, ai.memory.shortMemoryList
                            .map((item, index) => `${index + 1}. ${item}`)
                            .slice((page - 1) * 10, page * 10)
                            .join('\n') + `\n当前页码: ${page}/${Math.ceil(ai.memory.shortMemoryList.length / 10)}`);
                        return ret;
                    }
                    case 'clear': {
                        ai.memory.clearShortMemory();
                        seal.replyToSender(ctx, msg, '短期记忆已清除');
                        AIManager.saveAI(sid);
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
                ai.context.summaryCounter = 0;
                await ai.memory.updateShortMemory(ctx, msg, ai)
                seal.replyToSender(ctx, msg, ai.memory.shortMemoryList
                    .map((item, index) => `${index + 1}. ${item}`)
                    .slice((page - 1) * 10, page * 10)
                    .join('\n') + `\n当前页码: ${page}/${Math.ceil(ai.memory.shortMemoryList.length / 10)}`);
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
     【.ai memo sum】立即总结一次短期记忆`);
                return ret;
            }
        }
    }
}