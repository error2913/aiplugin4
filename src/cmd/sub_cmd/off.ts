import { AIManager } from "../../AI/AI";
import { TimerManager } from "../../timer";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdOff() {
    const cmd = new SubCmd('off');
    cmd.desc = '关闭AI，此时仍能用正则匹配触发';
    cmd.help = '';
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, ai, ret } = scc;

        const setting = ai.setting;

        const kwargs = cmdArgs.kwargs;
        if (kwargs.length == 0) {
            ai.resetState();
            TimerManager.removeTimers(sid, '', ['activeTime'], []);

            setting.counter = -1;
            setting.timer = -1;
            setting.prob = -1;
            setting.standby = false;
            setting.activeTimeInfo = {
                start: 0,
                end: 0,
                segs: 0,
            }

            seal.replyToSender(ctx, msg, 'AI已关闭');
            AIManager.saveAI(sid);
            return ret;
        }

        let text = `AI已关闭：`;
        kwargs.forEach(kwarg => {
            const name = kwarg.name;

            switch (name) {
                case 'c':
                case 'counter': {
                    ai.context.counter = 0;
                    setting.counter = -1;
                    text += `\n计数器模式`;
                    break;
                }
                case 't':
                case 'timer': {
                    clearTimeout(ai.context.timer);
                    ai.context.timer = null;
                    setting.timer = -1;
                    text += `\n计时器模式`;
                    break;
                }
                case 'p':
                case 'prob': {
                    setting.prob = -1;
                    text += `\n概率模式`;
                    break;
                }
                case 'a':
                case 'active': {
                    TimerManager.removeTimers(sid, '', ['activeTime'], []);
                    setting.activeTimeInfo = {
                        start: 0,
                        end: 0,
                        segs: 0,
                    }
                    text += `\n活跃时间段`;
                    break;
                }
            }
        });

        seal.replyToSender(ctx, msg, text);
        AIManager.saveAI(sid);
        return ret;
    }
}