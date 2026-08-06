// .ai block：黑名单管理（拉黑用户/群，命中时忽略其消息/指令/戳一戳）
import { BlockManager } from "../../block";
import { aliasToCmd } from "../../utils/utils";
import { M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdBlock() {
    const cmd = new SubCmd('block');
    cmd.desc = '黑名单相关操作';
    cmd.help = '';
    cmd.priv = {
        priv: M, args: {
            add: { priv: M },
            remove: { priv: M },
            list: { priv: M },
            help: { priv: U }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, epId, ret } = scc;

        const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
        const muid = cmdArgs.amIBeMentionedFirst ? epId : mctx.player.userId;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'add': {
                let targetId = '';
                let reason = '';
                const arg3 = cmdArgs.getArgN(3);
                const arg4 = cmdArgs.getArgN(4);

                if (cmdArgs.at.length > 0) {
                    targetId = muid;
                    // at 不占参数位：原因从第 3 个参数起（支持多词），如 `.ai block add @xxx 测试 原因`
                    reason = cmdArgs.getRestArgsFrom(3).trim();
                } else if (arg3 && (arg3.startsWith('QQ:') || arg3.startsWith('QQ-Group:'))) {
                    targetId = arg3;
                    reason = arg4;
                } else {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai block add <统一ID/@xxx> <原因>】添加黑名单');
                    return ret;
                }

                if (!reason || reason.trim() === '') {
                    reason = '未填写原因';
                }

                if (BlockManager.checkBlock(targetId)) {
                    seal.replyToSender(ctx, msg, '已经在黑名单中');
                    return ret;
                }

                BlockManager.addBlock(targetId, reason);
                seal.replyToSender(ctx, msg, `已将<${targetId}>加入黑名单，原因: ${reason}`);
                return ret;
            }
            case 'remove': {
                let targetId = '';
                const arg3 = cmdArgs.getArgN(3);

                if (cmdArgs.at.length > 0) {
                    targetId = muid;
                } else if (arg3 && (arg3.startsWith('QQ:') || arg3.startsWith('QQ-Group:'))) {
                    targetId = arg3;
                } else {
                    seal.replyToSender(ctx, msg, '参数缺失，【.ai block rm <统一ID/@xxx>】移除黑名单');
                    return ret;
                }

                if (BlockManager.removeBlock(targetId)) {
                    seal.replyToSender(ctx, msg, `已将<${targetId}>移出黑名单`);
                } else {
                    seal.replyToSender(ctx, msg, '不在黑名单中');
                }
                return ret;
            }
            case 'list': {
                seal.replyToSender(ctx, msg, BlockManager.getListText());
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
【.ai block add <统一ID/@xxx> <原因>】添加黑名单
【.ai block rm <统一ID/@xxx>】移除黑名单
【.ai block list】查看黑名单列表

被拉黑的对象无法触发AI对话`);
                return ret;
            }
        }
    }
}
