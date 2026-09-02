// .ai status：查看当前会话 AI 状态
import Model from "../../model/model";
import { platformOf } from "../../utils/target_id";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdStatus() {
    const cmd = new SubCmd('status');
    cmd.desc = '查看当前AI状态';
    cmd.help = `帮助:
【.ai status】查看当前会话 AI 状态（平台/权限/上下文轮数/各触发模式）`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, session, ret } = scc;
        const setting = session.setting;
        const { start, end, segs } = setting.activeTimeInfo;

        seal.replyToSender(ctx, msg, `${sid}
        平台: ${platformOf(ctx) || '未知'}
        会话类型: ${session.sessionType === 'user' ? '私聊' : '群聊'}
        模型(全局): ${Model.getChatModel('chat')?.name || '未配置'}
        权限: ${setting.priv}
        上下文轮数: ${session.context.messages.filter(m => m.role === 'user').length}
        非指令正则触发: ${setting.regexTrigger ? '开启' : '关闭'}
        计数器模式(c): ${setting.counter > -1 ? `${setting.counter}条` : '关闭'}
        计时器模式(t): ${setting.timer > -1 ? `${setting.timer}秒` : '关闭'}
        概率模式(p): ${setting.prob > -1 ? `${setting.prob}%` : '关闭'}
        活跃时间段: ${(start !== 0 || end !== 0) ? `${Math.floor(start / 60).toString().padStart(2, '0')}:${(start % 60).toString().padStart(2, '0')}至${Math.floor(end / 60).toString().padStart(2, '0')}:${(end % 60).toString().padStart(2, '0')}` : '未设置'}
        活跃次数: ${segs > 0 ? segs : '未设置'}
        评分触发(j): ${setting.judge ? '开启' : '关闭'}
        待机模式: ${setting.standby ? '开启' : '关闭'}`);
        return ret;
    }
}
