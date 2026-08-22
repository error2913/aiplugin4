// .ai on：开启 AI 及计数器/计时器/概率/活跃时间模式
import Config from "../../config/config";
import { TimerManager } from "../../timer";
import { parseActivityTime } from "../../utils/string";
import { S } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdOn() {
    const cmd = new SubCmd('on');
    cmd.desc = '开启AI';
    cmd.help = `帮助:
【.ai on --<参数>=<数字>】

<参数>:
【r】非指令正则触发开关
【c】计数器模式，接收消息数达到后触发
单位/条，默认10条
【t】计时器模式，最后一条消息后达到时限触发
单位/秒，默认60秒
【p】概率模式，每条消息按概率触发
单位/%，默认10%
【a】活跃时间段和活跃次数
格式为"开始时间-结束时间-活跃次数"(如"09:00-18:00-5")

【.ai on --t --p=42】使用示例`;
    cmd.priv = { priv: S };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, session, ret  } = scc;

        const setting = session.setting;

        const kwargs = cmdArgs.kwargs;
        if (kwargs.length == 0) {
            setting.regexTrigger = true;
            seal.replyToSender(ctx, msg, 'AI已开启：非指令正则触发');
            session.save();
            return ret;
        }

        let text = `AI已开启：`;
        // 先校验所有参数，避免部分生效
        for (const kwarg of kwargs) {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const valStr = kwarg.value.trim();
            if (name === 'c' || name === 'counter') {
                if (exist) {
                    const parsed = Number(valStr);
                    if (!Number.isInteger(parsed) || parsed <= 0) {
                        seal.replyToSender(ctx, msg, '计数器模式参数必须为正整数');
                        return ret;
                    }
                }
            } else if (name === 't' || name === 'timer') {
                if (exist) {
                    const parsed = Number(valStr);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                        seal.replyToSender(ctx, msg, '计时器模式参数必须大于0');
                        return ret;
                    }
                }
            } else if (name === 'p' || name === 'prob') {
                if (exist) {
                    const parsed = Number(valStr);
                    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
                        seal.replyToSender(ctx, msg, '概率模式参数必须在0-100之间');
                        return ret;
                    }
                }
            } else if (name === 'a' || name === 'active') {
                try {
                    parseActivityTime(exist ? valStr : Config.trigger.ACTIVE_TIME);
                } catch (e) {
                    seal.replyToSender(ctx, msg, e instanceof Error ? e.message : String(e));
                    return ret;
                }
            }
        }

        for (const kwarg of kwargs) {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const valInt = parseInt(kwarg.value);
            const valFloat = parseFloat(kwarg.value);
            const valStr = kwarg.value.trim();

            switch (name) {
                case 'r':
                case 'regex': {
                    setting.regexTrigger = true;
                    text += `\n非指令正则触发: 开启`;
                    break;
                }
                case 'c':
                case 'counter': {
                    session.context.counter = 0;
                    setting.counter = exist && !isNaN(valInt) ? valInt : Config.trigger.COUNTER;
                    text += `\n计数器模式:${setting.counter}条`;
                    break;
                }
                case 't':
                case 'timer': {
                    if (session.context.timer) clearTimeout(session.context.timer);
                    session.context.timer = null;
                    setting.timer = exist && !isNaN(valFloat) ? valFloat : Config.trigger.TIMER;
                    text += `\n计时器模式:${setting.timer}秒`;
                    break;
                }
                case 'p':
                case 'prob': {
                    setting.prob = exist && !isNaN(valFloat) ? valFloat : Config.trigger.PROBABILITY;
                    text += `\n概率模式:${setting.prob}%`;
                    break;
                }
                case 'a':
                case 'active': {
                    try {
                        // 未提供具体时间时，使用“触发”配置中的默认活跃时间
                        const [start, end, segs] = parseActivityTime(exist ? valStr : Config.trigger.ACTIVE_TIME);

                        TimerManager.removeTimers(sid, '', ['activeTime'], []);
                        setting.activeTimeInfo = {
                            start,
                            end,
                            segs,
                        }

                        text += `\n活跃时间段:${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}`;
                        text += `\n活跃次数:${segs}`;

                        const curSegIndex = session.curActiveTimeSegIndex;
                        const nextTimePoint = session.getNextTimePoint(curSegIndex);
                        if (nextTimePoint !== -1) {
                            TimerManager.addActiveTimeTimer(ctx, session, nextTimePoint);
                        }
                        break;
                    } catch (e) {
                        seal.replyToSender(ctx, msg, e instanceof Error ? e.message : String(e));
                        return ret;
                    }
                }
            }
        };

        setting.standby = true;

        seal.replyToSender(ctx, msg, text);
        session.save();
        return ret;
    }
}
