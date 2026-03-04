import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdStatus() {
    const cmd = new SubCmd('status');
    cmd.desc = '查看当前AI状态';
    cmd.help = '';
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, ai, ret } = scc;
        const setting = ai.setting;
        const { start, end, segs } = setting.activeTimeInfo;

        seal.replyToSender(ctx, msg, `${sid}
        权限: ${setting.priv}
        上下文轮数: ${ai.context.messages.filter(m => m.role === 'user').length}
        计数器模式(c): ${setting.counter > -1 ? `${setting.counter}条` : '关闭'}
        计时器模式(t): ${setting.timer > -1 ? `${setting.timer}秒` : '关闭'}
        概率模式(p): ${setting.prob > -1 ? `${setting.prob}%` : '关闭'}
        活跃时间段: ${(start !== 0 || end !== 0) ? `${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}` : '未设置'}
        活跃次数: ${segs > 0 ? segs : '未设置'}
        待机模式: ${setting.standby ? '开启' : '关闭'}`);
        return ret;
    }
}
