// .ai ctxset：按会话覆盖上下文参数（P2-1）
//
// 为什么单独一条命令而不塞进 .ai standby：standby 的 solve 里对"无参数/on/off"三种形态有明确行为
// （开待机时会 resetState + 清定时器），把参数覆盖混进去容易误触这些副作用。本命令只改覆盖值。
import Config from "../../config/config";
import { I } from "../privilege";
import { SubCmd, SubCmdContext } from "../root_cmd";

/** 支持的覆盖项：命令参数名 → overrides 字段 + 全局配置回退值 */
const OVERRIDE_KEYS = {
    window: { field: 'windowMaxChars' as const, label: '窗口上限字数', global: () => Config.context.WINDOW_MAX_CHARS },
    cold: { field: 'coldWindowChars' as const, label: '冷态窗口字数', global: () => Config.context.COLD_WINDOW_CHARS },
    truncate: { field: 'coldTruncate' as const, label: '冷态单条截断字数', global: () => Config.context.COLD_SINGLE_TRUNCATE },
};

export function registerCmdCtxSet() {
    const cmd = new SubCmd('ctxset');
    cmd.desc = '按本会话覆盖上下文参数（窗口/截断等）';
    cmd.help = `帮助:
【.ai ctxset】查看本会话当前覆盖值与全局值
【.ai ctxset window=<字数>】本会话「窗口上限字数」（0 或 clr=清除覆盖，回到全局值）
【.ai ctxset cold=<字数>】本会话「冷态窗口字数」
【.ai ctxset truncate=<字数>】本会话「冷态单条截断字数」
【.ai ctxset clr】清除本会话全部覆盖
说明：只影响本会话；0 不能用来"关闭"某项（要关闭请改全局配置），传 0 等价于清除覆盖。`;
    cmd.priv = { priv: I };
    cmd.solve = (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, session, ret } = scc;
        const setting: any = session.setting;
        if (!setting.overrides || typeof setting.overrides !== 'object') setting.overrides = {};

        // Context v2：会话级覆盖只有 budget / retain（旧的窗口类参数已废弃）
        if (session.contextV2) {
            const arg = (cmdArgs.getArgN(2) || '').trim();
            const sub = arg.toLowerCase();
            const budgetField = 'ctxBudgetTokens';
            const retainField = 'ctxRetainPercent';
            if (!arg) {
                const budget = setting.overrides[budgetField];
                const retain = setting.overrides[retainField];
                seal.replyToSender(ctx, msg, [
                    '本会话 Context v2 覆盖：',
                    `【budget】${typeof budget === 'number' ? budget : '（未覆盖）'} · 全局 ${Config.context.MAX_CONTEXT_TOKENS}（0=跟随模型窗口）`,
                    `【retain】${typeof retain === 'number' ? `${retain}%` : '（未覆盖）'} · 全局 40%`,
                    '',
                    '用【.ai ctxset budget=100000】设置，【.ai ctxset clr】清除',
                ].join('\n'));
                return ret;
            }
            if (sub === 'clr' || sub === 'clear' || sub === 'reset') {
                delete setting.overrides[budgetField];
                delete setting.overrides[retainField];
                session.save();
                seal.replyToSender(ctx, msg, '已清除本会话的 Context v2 覆盖');
                return ret;
            }
            const eq = arg.indexOf('=');
            if (eq <= 0) {
                seal.replyToSender(ctx, msg, '格式：.ai ctxset budget=<token> 或 retain=<百分比>；旧 window/cold/truncate 已废弃');
                return ret;
            }
            const key = arg.slice(0, eq).trim().toLowerCase();
            const rawVal = arg.slice(eq + 1).trim();
            if (key === 'window' || key === 'cold' || key === 'truncate') {
                seal.replyToSender(ctx, msg, '该参数在 Context v2 已废弃；请用 budget / retain');
                return ret;
            }
            if (key !== 'budget' && key !== 'retain') {
                seal.replyToSender(ctx, msg, `未识别参数 ${key}；可用：budget / retain`);
                return ret;
            }
            if (rawVal === 'clr' || rawVal === 'clear' || rawVal === '') {
                delete setting.overrides[key === 'budget' ? budgetField : retainField];
                session.save();
                seal.replyToSender(ctx, msg, `已清除本会话 ${key} 覆盖`);
                return ret;
            }
            const n = parseInt(rawVal, 10);
            const min = key === 'retain' ? 1 : 0;
            const max = key === 'retain' ? 100 : Number.MAX_SAFE_INTEGER;
            if (!Number.isFinite(n) || n < min || n > max) {
                seal.replyToSender(ctx, msg, key === 'retain' ? 'retain 必须是 1-100 的整数' : 'budget 必须是非负整数（0=清除覆盖）');
                return ret;
            }
            if (n === 0 && key === 'budget') delete setting.overrides[budgetField];
            else setting.overrides[key === 'budget' ? budgetField : retainField] = n;
            session.save();
            seal.replyToSender(ctx, msg, `已设置本会话 ${key}=${n}`);
            return ret;
        }

        const arg = (cmdArgs.getArgN(2) || '').trim();
        const sub = arg.toLowerCase();

        // 无参数：展示
        if (!arg) {
            const lines = Object.keys(OVERRIDE_KEYS).map(k => {
                const def = (OVERRIDE_KEYS as any)[k];
                const cur = setting.overrides[def.field];
                const g = def.global();
                return `【${k}】${def.label}：本会话 ${typeof cur === 'number' && cur > 0 ? cur : '（未覆盖）'} · 全局 ${g}`;
            });
            seal.replyToSender(ctx, msg, `本会话上下文覆盖：\n${lines.join('\n')}\n\n用【.ai ctxset window=20000】设置，【.ai ctxset clr】清除`);
            return ret;
        }

        // 清除
        if (sub === 'clr' || sub === 'clear' || sub === 'reset') {
            setting.overrides = {};
            session.save();
            seal.replyToSender(ctx, msg, '已清除本会话的上下文覆盖，恢复使用全局配置');
            return ret;
        }

        // key=value
        const eq = arg.indexOf('=');
        if (eq <= 0) {
            seal.replyToSender(ctx, msg, `参数格式应为 key=值，如【.ai ctxset window=20000】；可用的 key：${Object.keys(OVERRIDE_KEYS).join(' / ')}`);
            return ret;
        }
        const key = arg.slice(0, eq).trim().toLowerCase();
        const rawVal = arg.slice(eq + 1).trim();
        const def = (OVERRIDE_KEYS as any)[key];
        if (!def) {
            seal.replyToSender(ctx, msg, `未识别的参数 ${key}；可用的 key：${Object.keys(OVERRIDE_KEYS).join(' / ')}`);
            return ret;
        }
        if (rawVal === 'clr' || rawVal === 'clear' || rawVal === '') {
            delete setting.overrides[def.field];
            session.save();
            seal.replyToSender(ctx, msg, `已清除本会话「${def.label}」的覆盖（全局 ${def.global()}）`);
            return ret;
        }
        const n = parseInt(rawVal, 10);
        if (!Number.isFinite(n) || n < 0) {
            seal.replyToSender(ctx, msg, `${def.label}必须是不小于 0 的整数（0=清除覆盖）`);
            return ret;
        }
        if (n === 0) {
            // 0 不作为"关闭"手段：按会话设 0 语义会与全局"0=关闭/不限"混淆
            delete setting.overrides[def.field];
            session.save();
            seal.replyToSender(ctx, msg, `0 视为清除覆盖，本会话「${def.label}」已回到全局值 ${def.global()}`);
            return ret;
        }
        setting.overrides[def.field] = n;
        session.save();
        seal.replyToSender(ctx, msg, `本会话「${def.label}」已设为 ${n}（全局 ${def.global()}）`);
        return ret;
    }
}
