import { TimerManager } from "../../timer";
import { aliasToCmd } from "../../utils/utils";
import { I, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdTimer() {
    const cmd = new SubCmd('timer');
    cmd.desc = '定时器相关';
    cmd.help = `帮助:
【.ai timer lst】查看当前聊天定时器
【.ai timer clr】清除当前聊天定时器`;
    cmd.priv = {
        priv: U, args: {
            list: { priv: U },
            clear: { priv: I }
        }
    };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, page, ret } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'list': {
                seal.replyToSender(ctx, msg, TimerManager.getTimerListText(sid, page) || '当前对话没有定时器');
                return ret;
            }
            case 'clear': {
                TimerManager.removeTimers(sid, '', [], []);
                seal.replyToSender(ctx, msg, '所有定时器已清除');
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, cmd.help);
                return ret;
            }
        }
    }
}
