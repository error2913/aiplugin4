// .ai standby：开启/关闭待机模式（记录对话内容）
import { TimerManager } from "../../timer";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

export function registerCmdStandby() {
    const cmd = new SubCmd('standby');
    cmd.desc = '开启/关闭待机模式：记录聊天内容、不主动发言（非指令关键词触发仍可发言）';
    cmd.help = `帮助:
【.ai standby】开启待机模式：记录聊天内容、不主动发言（非指令关键词触发仍可发言）
【.ai standby on】同【.ai standby】，开启待机模式
【.ai standby off】仅关闭待机模式，保留计数器/计时器/概率/活跃时间段等其它触发模式（适合只播报不读群消息的机器人）`;
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, session, ret  } = scc;

        const setting = session.setting;
        const mode = (cmdArgs.getArgN(2) || '').trim().toLowerCase();

        if (mode === 'off') {
            // 单独关闭待机：只摘掉待机旗标，保留其它触发模式与运行态（不 resetState、不清定时器）
            setting.standby = false;
            seal.replyToSender(ctx, msg, 'AI已关闭待机模式');
            session.save();
            return ret;
        }

        // 无参数或 on：开启待机（保持原有行为）
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
