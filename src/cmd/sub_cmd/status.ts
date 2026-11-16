// .ai status：查看当前会话 AI 状态（平台/权限/轮数/缓存率/触发开关，只读、无副作用）
import Config from "../../config/config";
import Model from "../../model/model";
import { type CacheWindowLike, formatCachePercent } from "../../utils/cache_rate";
import { platformOf } from "../../utils/target_id";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/**
 * 缓存率展示（纯只读观测）。
 * 任何未装配/异常都降级成一行提示，绝不让 status 本体失败。
 */
function formatCacheRateSafe(session: { cacheWindow?: CacheWindowLike }): string {
    try {
        return formatCachePercent(session.cacheWindow);
    } catch {
        return '-（本会话暂无数据）';
    }
}

export function registerCmdStatus() {
    const cmd = new SubCmd('status');
    cmd.desc = '查看当前AI状态';
    cmd.help = `帮助:
【.ai status】查看当前会话 AI 状态（平台/权限/上下文轮数/缓存率/各触发模式开关，只读）
连接与模型列表看 .ai model（骰主）；触发域看 .ai trg（规则/定时器）；会话运行看 .ai live`;
    cmd.priv = { priv: U };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, sid, session, ret } = scc;
        const setting = session.setting;

        seal.replyToSender(ctx, msg, `${sid}
        平台: ${platformOf(ctx) || '未知'}
        会话类型: ${session.sessionType === 'user' ? '私聊' : '群聊'}
        模型: ${Model.getChatModel('chat')?.name || '未配置'}
        权限: ${setting.priv}
        上下文轮数: ${session.context.messages.filter(m => m.role === 'user').length}
        缓存率: ${formatCacheRateSafe(session)}
        AI 总闸: ${setting.aiEnabled ? '开启' : '关闭'}
        非指令正则触发: ${setting.regexTrigger ? '开启' : '关闭'}
        @ 触发(配置页): ${Config.trigger.AT_TRIGGER ? '开启' : '关闭'}
        事件触发(e): ${setting.eventTrigger ? '开启' : '关闭'}
        计数器模式(c): ${setting.counter > -1 ? `${setting.counter}条` : '关闭'}
        延迟模式(d): ${setting.timer > -1 ? `${setting.timer}秒` : '关闭'}
        概率模式(p): ${setting.prob > -1 ? `${setting.prob}%` : '关闭'}
        timer 模式(t): ${setting.timerTrigger ? '开启' : '关闭'}
        活跃时间模式(a): ${setting.activeMode ? '开启' : '关闭'}
        评分触发(j): ${setting.judge ? '开启' : '关闭'}`);
        return ret;
    }
}
