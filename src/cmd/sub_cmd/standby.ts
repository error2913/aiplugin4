import { AIManager } from "../../AI/AI";
import { TimerManager } from "../../timer";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdStandby() {
    const cmd = new SubCmd('standby');
    cmd.desc = '开启待机模式，此时AI将记录聊天内容';
    cmd.help = '';
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, ai, ret } = scc;

        const setting = ai.setting;

        ai.resetState();
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
        AIManager.saveAI(sid);
        return ret;
    }
}