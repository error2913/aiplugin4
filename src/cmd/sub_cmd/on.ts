// .ai on：开启 AI 及计数器/计时器/概率/活跃时间模式
import Config from "../../config/config";
import { TimerManager } from "../../timer";
import { S } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdOn() {
    const cmd = new SubCmd('on');
    cmd.desc = '开启AI';
    cmd.help = `帮助:
【.ai on】开启 AI：强制开启正则 + 事件触发（其它模式开关不变）
【.ai on --<参数>=<数字>】按模式开启

<参数>:
【r】非指令正则触发开关
【e】事件触发开关，接收事件后按「事件触发规则」响应
【c】计数器模式，接收消息数达到后触发
单位/条，默认10条
【t】延迟模式，最后一条消息后静默 N 秒触发
单位/秒，默认60秒
【p】概率模式，每条消息按概率触发
单位/%，默认10%
【a】活跃时间段和活跃次数（参数为空时用「触发活跃时间」配置）
格式为"开始时间-结束时间-活跃次数"(如"09:00-18:00-5")
【j】评分触发开关，开启后由评分智能体判断是否插话（无参数）

更多模式（at / timer / 链规则）见 .ai trg

【.ai on --t --p=42】使用示例`;
    cmd.priv = { priv: S };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, session, ret  } = scc;

        const setting = session.setting;

        const kwargs = cmdArgs.kwargs;
        if (kwargs.length == 0) {
            // M2 语义：on 打开 AI 总闸，并只强制开启 regex/event（其它模式开关保持原值）
            setting.aiEnabled = true;
            setting.regexTrigger = true;
            setting.eventTrigger = true;
            seal.replyToSender(ctx, msg, 'AI已开启：非指令正则触发、事件触发');
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
                // C2：活跃时间参数已改为全局「触发活跃时间」，不再接受按会话自定义时段
                if (exist) {
                    seal.replyToSender(ctx, msg, '活跃时间已改为全局配置「触发活跃时间」：请用 .ai trg active on（不带值）');
                    return ret;
                }
                if (Config.trigger.ACTIVE_TIME_SEGMENTS.length === 0) {
                    seal.replyToSender(ctx, msg, '「触发活跃时间」为空，请先在触发页填写时段，再用 .ai trg active on');
                    return ret;
                }
            }
        }

        for (const kwarg of kwargs) {
            const name = kwarg.name;
            const exist = kwarg.valueExists;
            const valInt = parseInt(kwarg.value);
            const valFloat = parseFloat(kwarg.value);

            switch (name) {
                case 'j':
                case 'judge': {
                    setting.judge = true;
                    text += "\n评分触发: 开启";
                    break;
                }
                case 'r':
                case 'regex': {
                    setting.regexTrigger = true;
                    text += `\n非指令正则触发: 开启`;
                    break;
                }
                case 'e':
                case 'event': {
                    setting.eventTrigger = true;
                    text += `\n事件触发: 开启`;
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
                    // 全局多段活跃时间：开关按会话，参数只来自「触发活跃时间」
                    setting.activeMode = true;
                    TimerManager.removeTimers(sid, '', ['activeTime'], []);
                    session.checkActiveTimer(ctx);
                    text += `\n活跃时间模式: 开启（全局 ${Config.trigger.ACTIVE_TIME_SEGMENTS.length} 段）`;
                    break;
                }
            }
        };

        setting.aiEnabled = true;

        seal.replyToSender(ctx, msg, text);
        session.save();
        return ret;
    }
}
