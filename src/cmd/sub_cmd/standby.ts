// .ai standby：开启待机模式（记录对话内容）
import { TimerManager } from "../../timer";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdStandby() {
    const cmd = new SubCmd('standby');
    cmd.desc = '开启待机模式，此时AI将记录聊天内容';
    cmd.help = '';
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, session, ret  } = scc;

        const setting = session.setting;

        session.resetState();
        TimerManager.removeTimers(sid, '', ['activeTime'], []);

        setting.counter = -1;
        setting.timer = -1;
        setting.prob = -1;
        setting.standby = true;
        setting.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0,
        }

        seal.replyToSender(ctx, msg, 'AI已开启待机模式');
        session.save();
        return ret;
    }
}
