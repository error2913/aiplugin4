// .ai off：关闭 AI（整体或按模式）
import { JudgeManager } from "../../judge/judge_manager";
import { TimerManager } from "../../timer";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdOff() {
    const cmd = new SubCmd('off');
    cmd.desc = '关闭AI（含非指令正则触发）';
    cmd.help = `帮助:
【.ai off】关闭 AI 及全部触发模式
【.ai off --<参数>】按模式关闭（--r 正则 / --j 打分智能体 / --c 计数器 / --t 计时器 / --p 概率 / --a 活跃时间段）`;
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, session, ret  } = scc;

        const setting = session.setting;

        const kwargs = cmdArgs.kwargs;
        if (kwargs.length == 0) {
            session.resetState();
            TimerManager.removeTimers(sid, '', ['activeTime'], []);
            JudgeManager.clearSession(sid);

            setting.counter = -1;
            setting.timer = -1;
            setting.prob = -1;
            setting.regexTrigger = false;
            setting.judge = false;
            setting.standby = false;
            setting.activeTimeInfo = {
                start: 0,
                end: 0,
                segs: 0,
            }

            seal.replyToSender(ctx, msg, 'AI已关闭');
            session.save();
            return ret;
        }

        let text = `AI已关闭：`;
        kwargs.forEach(kwarg => {
            const name = kwarg.name;

            switch (name) {
                case 'r':
                case 'regex': {
                    setting.regexTrigger = false;
                    text += `\n非指令正则触发`;
                    break;
                }
                case 'j':
                case 'judge': {
                    setting.judge = false;
                    JudgeManager.clearSession(sid);
                    text += `\n打分智能体触发`;
                    break;
                }
                case 'c':
                case 'counter': {
                    session.context.counter = 0;
                    setting.counter = -1;
                    text += `\n计数器模式`;
                    break;
                }
                case 't':
                case 'timer': {
                    if (session.context.timer) clearTimeout(session.context.timer);
                    session.context.timer = null;
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
        session.save();
        return ret;
    }
}
