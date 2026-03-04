import { AIManager } from "../../AI/AI";
import { TimerManager } from "../../timer";
import { S } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdOn() {
    const cmd = new SubCmd('on');
    cmd.desc = '开启AI';
    cmd.help = `帮助:
【.ai on --<参数>=<数字>】

<参数>:
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
        const { ctx, msg, cmdArgs, sid, ai, ret } = scc;

        const setting = ai.setting;

        const kwargs = cmdArgs.kwargs;
        if (kwargs.length == 0) {
            seal.replyToSender(ctx, msg, cmd.help);
            return ret;
        }

        let text = `AI已开启：`;
        for (const kwarg of kwargs) {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const valInt = parseInt(kwarg.value);
            const valFloat = parseFloat(kwarg.value);
            const valStr = kwarg.value.trim();

            switch (name) {
                case 'c':
                case 'counter': {
                    ai.context.counter = 0;
                    setting.counter = exist && !isNaN(valInt) ? valInt : 10;
                    text += `\n计数器模式:${setting.counter}条`;
                    break;
                }
                case 't':
                case 'timer': {
                    clearTimeout(ai.context.timer);
                    ai.context.timer = null;
                    setting.timer = exist && !isNaN(valFloat) ? valFloat : 60;
                    text += `\n计时器模式:${setting.timer}秒`;
                    break;
                }
                case 'p':
                case 'prob': {
                    setting.prob = exist && !isNaN(valFloat) ? valFloat : 10;
                    text += `\n概率模式:${setting.prob}%`;
                    break;
                }
                case 'a':
                case 'active': {
                    if (!exist) {
                        seal.replyToSender(ctx, msg, '请输入活跃时间段');
                        return ret;
                    }

                    const arr = valStr.split('-').map((item, index) => {
                        const parts = item.split(/[:：,，]+/).map(Number).map(i => isNaN(i) ? 0 : i);
                        if (index < 2) {
                            return Math.ceil((parts[0] * 60 + (parts[1] || 0)) % (24 * 60));
                        } else {
                            return parts[0];
                        }
                    })

                    const [start = 0, end = 0, segs = 1] = arr;

                    if (start === end) {
                        seal.replyToSender(ctx, msg, '活跃时间段开始时间和结束时间不能相同');
                        return ret;
                    }

                    if (!Number.isInteger(segs)) {
                        seal.replyToSender(ctx, msg, '活跃次数必须为整数');
                        return ret;
                    }

                    const endReal = end >= start ? end : end + 24 * 60;
                    if (segs > endReal - start) {
                        seal.replyToSender(ctx, msg, '活跃次数不能大于活跃时间段分钟数');
                        return ret;
                    }

                    TimerManager.removeTimers(sid, '', ['activeTime'], []);
                    setting.activeTimeInfo = {
                        start,
                        end,
                        segs,
                    }

                    text += `\n活跃时间段:${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}`;
                    text += `\n活跃次数:${segs}`;

                    const curSegIndex = ai.curActiveTimeSegIndex;
                    const nextTimePoint = ai.getNextTimePoint(curSegIndex);
                    if (nextTimePoint !== -1) {
                        TimerManager.addActiveTimeTimer(ctx, ai, nextTimePoint);
                    }
                    break;
                }
            }
        };

        setting.standby = true;

        seal.replyToSender(ctx, msg, text);
        AIManager.saveAI(sid);
        return ret;
    }
}
